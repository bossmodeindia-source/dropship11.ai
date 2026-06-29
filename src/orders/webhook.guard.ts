import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Request } from 'express';

@Injectable()
export class WebhookGuard implements CanActivate {
  private readonly logger = new Logger(WebhookGuard.name);
  private readonly secret: string;

  constructor(private readonly config: ConfigService) {
    this.secret = config.getOrThrow<string>('WEBHOOK_HMAC_SECRET');
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { rawBody?: Buffer; webhookUserId?: string }>();
    const platform = ((req.headers['x-platform'] as string) ?? 'shopify').toLowerCase();
    return platform === 'shopify' ? this.validateShopify(req) : this.validateGeneric(req);
  }

  private validateShopify(req: Request & { rawBody?: Buffer; webhookUserId?: string }): boolean {
    const headerSig = req.headers['x-shopify-hmac-sha256'] as string | undefined;
    if (!headerSig) throw new UnauthorizedException('Missing X-Shopify-Hmac-Sha256 header');

    const rawBody = req.rawBody;
    if (!rawBody) throw new UnauthorizedException('Cannot verify webhook — raw body unavailable');

    const expected = createHmac('sha256', this.secret).update(rawBody).digest('base64');
    if (!this.safeCompare(expected, headerSig)) {
      this.logger.warn(`Invalid Shopify HMAC from ${req.ip ?? 'unknown'}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    req.webhookUserId = req.headers['x-shop-user-id'] as string | undefined;
    return true;
  }

  private validateGeneric(req: Request & { rawBody?: Buffer; webhookUserId?: string }): boolean {
    const headerSig = req.headers['x-dropship-signature'] as string | undefined;
    if (!headerSig) throw new UnauthorizedException('Missing X-Dropship-Signature header');

    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body));
    const expected = `sha256=${createHmac('sha256', this.secret).update(rawBody).digest('hex')}`;

    if (!this.safeCompare(expected, headerSig)) {
      this.logger.warn(`Invalid generic HMAC from ${req.ip ?? 'unknown'}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    req.webhookUserId = req.headers['x-user-id'] as string | undefined;
    return true;
  }

  private safeCompare(a: string, b: string): boolean {
    try {
      const bufA = Buffer.from(a);
      const bufB = Buffer.from(b);
      return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
    } catch { return false; }
  }
}
