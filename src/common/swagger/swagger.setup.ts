import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Dropship SaaS API')
    .setDescription(
      'AI-powered dropshipping automation platform. ' +
      'Authenticate via Bearer token (obtain from POST /auth/login).',
    )
    .setVersion('1.0.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', in: 'header' },
      'access-token',
    )
    .addTag('auth',      'Authentication — register, login, refresh, logout')
    .addTag('products',  'Product management and AI/BOT scoring engine')
    .addTag('orders',    'Webhook ingestion and order lifecycle')
    .addTag('campaign',  'AI/BOT campaign generation')
    .addTag('admin',     'Admin user management (requires admin role)')
    .addTag('metrics',   'Prometheus metrics endpoint')
    .addTag('health',    'Health check')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
    customSiteTitle: 'Dropship SaaS — API Docs',
  });
}
