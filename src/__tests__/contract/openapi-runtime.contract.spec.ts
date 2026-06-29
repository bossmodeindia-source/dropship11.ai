import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createHmac } from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as request from 'supertest';
import { OpenAPIObject } from '@nestjs/swagger';
import {
  OperationObject,
  ReferenceObject,
  ResponseObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import {
  createOpenApiContractContext,
  getOperations,
  OpenApiContractContext,
} from './openapi-contract.harness';

const JSON_METHODS = ['post', 'put', 'patch'];

describe('AI Empire OpenAPI runtime contracts', () => {
  let context: OpenApiContractContext;
  let validateError: ReturnType<Ajv['compile']>;

  beforeAll(async () => {
    context = await createOpenApiContractContext();
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    validateError = ajv.compile(context.document.components?.schemas?.ApiError as object);
  });

  afterAll(async () => {
    await context?.app.close();
  });

  function expectContractError(body: unknown, status: number): void {
    expect(validateError(body)).toBe(true);
    expect(body).toEqual(expect.objectContaining({ statusCode: status }));
  }

  function authenticatedToken(tenantId = 'tenant-contract-a', role = 'user'): string {
    return jwt.sign(
      {
        sub: 'user-contract-1',
        email: 'contract@example.com',
        tenant_id: tenantId,
        plan: 'free',
        role,
        jti: `contract-${role}`,
      },
      process.env.JWT_SECRET!,
      { expiresIn: '15m' },
    );
  }

  function activateTenant(tenantId: string): void {
    context.redis.store.set(`tenant:active:${tenantId}`, '1');
  }

  it('documents request, response, auth, and standard error contracts for every operation', () => {
    const operations = getOperations(context.document);
    expect(operations.length).toBeGreaterThan(300);

    for (const operation of operations) {
      const metadata = context.endpoints.get(operation.operationId!);
      expect(metadata).toBeDefined();
      expect(operation.responses?.['400']).toBeDefined();
      expect(operation.responses?.['500']).toBeDefined();

      const successResponses = Object.entries(operation.responses ?? {}).filter(([status]) =>
        /^2\d\d$/.test(status),
      );
      expect(successResponses.length).toBeGreaterThan(0);
      for (const [status, rawResponse] of successResponses) {
        const response = rawResponse as ResponseObject | ReferenceObject;
        if (status !== '204' && !('$ref' in response)) {
          expect(response.content?.['application/json']?.schema).toBeDefined();
        }
      }

      if (metadata && !metadata.isPublic) {
        expect(operation.security).toEqual(
          metadata.skipsTenant
            ? [{ 'access-token': [] }]
            : [{ 'access-token': [], 'tenant-id': [] }],
        );
        expect(operation.responses?.['401']).toBeDefined();
        expect(operation.responses?.['403']).toBeDefined();
      } else {
        expect(operation.security).toEqual([]);
      }
    }

    for (const [path, pathItem] of Object.entries(context.document.paths)) {
      for (const method of JSON_METHODS) {
        const operation = pathItem?.[method as keyof typeof pathItem] as
          | OperationObject
          | undefined;
        if (!operation) continue;
        expect(operation.requestBody).toBeDefined();
        expect(path).toBeTruthy();
      }
    }
  });

  it('accepts a valid public request and returns the documented 2xx shape', async () => {
    const response = await request(context.app.getHttpServer()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ status: 'ok' }));
  });

  it.each([
    ['missing fields', {}],
    ['invalid email', { email: 'not-an-email', password: 'Password1!' }],
    ['password below boundary', { email: 'user@example.com', password: 'Aa1!' }],
    ['unknown field', { email: 'user@example.com', password: 'Password1!', unexpected: true }],
  ])('rejects invalid registration payloads: %s', async (_case, payload) => {
    const response = await request(context.app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(payload);
    expect(response.status).toBe(400);
    expectContractError(response.body, 400);
  });

  it('rejects malformed JSON with a schema-compatible 400 response', async () => {
    const response = await request(context.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":"broken@example.com",');
    expect(response.status).toBe(400);
    expectContractError(response.body, 400);
  });

  it('enforces authentication on protected endpoints', async () => {
    const response = await request(context.app.getHttpServer()).get('/api/v1/orders');
    expect(response.status).toBe(401);
    expectContractError(response.body, 401);
  });

  it('enforces role-based forbidden responses', async () => {
    const tenantId = 'tenant-contract-rbac';
    activateTenant(tenantId);
    const response = await request(context.app.getHttpServer())
      .get('/api/v1/admin/status')
      .set('Authorization', `Bearer ${authenticatedToken(tenantId, 'user')}`);
    expect(response.status).toBe(403);
    expectContractError(response.body, 403);
  });

  it('binds tenant isolation to the signed token rather than a spoofed tenant header', async () => {
    const signedTenant = 'tenant-contract-a';
    const spoofedTenant = 'tenant-contract-b';
    activateTenant(signedTenant);

    const response = await request(context.app.getHttpServer())
      .get('/api/v1/orders?page=1&limit=20')
      .set('Authorization', `Bearer ${authenticatedToken(signedTenant)}`)
      .set('X-Tenant-ID', spoofedTenant);

    expect(response.status).toBe(200);
    expect(context.redis.get).toHaveBeenCalledWith(`tenant:active:${signedTenant}`);
    expect(context.redis.get).not.toHaveBeenCalledWith(`tenant:active:${spoofedTenant}`);
  });

  it('enforces pagination boundaries by capping order page size at 100', async () => {
    const tenantId = 'tenant-contract-pagination';
    activateTenant(tenantId);
    const response = await request(context.app.getHttpServer())
      .get('/api/v1/orders?page=1&limit=1000')
      .set('Authorization', `Bearer ${authenticatedToken(tenantId)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({ page: 1, limit: 100 }));
  });

  it('returns a schema-compatible 500 response for an unexpected service failure', async () => {
    const tenantId = 'tenant-contract-500';
    activateTenant(tenantId);
    context.db.query.orders.findMany.mockRejectedValueOnce(new Error('contract-induced failure'));

    const response = await request(context.app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', `Bearer ${authenticatedToken(tenantId)}`);

    expect(response.status).toBe(500);
    expectContractError(response.body, 500);
  });

  it('preserves Shopify webhook idempotency for duplicate deliveries', async () => {
    const secret = process.env.SHOPIFY_WEBHOOK_SECRET!;
    const payload = {
      id: 'contract-order-1',
      financial_status: 'paid',
      total_price: '99.00',
      currency: 'USD',
      line_items: [],
    };
    const raw = JSON.stringify(payload);
    const hmac = createHmac('sha256', secret).update(raw).digest('base64');
    const headers = {
      'Content-Type': 'application/json',
      'x-shopify-hmac-sha256': hmac,
      'x-shopify-shop-domain': 'contract-shop.myshopify.com',
      'x-shopify-order-id': 'contract-order-1',
      'x-shopify-hmac-timestamp': String(Math.floor(Date.now() / 1000)),
    };

    const first = await request(context.app.getHttpServer())
      .post('/api/v1/webhooks/shopify/orders/paid')
      .set(headers)
      .send(raw);
    const second = await request(context.app.getHttpServer())
      .post('/api/v1/webhooks/shopify/orders/paid')
      .set(headers)
      .send(raw);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect([first.body.status, second.body.status]).toEqual(
      expect.arrayContaining(['processed', 'already_processed']),
    );
  });

  it('exposes a valid OpenAPI 3 document object', () => {
    const document: OpenAPIObject = context.document;
    expect(document.openapi).toBe('3.0.3');
    expect(Object.keys(document.paths).length).toBeGreaterThan(250);
  });
});
