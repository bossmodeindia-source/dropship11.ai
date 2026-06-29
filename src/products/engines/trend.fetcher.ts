import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Injectable()
export class TrendFetcher {
  private readonly logger = new Logger(TrendFetcher.name);

  constructor(private config: ConfigService) {}

  /**
   * Returns a trend index 0–100 for a product keyword.
   * Falls back to a deterministic mock if the external API is unavailable.
   */
  async fetchTrendIndex(keyword: string): Promise<number> {
    try {
      const baseUrl = this.config.get<string>('TREND_API_URL');
      if (!baseUrl) return this.mockTrend(keyword);

      const { data } = await axios.get<{ trend_index: number }>(
        `${baseUrl}/trend`,
        {
          params: { keyword },
          timeout: 3000,
          headers: { 'X-Api-Key': this.config.get('TREND_API_KEY') },
        },
      );
      return Math.min(100, Math.max(0, data.trend_index));
    } catch (err) {
      this.logger.warn(`Trend API unavailable for "${keyword}", using mock`);
      return this.mockTrend(keyword);
    }
  }

  private mockTrend(keyword: string): number {
    // Deterministic hash so same product always gets same mock score
    let hash = 0;
    for (let i = 0; i < keyword.length; i++) {
      hash = ((hash << 5) - hash + keyword.charCodeAt(i)) | 0;
    }
    return Math.abs(hash % 100);
  }
}
