/**
 * SEOAutomationModule
 *
 * Autonomous SEO + AI Discoverability Operating System.
 *
 * Optimises the AI Empire platform for:
 *   - Google organic search (semantic + topical authority)
 *   - AI assistant discoverability (ChatGPT, Gemini, Claude, Perplexity)
 *   - Programmatic landing pages
 *   - Structured data / schema markup
 *   - Content cluster generation
 *   - Sitemap + indexing automation
 *   - Core Web Vitals tracking
 *   - FAQ + conversational search optimisation
 *
 * ADMIN-ONLY: Users never interact with this module directly.
 * All jobs are run on cron or triggered via UnifiedCommerceOrchestrator admin workflows.
 */
import { Module }              from '@nestjs/common';
import { SEOCoordinator }     from './seo-coordinator.service';
import { ContentClusterEngine }from './content-cluster.engine';
import { ProgrammaticSEO }     from './programmatic-seo.service';
import { StructuredDataGen }   from './structured-data.service';
import { AIDiscoverability }   from './ai-discoverability.service';
import { SitemapService }      from './sitemap.service';
import { SEOAnalyticsService } from './seo-analytics.service';
import { SEOController }       from './seo.controller';
import { AiOrchestratorModule } from '../ai-orchestrator/ai-orchestrator.module';
import { DatabaseModule }      from '../common/database/database.module';

@Module({
  imports: [AiOrchestratorModule, DatabaseModule],
  providers: [
    SEOCoordinator,
    ContentClusterEngine,
    ProgrammaticSEO,
    StructuredDataGen,
    AIDiscoverability,
    SitemapService,
    SEOAnalyticsService,
  ],
  controllers: [SEOController],
  exports: [SEOCoordinator, AIDiscoverability, ContentClusterEngine],
})
export class SEOAutomationModule {}
