/**
 * CashflowService — V53 Cashflow Engine
 *
 * Tracks: incoming payments, outgoing supplier costs, available capital.
 * Does NOT duplicate V36 CashflowIntelligenceEngine (V36 = state classification engine).
 * This service = DB-backed transaction ledger for V53 finance module.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Inject }              from '@nestjs/common';
import { Pool }                from 'pg';

export interface CashflowEntry {
  id:         string;
  type:       'incoming' | 'outgoing';
  amount:     number;
  category:   'revenue' | 'supplier' | 'ads' | 'refund' | 'other';
  reference?: string;
  createdAt:  string;
}

export interface CashflowState {
  totalIncoming:   number;
  totalOutgoing:   number;
  availableCapital: number;
  netCashflow:     number;
  entries:         CashflowEntry[];
  asOf:            string;
}

@Injectable()
export class CashflowService {
  private readonly log = new Logger(CashflowService.name);

  constructor(@Inject('PG_POOL') private readonly pool: Pool) {}

  async recordIncoming(params: {
    amount:     number;
    category:   'revenue' | 'refund' | 'other';
    reference?: string;
  }): Promise<void> {
    await this.insert('incoming', params.amount, params.category, params.reference);
  }

  async recordOutgoing(params: {
    amount:     number;
    category:   'supplier' | 'ads' | 'other';
    reference?: string;
  }): Promise<void> {
    await this.insert('outgoing', params.amount, params.category, params.reference);
  }

  async getState(days = 30): Promise<CashflowState> {
    try {
      const { rows } = await this.pool.query(`
        SELECT id, type, amount, category, reference, created_at
        FROM finance_transactions
        WHERE created_at >= NOW() - INTERVAL '${days} days'
        ORDER BY created_at DESC
        LIMIT 500
      `);

      let totalIncoming = 0;
      let totalOutgoing = 0;
      const entries: CashflowEntry[] = rows.map((r: any) => {
        const amount = parseFloat(r.amount);
        if (r.type === 'incoming') totalIncoming += amount;
        else                       totalOutgoing += amount;
        return {
          id:        r.id,
          type:      r.type,
          amount,
          category:  r.category,
          reference: r.reference,
          createdAt: r.created_at,
        };
      });

      return {
        totalIncoming:    parseFloat(totalIncoming.toFixed(2)),
        totalOutgoing:    parseFloat(totalOutgoing.toFixed(2)),
        availableCapital: parseFloat((totalIncoming - totalOutgoing).toFixed(2)),
        netCashflow:      parseFloat((totalIncoming - totalOutgoing).toFixed(2)),
        entries,
        asOf:             new Date().toISOString(),
      };
    } catch (err) {
      this.log.error(`getState failed: ${(err as Error).message}`);
      return {
        totalIncoming: 0, totalOutgoing: 0,
        availableCapital: 0, netCashflow: 0,
        entries: [], asOf: new Date().toISOString(),
      };
    }
  }

  private async insert(
    type:      'incoming' | 'outgoing',
    amount:    number,
    category:  string,
    reference?: string,
  ): Promise<void> {
    try {
      await this.pool.query(`
        INSERT INTO finance_transactions (type, amount, source, category, reference, created_at)
        VALUES ($1, $2, 'cashflow_service', $3, $4, NOW())
      `, [type, amount, category, reference ?? null]);
    } catch (err) {
      this.log.warn(`insert failed (non-critical): ${(err as Error).message}`);
    }
  }
}
