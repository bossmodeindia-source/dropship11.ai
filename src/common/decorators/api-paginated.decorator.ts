import { applyDecorators } from '@nestjs/common';
import { ApiQuery, ApiOkResponse } from '@nestjs/swagger';

export function ApiPaginatedQuery(): MethodDecorator {
  return applyDecorators(
    ApiQuery({ name: 'page',  required: false, type: Number, example: 1,  description: 'Page number (1-based)' }),
    ApiQuery({ name: 'limit', required: false, type: Number, example: 20, description: 'Items per page (max 100)' }),
  );
}
