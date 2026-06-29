import SwaggerParser from '@apidevtools/swagger-parser';
import { createOpenApiContractContext, getOperations } from './openapi-contract.harness';

describe('OpenAPI schema generation', () => {
  it('generates and validates the complete OpenAPI 3 contract', async () => {
    const context = await createOpenApiContractContext(true);
    try {
      await SwaggerParser.validate(context.document as never);
      expect(context.document.openapi).toMatch(/^3\./);
      const operationIds = new Set(
        getOperations(context.document).map((operation) => operation.operationId),
      );
      const shadowed =
        (
          context.document as typeof context.document & {
            'x-aiempire-shadowed-operations'?: string[];
          }
        )['x-aiempire-shadowed-operations'] ?? [];
      const auditedOperationIds = new Set([...operationIds, ...shadowed]);
      expect([...context.endpoints.keys()].filter((id) => !auditedOperationIds.has(id))).toEqual(
        [],
      );
      expect(auditedOperationIds.size).toBe(context.endpoints.size);
    } finally {
      await context.app.close();
    }
  });
});
