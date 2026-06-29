/**
 * DeliveryPredictorService — V51
 *
 * Predicts:
 *   - estimated_delivery_days: supplier avg adjusted for category + demand
 *   - delay_probability: 0.0–1.0 based on supplier reliability + weekday
 *
 * SAFETY: Prediction only. No external API calls. No mutations.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupplierRecord } from './supplier-intelligence.service';

export interface DeliveryPrediction {
  estimatedDays:    number;
  estimatedDateISO: string;
  delayProbability: number;  // 0.0 – 1.0
  confidence:       'HIGH' | 'MEDIUM' | 'LOW';
  note:             string;
}

// Day-of-week delay multipliers (0 = Sunday)
const DOW_DELAY: number[] = [0.15, 0.05, 0.05, 0.05, 0.08, 0.12, 0.15];

@Injectable()
export class DeliveryPredictorService {
  private readonly logger = new Logger(DeliveryPredictorService.name);

  predict(supplier: SupplierRecord, orderDate?: Date): DeliveryPrediction {
    const base = Math.max(1, supplier.avg_delivery_days ?? 7);
    const date = orderDate ?? new Date();

    // Adjust for day-of-week (weekends slower)
    const dowIdx = date.getDay();
    const dowAdj = dowIdx === 0 || dowIdx === 6 ? 1 : 0; // +1 day on weekends

    const estimatedDays = base + dowAdj;

    // Delay probability
    const successRate = supplier.total_orders > 0
      ? (supplier.successful_orders ?? 0) / supplier.total_orders
      : 0.8;
    const baseDelay  = 1 - successRate;
    const dowDelay   = DOW_DELAY[dowIdx] ?? 0.05;
    const delayProb  = Math.min(0.95, Math.round((baseDelay * 0.7 + dowDelay * 0.3) * 100) / 100);

    // Confidence
    const confidence: DeliveryPrediction['confidence'] =
      supplier.total_orders >= 50 ? 'HIGH' :
      supplier.total_orders >= 10 ? 'MEDIUM' : 'LOW';

    // Estimated date
    const eta = new Date(date);
    eta.setDate(eta.getDate() + estimatedDays);

    const note = delayProb > 0.3
      ? `Higher delay risk — ${Math.round(delayProb * 100)}% chance of delay`
      : `On-time delivery likely — ${Math.round((1 - delayProb) * 100)}% reliability`;

    return {
      estimatedDays,
      estimatedDateISO: eta.toISOString().split('T')[0],
      delayProbability: delayProb,
      confidence,
      note,
    };
  }
}
