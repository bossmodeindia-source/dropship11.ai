import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ShopifyService, ShopifyOrdersFilter } from './shopify.service';
import { ShopifyApiKeysService } from './shopify-api-keys.service';
import { CreateShopifyProductDto, UpdateShopifyProductDto } from './dto/shopify-product.dto';
import { SaveShopifyApiKeyDto } from './dto/save-api-key.dto';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';

@Controller('shopify')
export class ShopifyController {
  constructor(
    private readonly shopifyService: ShopifyService,
    private readonly apiKeys: ShopifyApiKeysService,
  ) {}

  // ── Credentials ─────────────────────────────────────────────────────────

  @Put('credentials')
  @HttpCode(HttpStatus.OK)
  saveCredentials(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SaveShopifyApiKeyDto,
  ) {
    return this.apiKeys.save(user.sub, dto);
  }

  @Get('credentials')
  getCredentials(@CurrentUser() user: JwtPayload) {
    return this.apiKeys.get(user.sub);
  }

  @Delete('credentials')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCredentials(@CurrentUser() user: JwtPayload): Promise<void> {
    return this.apiKeys.delete(user.sub);
  }

  // ── Products ─────────────────────────────────────────────────────────────

  @Post('products')
  async createProduct(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateShopifyProductDto,
  ) {
    const creds = await this.apiKeys.getForUser(user.sub);
    return this.shopifyService.createProduct(creds, dto);
  }

  @Put('products/:shopifyProductId')
  async updateProduct(
    @CurrentUser() user: JwtPayload,
    @Param('shopifyProductId') shopifyProductId: string,
    @Body() dto: UpdateShopifyProductDto,
  ) {
    const creds = await this.apiKeys.getForUser(user.sub);
    return this.shopifyService.updateProduct(creds, shopifyProductId, dto);
  }

  // ── Orders ────────────────────────────────────────────────────────────────

  @Get('orders')
  async getOrders(
    @CurrentUser() user: JwtPayload,
    @Query('status')              status?: ShopifyOrdersFilter['status'],
    @Query('limit')               limit?: string,
    @Query('financial_status')    financialStatus?: string,
    @Query('fulfillment_status')  fulfillmentStatus?: string,
    @Query('created_at_min')      createdAtMin?: string,
    @Query('created_at_max')      createdAtMax?: string,
  ) {
    const creds = await this.apiKeys.getForUser(user.sub);
    return this.shopifyService.getOrders(creds, {
      status:               status ?? 'open',
      limit:                limit ? parseInt(limit, 10) : 50,
      financial_status:     financialStatus,
      fulfillment_status:   fulfillmentStatus,
      created_at_min:       createdAtMin,
      created_at_max:       createdAtMax,
    });
  }

  // ── Webhook registration ──────────────────────────────────────────────────

  @Post('webhooks/register')
  @HttpCode(HttpStatus.OK)
  async registerWebhook(
    @CurrentUser() user: JwtPayload,
    @Body('callbackBaseUrl') callbackBaseUrl: string,
  ) {
    const creds = await this.apiKeys.getForUser(user.sub);
    const orderWebhookUrl = `${callbackBaseUrl}/webhooks/shopify/order`;

    await this.shopifyService.registerWebhook(creds, 'orders/create', orderWebhookUrl);
    await this.shopifyService.registerWebhook(creds, 'orders/paid',   orderWebhookUrl);

    return {
      registered: ['orders/create', 'orders/paid'],
      callbackUrl: orderWebhookUrl,
    };
  }
}
