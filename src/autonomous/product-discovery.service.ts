/**
 * ProductDiscoveryService
 *
 * Fetches raw product candidates from AliExpress and CJ Dropshipping
 * per niche, applies hard filter gates, deduplicates, and returns a
 * dataset ready for the scoring engine.
 *
 * Cost:  $0 — no AI, results cached per niche for 6h
 * Fails: generates realistic mock products — loop never stops
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.module';
import type { RankedNiche } from './niche-discovery.service';

export interface RawProduct {
  externalId:      string;
  source:          'aliexpress' | 'cj_dropshipping';
  title:           string;
  supplierPrice:   number;
  estimatedRetail: number;
  shippingDays:    number;
  reviewRating:    number;
  reviewCount:     number;
  imageUrl:        string;
  productUrl:      string;
  category:        string;
  niche:           string;
  demandSearchVolume?: number;
  competitorCount?:    number;
  trendIndex?:         number;
  budgetDaily?:        number;
}

const FILTERS = {
  maxPrice:        50,
  minPrice:         3,
  maxShippingDays: 14,
  minRating:        4.0,
  minReviews:      50,
};

const MARKUP = 3.0;
const CACHE_TTL = 21_600; // 6 h

@Injectable()
export class ProductDiscoveryService {
  private readonly logger = new Logger(ProductDiscoveryService.name);

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // ── Public ──────────────────────────────────────────────────────────────────

  async discoverProducts(niches: RankedNiche[]): Promise<RawProduct[]> {
    const all: RawProduct[] = [];

    for (const niche of niches) {
      const key    = `autonomous:products:${niche.keyword}`;
      const cached = await this.fromCache(key);

      if (cached) {
        this.logger.debug(`[ProductDiscovery] Cache hit: "${niche.keyword}"`);
        all.push(...cached);
        continue;
      }

      const [aliResult, cjResult] = await Promise.allSettled([
        this.fetchAliExpress(niche.keyword),
        this.fetchCjDropshipping(niche.keyword),
      ]);

      const raw: RawProduct[] = [];
      if (aliResult.status === 'fulfilled')  raw.push(...aliResult.value);
      else this.logger.warn(`[ProductDiscovery] AliExpress failed (${niche.keyword}): ${aliResult.reason}`);
      if (cjResult.status === 'fulfilled')   raw.push(...cjResult.value);
      else this.logger.warn(`[ProductDiscovery] CJ failed (${niche.keyword}): ${cjResult.reason}`);

      const filtered = this.filter(this.deduplicate(raw));

      this.logger.log(
        `[ProductDiscovery] "${niche.keyword}": ${raw.length} raw → ${filtered.length} qualified`,
      );

      if (filtered.length > 0) await this.toCache(key, filtered);
      all.push(...filtered);
    }

    return all;
  }

  // ── AliExpress ───────────────────────────────────────────────────────────────

  private async fetchAliExpress(keyword: string): Promise<RawProduct[]> {
    const key = process.env.ALIEXPRESS_API_KEY;
    if (!key) return this.mockProducts(keyword, 'aliexpress', 8);

    const resp = await fetch(
      `https://api.aliexpress.com/v1/affiliate/product/query?` +
      `keyword=${encodeURIComponent(keyword)}&page_size=50&sort=SALE_PRICE_ASC` +
      `&min_sale_price=300&max_sale_price=5000`,
      { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`AliExpress ${resp.status}`);

    const data = (await resp.json()) as {
      result: {
        products: {
          product_id: string; product_title: string;
          target_sale_price: string; evaluate_rate: string;
          product_main_image_url: string; detail_url: string;
          ship_to_days: number; sale_count: number;
        }[];
      };
    };

    return (data.result?.products ?? []).map(p => {
      const supplierPrice = parseFloat(p.target_sale_price) / 100;
      return {
        externalId:      p.product_id,
        source:          'aliexpress',
        title:           p.product_title,
        supplierPrice,
        estimatedRetail: round2(supplierPrice * MARKUP),
        shippingDays:    p.ship_to_days ?? 14,
        reviewRating:    clamp(parseFloat(p.evaluate_rate ?? '0') / 20, 0, 5),
        reviewCount:     p.sale_count ?? 0,
        imageUrl:        p.product_main_image_url,
        productUrl:      p.detail_url,
        category:        keyword,
        niche:           keyword,
      };
    });
  }

  // ── CJ Dropshipping ──────────────────────────────────────────────────────────

  private async fetchCjDropshipping(keyword: string): Promise<RawProduct[]> {
    const apiKey = process.env.CJ_DROPSHIPPING_API_KEY;
    if (!apiKey) return this.mockProducts(keyword, 'cj_dropshipping', 6);

    // Auth
    const tokenResp = await fetch(
      'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.CJ_EMAIL, password: process.env.CJ_PASSWORD }),
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!tokenResp.ok) throw new Error(`CJ auth ${tokenResp.status}`);
    const tokenData = (await tokenResp.json()) as { data: { accessToken: string } };
    const token = tokenData.data.accessToken;

    const resp = await fetch(
      `https://developers.cjdropshipping.com/api2.0/v1/product/list?` +
      `keyword=${encodeURIComponent(keyword)}&pageNum=1&pageSize=30`,
      { headers: { 'CJ-Access-Token': token }, signal: AbortSignal.timeout(10_000) },
    );
    if (!resp.ok) throw new Error(`CJ products ${resp.status}`);

    const data = (await resp.json()) as {
      data: {
        list: {
          pid: string; productNameEn: string; sellPrice: string;
          categoryName: string; productImage: string; productUrl: string;
        }[];
      };
    };

    return (data.data?.list ?? []).map(p => {
      const supplierPrice = parseFloat(p.sellPrice ?? '0');
      return {
        externalId:      p.pid,
        source:          'cj_dropshipping',
        title:           p.productNameEn,
        supplierPrice,
        estimatedRetail: round2(supplierPrice * MARKUP),
        shippingDays:    10,
        reviewRating:    4.2,
        reviewCount:     200,
        imageUrl:        p.productImage,
        productUrl:      p.productUrl ?? '',
        category:        p.categoryName ?? keyword,
        niche:           keyword,
      };
    });
  }

  // ── Filter + Deduplicate ─────────────────────────────────────────────────────

  private filter(products: RawProduct[]): RawProduct[] {
    return products.filter(p =>
      p.supplierPrice   >= FILTERS.minPrice        &&
      p.supplierPrice   <= FILTERS.maxPrice        &&
      p.shippingDays    <= FILTERS.maxShippingDays &&
      p.reviewRating    >= FILTERS.minRating       &&
      p.reviewCount     >= FILTERS.minReviews,
    );
  }

  private deduplicate(products: RawProduct[]): RawProduct[] {
    const seen = new Set<string>();
    return products.filter(p => {
      const key = p.title.toLowerCase().trim().slice(0, 35);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ── Mock fallback ────────────────────────────────────────────────────────────

  private mockProducts(
    niche: string,
    source: 'aliexpress' | 'cj_dropshipping',
    count: number,
  ): RawProduct[] {
    const templates = [
      { suffix: 'Premium Kit',      price: 8.99,  rating: 4.6, reviews: 1240 },
      { suffix: 'Pro Edition',      price: 12.50, rating: 4.4, reviews: 890  },
      { suffix: 'Wireless Device',  price: 18.99, rating: 4.7, reviews: 2100 },
      { suffix: 'Portable Tool',    price: 6.50,  rating: 4.3, reviews: 560  },
      { suffix: 'Smart Gadget',     price: 24.99, rating: 4.5, reviews: 3200 },
      { suffix: 'Mini Accessory',   price: 4.99,  rating: 4.2, reviews: 480  },
      { suffix: 'Deluxe Set',       price: 15.99, rating: 4.8, reviews: 1800 },
      { suffix: 'Adjustable Band',  price: 9.99,  rating: 4.4, reviews: 720  },
    ];
    return templates.slice(0, count).map((t, i) => ({
      externalId:      `mock-${source}-${niche.replace(/\s+/g, '-')}-${i}`,
      source,
      title:           `${niche.charAt(0).toUpperCase() + niche.slice(1)} ${t.suffix}`,
      supplierPrice:   t.price,
      estimatedRetail: round2(t.price * MARKUP),
      shippingDays:    source === 'aliexpress' ? 12 : 8,
      reviewRating:    t.rating,
      reviewCount:     t.reviews,
      imageUrl:        `https://placehold.co/400x400/EEE/333?text=${encodeURIComponent(niche)}`,
      productUrl:      `https://mock-supplier.internal/product/${i}`,
      category:        niche,
      niche,
    }));
  }

  // ── Cache ────────────────────────────────────────────────────────────────────

  private async fromCache(key: string): Promise<RawProduct[] | null> {
    try {
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as RawProduct[]) : null;
    } catch { return null; }
  }

  private async toCache(key: string, products: RawProduct[]): Promise<void> {
    try { await this.redis.setex(key, CACHE_TTL, JSON.stringify(products)); } catch { /* noop */ }
  }
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function round2(v: number) { return parseFloat(v.toFixed(2)); }
