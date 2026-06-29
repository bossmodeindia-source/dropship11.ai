/**
 * ProductsController (V2 — Async AI Endpoints)
 *
 * New endpoints added:
 *   POST /products/:id/listing   → enqueues listing:generate → returns { jobId, estimatedMs }
 *   POST /products/:id/hooks     → enqueues hooks:generate   → returns { jobId, estimatedMs }
 *
 * Updated endpoints:
 *   POST /products/:id/score     → now returns { product, mediaJobId } (V2 non-blocking)
 *
 * All AI operations return HTTP 202 Accepted with a jobId.
 * Clients poll GET /ai/jobs/:jobId for results.
 */

import {
  Controller, Get, Post, Delete, Param, Body, Query,
  ParseIntPipe, DefaultValuePipe, HttpCode, HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CurrentUser, JwtPayload } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CreateProductDto } from './dto/create-product.dto';
import { ScoreProductDto } from './dto/score-product.dto';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private products: ProductsService) {}

  // ── CRUD ──────────────────────────────────────────────────────────────────

  @Post()
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateProductDto) {
    return this.products.createProduct(user.sub, dto);
  }

  @Get()
  list(
    @CurrentUser() user: JwtPayload,
    @Query('page',  new DefaultValuePipe(1),  ParseIntPipe) page:  number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.products.listProducts(user.sub, page, Math.min(limit, 100));
  }

  @Get(':id')
  getOne(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.products.getProduct(user.sub, id);
  }

  // ── Scoring ───────────────────────────────────────────────────────────────

  /**
   * POST /products/:id/score
   *
   * V2: returns { product, mediaJobId }
   * mediaJobId is non-null when decision=RUN_ADS and job was enqueued.
   * Poll GET /ai/jobs/:mediaJobId for the AI-generated media prompts.
   */
  @Post(':id/score')
  @HttpCode(HttpStatus.OK)
  score(
    @CurrentUser() user: JwtPayload,
    @Param('id')   id:   string,
    @Body()        dto:  ScoreProductDto,
  ) {
    return this.products.scoreAndDecide(user.sub, id, dto);
  }

  // ── Async AI Endpoints (V2) ───────────────────────────────────────────────

  /**
   * POST /products/:id/listing
   *
   * Enqueues a listing:generate job. Returns immediately (HTTP 202).
   * Response: { jobId: string, estimatedMs: number }
   *
   * Poll GET /ai/jobs/:jobId for:
   *   { title: "...", description: "...", tags: ["..."] }
   */
  @Post(':id/listing')
  @HttpCode(HttpStatus.ACCEPTED)
  generateListing(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const tier = user.subscriptionTier as 'free' | 'starter' | 'pro' | 'enterprise' | undefined;
    return this.products.generateListing(user.sub, id, tier);
  }

  /**
   * POST /products/:id/hooks
   *
   * Enqueues a hooks:generate job. Returns immediately (HTTP 202).
   * Response: { jobId: string, estimatedMs: number }
   *
   * Poll GET /ai/jobs/:jobId for:
   *   { hooks: ["...", "...", "...", "...", "..."] }
   */
  @Post(':id/hooks')
  @HttpCode(HttpStatus.ACCEPTED)
  generateHooks(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    const tier = user.subscriptionTier as 'free' | 'starter' | 'pro' | 'enterprise' | undefined;
    return this.products.generateHooks(user.sub, id, tier);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.products.deleteProduct(user.sub, id);
  }
}
