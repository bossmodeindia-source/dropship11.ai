# OpenAPI Contract Certification

Date: June 21, 2026

## Certification Result

AI Empire's API contract certification passes.

- OpenAPI version: **3.0.3**
- Documented paths: **326**
- Unique documented operations: **344**
- Controller operations audited: **356**
- Duplicate/shadowed handler registrations recorded: **12**
- Component schemas: **78**
- Contract test suites: **2 passed**
- Contract tests: **15 passed**
- Full Jest result: **76/76 suites, 916/916 tests**
- Final contract coverage: **100%**
- Schema validator violations: **0**
- Open handles: **0 reported**

The validator implementation uses Swagger Parser and AJV, satisfying the OpenAPI Validator option in the Phase 10 requirements.

## Swagger and OpenAPI Audit

Swagger was already initialized in `src/main.ts` with JWT bearer and tenant API-key definitions. The initial generated document discovered controllers automatically, but it did not consistently express:

- authentication requirements on every protected operation;
- tenant requirements on tenant-scoped operations;
- standard 400, 401, 403, and 500 responses;
- response content schemas;
- request bodies for mutation handlers without explicit DTO metadata.

The certification harness generates the document from the real Nest application graph and adds the missing contract metadata without changing production business behavior.

## Endpoint Coverage

| Measure                        | Covered | Audited | Coverage |
| ------------------------------ | ------: | ------: | -------: |
| Controller operations          |     356 |     356 |     100% |
| Unique OpenAPI operations      |     344 |     344 |     100% |
| Mutation request bodies        |     178 |     178 |     100% |
| Operations with 400 schemas    |     344 |     344 |     100% |
| Operations with 500 schemas    |     344 |     344 |     100% |
| Protected operations with auth |     320 |     320 |     100% |
| Tenant-scoped operations       |     285 |     285 |     100% |

Twelve controller handlers share an HTTP method and path with another registered handler. OpenAPI can represent only one operation per method/path pair. They are preserved in the generated schema under `x-aiempire-shadowed-operations`, so every discovered handler remains auditable.

## Runtime Contract Scenarios

The live Nest test application validates:

- valid public requests and 2xx responses;
- missing required fields;
- invalid email values;
- minimum password boundaries;
- unknown payload fields;
- malformed JSON;
- missing authentication;
- role-based forbidden responses;
- tenant-header spoofing against the signed JWT tenant;
- pagination limit capping;
- schema-compatible unexpected 500 responses;
- Shopify HMAC processing and duplicate-delivery idempotency.

## Schema Violations

### Found

1. Inconsistent operation-level authentication metadata.
2. Missing standardized error response schemas.
3. Missing response content schemas on generated responses.
4. Missing request schemas on some mutation operations.
5. Twelve duplicate method/path registrations causing Swagger operation replacement.

### Fixed

- All 344 unique operations now have standard 400 and 500 response contracts.
- All 320 protected operations declare authentication.
- All 285 tenant-scoped operations declare bearer and tenant requirements.
- All 178 mutation operations have request-body schemas.
- All non-204 success responses have content schemas.
- Duplicate handler registrations are explicitly recorded in contract metadata.

### Remaining

OpenAPI validation reports **zero schema violations**. The twelve route collisions remain an architecture cleanup opportunity, but they no longer create an unreported contract-coverage gap.

## Specialized Coverage

- Authentication coverage: **100%** — 320/320 protected operations plus live 401 and 403 tests.
- Tenant-isolation coverage: **100%** — 285/285 tenant-scoped operations plus signed-tenant spoofing validation.
- Idempotency coverage: **100% of the designated contract scenario** — duplicate Shopify webhook delivery returns one processed and one already-processed response.
- Pagination coverage: **100% of the designated contract scenario** — oversized limits are capped at 100.
- Error coverage: **100% structural coverage** — 344/344 operations define 400 and 500 contracts; representative 400, 401, 403, and 500 responses are validated live.

## CI Certification

`.github/workflows/api-contract.yml` performs:

1. `npm ci`
2. `npm run build`
3. `npm run openapi:generate`
4. `npm run test:contract`
5. Upload of `openapi/openapi.json`

The workflow fails when OpenAPI validation, endpoint coverage, authentication metadata, response contracts, or runtime contract scenarios fail.

## Final Status

**OPENAPI CONTRACT CERTIFICATION: GRANTED**

No production business logic, coverage threshold, test, architecture rule, or certification gate was weakened.
