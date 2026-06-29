/**
 * SEOCoordinator
 *
 * Master coordinator for all autonomous SEO operations.
 * Runs scheduled jobs, accepts admin commands, delegates to sub-engines.
 *
 * Scheduled cadence:
 *   Every  1 hour  — AI discoverability pulse (ping AI crawlers)
 *   Every  6 hours — content cluster refresh
 *   Every 12 hours — structured data audit + patch
 *   Every 24 hours — sitemap regeneration
 *   Every 24 hours — programmatic page generation
 *   Every  7 days  — topical authority gap analysis
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron }               from '@nestjs/schedule';
import { ContentClusterEngine }from './content-cluster.engine';
import { ProgrammaticSEO }    from './programmatic-seo.service';
import { StructuredDataGen }  from './structured-data.service';
import { AIDiscoverability }  from './ai-discoverability.service';
import { SitemapService }     from './sitemap.service';
import { SEOAnalyticsService }from './seo-analytics.service';

export interface SEOJobResult {
  job:       string;
  status:    'success' | 'partial' | 'failed';
  duration:  number;
  artifacts: string[];
  errors?:   string[];
}

export interface SEOAuditReport {
  score:              number;   // 0–100
  issues:             SEOIssue[];
  opportunities:      string[];
  aiDiscoverability:  AIDiscoverabilityScore;
  contentGaps:        string[];
  technicalIssues:    string[];
  generatedAt:        Date;
}

export interface SEOIssue {
  severity: 'critical' | 'warning' | 'info';
  type:     string;
  detail:   string;
  url?:     string;
  fix?:     string;
}

export interface AIDiscoverabilityScore {
  chatgpt:     number;  // 0–100 estimated visibility
  gemini:      number;
  claude:      number;
  perplexity:  number;
  overall:     number;
}

@Injectable()
export class SEOCoordinator {
  private readonly logger = new Logger(SEOCoordinator.name);
  private runningJobs = new Set<string>();

  constructor(
    private readonly clusters:     ContentClusterEngine,
    private readonly programmatic: ProgrammaticSEO,
    private readonly structured:   StructuredDataGen,
    private readonly aiDiscover:   AIDiscoverability,
    private readonly sitemap:      SitemapService,
    private readonly analytics:    SEOAnalyticsService,
  ) {}

  // ── Cron: AI discoverability pulse — every hour ──────────────────────────
  @Cron('0 * * * *')
  async runDiscoverabilityPulse(): Promise<void> {
    if (this.runningJobs.has('discoverability')) return;
    this.runningJobs.add('discoverability');
    const start = Date.now();
    try {
      await this.aiDiscover.submitToCrawlers();
      await this.aiDiscover.refreshLLMsContext();
      this.logger.log(`[SEO] Discoverability pulse done in ${Date.now()-start}ms`);
    } catch (err) {
      this.logger.error(`[SEO] Discoverability pulse failed: ${(err as Error).message}`);
    } finally {
      this.runningJobs.delete('discoverability');
    }
  }

  // ── Cron: content cluster refresh — every 6 hours ───────────────────────
  @Cron('0 */6 * * *')
  async runContentClusterRefresh(): Promise<void> {
    if (this.runningJobs.has('clusters')) return;
    this.runningJobs.add('clusters');
    const start = Date.now();
    try {
      const gaps = await this.clusters.detectTopicGaps();
      await this.clusters.generateContentBriefs(gaps.slice(0, 5));
      this.logger.log(`[SEO] Clusters refreshed — ${gaps.length} gaps found in ${Date.now()-start}ms`);
    } catch (err) {
      this.logger.error(`[SEO] Cluster refresh failed: ${(err as Error).message}`);
    } finally {
      this.runningJobs.delete('clusters');
    }
  }

  // ── Cron: structured data audit — every 12 hours ────────────────────────
  @Cron('0 */12 * * *')
  async runStructuredDataAudit(): Promise<void> {
    if (this.runningJobs.has('structured')) return;
    this.runningJobs.add('structured');
    try {
      const issues = await this.structured.auditAll();
      if (issues.length > 0) {
        await this.structured.patchIssues(issues);
        this.logger.log(`[SEO] Structured data: fixed ${issues.length} issues`);
      }
    } catch (err) {
      this.logger.error(`[SEO] Structured data audit failed: ${(err as Error).message}`);
    } finally {
      this.runningJobs.delete('structured');
    }
  }

  // ── Cron: sitemap regeneration — daily at 2am ───────────────────────────
  @Cron('0 2 * * *')
  async runSitemapRegen(): Promise<void> {
    try {
      await this.sitemap.generate();
      await this.sitemap.submitToSearchEngines();
      this.logger.log('[SEO] Sitemap regenerated and submitted');
    } catch (err) {
      this.logger.error(`[SEO] Sitemap regen failed: ${(err as Error).message}`);
    }
  }

  // ── Cron: programmatic pages — daily at 3am ─────────────────────────────
  @Cron('0 3 * * *')
  async runProgrammaticPages(): Promise<void> {
    try {
      const created = await this.programmatic.generateNichePages();
      const landing = await this.programmatic.generateLandingPages();
      this.logger.log(`[SEO] Programmatic: ${created} niche + ${landing} landing pages`);
    } catch (err) {
      this.logger.error(`[SEO] Programmatic pages failed: ${(err as Error).message}`);
    }
  }

  // ── Admin-triggered: full SEO audit ─────────────────────────────────────
  async runFullAudit(): Promise<SEOAuditReport> {
    this.logger.log('[SEO] Running full audit...');
    const [issues, aiScore, gaps, techIssues] = await Promise.all([
      this.structured.auditAll().then(r => r.map(i => ({
        severity: 'warning' as const,
        type: 'structured-data',
        detail: i,
      }))),
      this.aiDiscover.scoreDiscoverability(),
      this.clusters.detectTopicGaps(),
      this.sitemap.auditTechnical(),
    ]);

    const score = Math.round(
      (aiScore.overall * 0.4) +
      (Math.max(0, 100 - issues.length * 5) * 0.3) +
      (Math.max(0, 100 - gaps.length * 3) * 0.3),
    );

    return {
      score,
      issues,
      opportunities: gaps.slice(0, 10),
      aiDiscoverability: aiScore,
      contentGaps: gaps,
      technicalIssues: techIssues,
      generatedAt: new Date(),
    };
  }

  // ── Admin-triggered: force full regeneration ─────────────────────────────
  async forceFullRegeneration(): Promise<SEOJobResult[]> {
    const results: SEOJobResult[] = [];

    for (const [name, fn] of [
      ['sitemap', () => this.sitemap.generate()],
      ['structured-data', () => this.structured.generateAll()],
      ['ai-discoverability', () => this.aiDiscover.optimiseAll()],
      ['programmatic-pages', () => this.programmatic.generateNichePages()],
      ['content-clusters', async () => this.clusters.generateContentBriefs(
        ([] as string[]).concat(await this.clusters.detectTopicGaps().catch(() => []))
      )],
    ] as const) {
      const start = Date.now();
      try {
        await fn();
        results.push({ job: name, status: 'success', duration: Date.now() - start, artifacts: [] });
      } catch (err) {
        results.push({ job: name, status: 'failed', duration: Date.now() - start, artifacts: [], errors: [(err as Error).message] });
      }
    }

    return results;
  }

  // ── Analytics: get current SEO dashboard metrics ─────────────────────────
  async getDashboard() {
    return this.analytics.getDashboard();
  }
}
