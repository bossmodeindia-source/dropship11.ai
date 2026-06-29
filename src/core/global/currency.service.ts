/**
 * CurrencyService — V55 Multi-Currency Engine
 *
 * Features:
 *   - Convert INR ↔ USD ↔ EUR (and any supported pair)
 *   - Store exchange rates (in-memory, refreshed periodically)
 *   - Rates updated every 60 minutes from static fallback
 *     (production: extend updateRates() to call live FX API)
 *
 * READ-ONLY financial utility. No execution. No Meta API calls.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

export type CurrencyCode = 'INR' | 'USD' | 'EUR' | 'GBP' | 'AED' | 'AUD' | 'CAD' | 'SGD';

// Rates relative to USD (1 USD = X local)
const STATIC_RATES: Record<CurrencyCode, number> = {
  USD: 1.00,
  INR: 83.50,
  EUR: 0.92,
  GBP: 0.79,
  AED: 3.67,
  AUD: 1.53,
  CAD: 1.36,
  SGD: 1.34,
};

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class CurrencyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CurrencyService.name);
  private rates: Record<string, number> = { ...STATIC_RATES };
  private lastUpdated: Date = new Date();
  private refreshTimer?: ReturnType<typeof setInterval>;

  onModuleInit(): void {
    this.scheduleRefresh();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  // ── Public ─────────────────────────────────────────────────────────────────

  convert(amount: number, from: CurrencyCode, to: CurrencyCode): number {
    if (from === to) return amount;
    const inUsd      = amount / (this.rates[from] ?? 1);
    const converted  = inUsd * (this.rates[to] ?? 1);
    return Math.round(converted * 100) / 100;
  }

  toINR(amount: number, from: CurrencyCode): number {
    return this.convert(amount, from, 'INR');
  }

  toUSD(amount: number, from: CurrencyCode): number {
    return this.convert(amount, from, 'USD');
  }

  getRate(from: CurrencyCode, to: CurrencyCode): number {
    const inUsd = 1 / (this.rates[from] ?? 1);
    return inUsd * (this.rates[to] ?? 1);
  }

  getAllRates(): Record<string, number> {
    return { ...this.rates };
  }

  getLastUpdated(): string {
    return this.lastUpdated.toISOString();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private scheduleRefresh(): void {
    this.refreshTimer = setInterval(() => this.updateRates(), REFRESH_INTERVAL_MS);
  }

  private updateRates(): void {
    // Production: replace with live FX API call (e.g. exchangerate-api.com)
    // For now: keep static rates stable
    this.lastUpdated = new Date();
    this.logger.debug('CurrencyService: rates refreshed (static fallback)');
  }
}
