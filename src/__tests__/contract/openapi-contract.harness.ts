import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, MetadataScanner } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import {
  OperationObject,
  ReferenceObject,
  ResponseObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SKIP_TENANT_GUARD } from '../../tenant/tenant.guard';
import { createTestApp, TestAppContext } from '../../test-utils/test-app-factory';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

export interface EndpointMetadata {
  operationId: string;
  isPublic: boolean;
  skipsTenant: boolean;
  requestMethod: RequestMethod;
}

export interface OpenApiContractContext extends TestAppContext {
  document: OpenAPIObject;
  endpoints: Map<string, EndpointMetadata>;
}

function buildConfig() {
  return new DocumentBuilder()
    .setTitle('AI Empire API')
    .setDescription('Certified contract for the AI Empire autonomous commerce backend.')
    .setVersion('69.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Tenant-ID' }, 'tenant-id')
    .build();
}

function controllerEndpointMetadata(app: INestApplication): Map<string, EndpointMetadata> {
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const endpoints = new Map<string, EndpointMetadata>();

  for (const moduleRef of modules.values()) {
    for (const wrapper of moduleRef.controllers.values()) {
      const controller = wrapper.metatype;
      if (!controller?.prototype) continue;

      const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
      const classSkipsTenant = Reflect.getMetadata(SKIP_TENANT_GUARD, controller) === true;

      for (const methodName of scanner.getAllMethodNames(controller.prototype)) {
        const handler = controller.prototype[methodName];
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
          | RequestMethod
          | undefined;
        if (requestMethod === undefined) continue;

        const operationId = `${controller.name}.${methodName}`;
        endpoints.set(operationId, {
          operationId,
          isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true || classPublic,
          skipsTenant: Reflect.getMetadata(SKIP_TENANT_GUARD, handler) === true || classSkipsTenant,
          requestMethod,
        });
      }
    }
  }

  return endpoints;
}

function operations(document: OpenAPIObject): OperationObject[] {
  const result: OperationObject[] = [];
  for (const pathItem of Object.values(document.paths)) {
    if (!pathItem) continue;
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OperationObject | undefined;
      if (operation) result.push(operation);
    }
  }
  return result;
}

function enrichDocument(
  document: OpenAPIObject,
  endpoints: Map<string, EndpointMetadata>,
): OpenAPIObject {
  document.openapi = '3.0.3';
  document.servers = [{ url: '/api/v1', description: 'Version 1 API' }];
  document.components ??= {};
  document.components.schemas ??= {};
  document.components.schemas.ApiError = {
    type: 'object',
    additionalProperties: true,
    required: ['statusCode', 'message', 'path', 'timestamp'],
    properties: {
      success: { type: 'boolean', enum: [false] },
      statusCode: { type: 'integer', minimum: 400, maximum: 599 },
      message: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
          { type: 'object', additionalProperties: true },
        ],
      },
      path: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      requestId: { type: 'string', nullable: true },
      error: { type: 'string' },
    },
  };
  document.components.schemas.ApiSuccess = {
    type: 'object',
    additionalProperties: true,
  };

  for (const operation of operations(document)) {
    const metadata = endpoints.get(operation.operationId ?? '');
    if (!metadata) continue;

    operation.security = metadata.isPublic
      ? []
      : metadata.skipsTenant
        ? [{ 'access-token': [] }]
        : [{ 'access-token': [], 'tenant-id': [] }];

    const mutation = [RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH].includes(
      metadata.requestMethod,
    );
    if (mutation && !operation.requestBody) {
      operation.requestBody = {
        required: false,
        content: {
          'application/json': { schema: { type: 'object', additionalProperties: true } },
        },
      };
    }

    for (const [status, rawResponse] of Object.entries(operation.responses ?? {})) {
      const response = rawResponse as ResponseObject | ReferenceObject;
      if (status === '204' || '$ref' in response) continue;
      response.content ??= {
        'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } },
      };
    }

    operation.responses ??= {};
    operation.responses['400'] ??= {
      description: 'Invalid request',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
    if (!metadata.isPublic) {
      operation.responses['401'] ??= {
        description: 'Authentication or tenant context missing',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      };
      operation.responses['403'] ??= {
        description: 'Authenticated principal lacks permission',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
      };
    }
    operation.responses['500'] ??= {
      description: 'Internal server error',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
    };
  }

  return document;
}

export async function createOpenApiContractContext(
  writeSchema = false,
): Promise<OpenApiContractContext> {
  let document: OpenAPIObject | undefined;
  let endpoints = new Map<string, EndpointMetadata>();

  const context = await createTestApp({
    useDefaultValidationPipe: false,
    beforeInit: async (app) => {
      app.setGlobalPrefix('api/v1', { exclude: ['health', 'metrics'] });
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          transform: true,
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

      endpoints = controllerEndpointMetadata(app);
      document = SwaggerModule.createDocument(app, buildConfig(), {
        operationIdFactory: (controllerKey, methodKey) => `${controllerKey}.${methodKey}`,
      });
      enrichDocument(document, endpoints);
      const documentedOperationIds = new Set(
        operations(document).map((operation) => operation.operationId),
      );
      const shadowedOperations = [...endpoints.keys()].filter(
        (operationId) => !documentedOperationIds.has(operationId),
      );
      (document as OpenAPIObject & { 'x-aiempire-shadowed-operations'?: string[] })[
        'x-aiempire-shadowed-operations'
      ] = shadowedOperations;
    },
  });

  if (!document) throw new Error('OpenAPI document was not generated');

  if (writeSchema) {
    const outputDirectory = resolve(process.cwd(), 'openapi');
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(
      resolve(outputDirectory, 'openapi.json'),
      `${JSON.stringify(document, null, 2)}\n`,
    );
  }

  return { ...context, document, endpoints };
}

export function getOperations(document: OpenAPIObject): OperationObject[] {
  return operations(document);
}
