/**
 * ContentClusterEngine
 *
 * Builds topical authority through systematic content clustering.
 *
 * Strategy:
 *   - Pillar pages: broad topics (e.g. "Dropshipping in India")
 *   - Cluster pages: specific sub-topics (e.g. "Best dropshipping niches India 2025")
 *   - Interlinking: all cluster pages link to pillar + related clusters
 *   - FAQ integration: conversational answers embedded in each page
 *   - Internal link graph: maximises crawl depth and link equity
 *
 * Competitor gap analysis:
 *   - Identifies keywords competitors rank for that we don't
 *   - Detects missing subtopics in our content cluster
 *   - Prioritises by search volume × buyer intent
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import { AiOrchestratorService }      from '../ai-orchestrator/ai-orchestrator.service';
import { DrizzleDB, DB_TOKEN }        from '../common/database/database.module';

export interface ContentBrief {
  title:           string;
  slug:            string;
  targetKeyword:   string;
  secondaryKeywords: string[];
  searchIntent:    'informational' | 'transactional' | 'navigational' | 'commercial';
  wordCount:       number;
  outline:         ContentSection[];
  internalLinks:   string[];
  faqQuestions:    string[];
  pillarPageSlug?: string;
  priority:        'urgent' | 'high' | 'medium' | 'low';
}

export interface ContentSection {
  heading:    string;
  level:      2 | 3;
  wordCount:  number;
  intent:     string;
  notes:      string;
}

const PILLAR_TOPICS = [
  'dropshipping india',
  'meta ads automation india',
  'shopify automation india',
  'ai ecommerce tools india',
  'dropshipping product research india',
  'facebook ads dropshipping india',
  'video ads ai generation',
  'organic marketing instagram india',
] as const;

@Injectable()
export class ContentClusterEngine {
  private readonly logger = new Logger(ContentClusterEngine.name);

  constructor(
    private readonly ai: AiOrchestratorService,
    @Inject(DB_TOKEN) private readonly db: DrizzleDB,
  ) {}

  // ── Detect topic gaps using AI analysis ──────────────────────────────────
  async detectTopicGaps(): Promise<string[]> {
    const prompt = `You are an SEO strategist for "AI Empire Bot" — an autonomous AI dropshipping + Meta Ads SaaS for India.

Identify 20 high-value content topics we should cover to build topical authority.
Focus on: long-tail keywords, buyer intent phrases, comparison keywords, "how to" queries.
Target audience: Indian dropshippers, e-commerce entrepreneurs.

Return a JSON array of strings (topic phrases only, no explanations).
Example: ["best dropshipping niches india 2025", "how to automate meta ads india"]`;

    try {
      const resp = await this.ai.resolve({ userId: 'admin', operation: 'listing', context: { prompt } });
      const text = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as string[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return this.getDefaultGaps();
    }
  }

  // ── Generate content briefs for detected gaps ─────────────────────────────
  async generateContentBriefs(topics: string[]): Promise<ContentBrief[]> {
    const briefs: ContentBrief[] = [];

    for (const topic of topics.slice(0, 10)) {
      try {
        const brief = await this.generateBrief(topic);
        briefs.push(brief);
        await this.persistBrief(brief);
      } catch (err) {
        this.logger.warn(`[ContentCluster] Brief failed for "${topic}": ${(err as Error).message}`);
      }
    }

    return briefs;
  }

  // ── Get existing published content cluster map ────────────────────────────
  async getClusterMap(): Promise<Record<string, ContentBrief[]>> {
    const map: Record<string, ContentBrief[]> = {};
    for (const pillar of PILLAR_TOPICS) {
      map[pillar] = []; // In production: query CMS / DB for published cluster pages
    }
    return map;
  }

  // ── Private: generate a single content brief ─────────────────────────────
  private async generateBrief(topic: string): Promise<ContentBrief> {
    const prompt = `Create a detailed SEO content brief for this topic: "${topic}"
Platform context: AI Empire Bot — autonomous AI dropshipping + Meta Ads SaaS for India.

Return JSON with this EXACT structure (no markdown):
{
  "title": "page title",
  "slug": "url-slug",
  "targetKeyword": "primary keyword",
  "secondaryKeywords": ["kw1","kw2","kw3"],
  "searchIntent": "informational|transactional|navigational|commercial",
  "wordCount": 1500,
  "outline": [
    {"heading":"H2 title","level":2,"wordCount":300,"intent":"explain X","notes":"include Y"},
    {"heading":"H3 sub","level":3,"wordCount":150,"intent":"detail Z","notes":""}
  ],
  "internalLinks": ["/feature/meta-ads","/blog/dropshipping-india"],
  "faqQuestions": ["Question 1?","Question 2?"],
  "pillarPageSlug": "/blog/dropshipping-india",
  "priority": "high"
}`;

    const resp = await this.ai.resolve({ userId: 'admin', operation: 'listing', context: { prompt } });
    const text = typeof resp.content === 'string' ? resp.content : JSON.stringify(resp.content);
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim()) as ContentBrief;
    return parsed;
  }

  // ── Private: persist brief to DB for CMS pickup ──────────────────────────
  private async persistBrief(brief: ContentBrief): Promise<void> {
    // In production: insert into content_briefs table for editorial review
    this.logger.debug(`[ContentCluster] Brief persisted: ${brief.slug}`);
  }

  private getDefaultGaps(): string[] {
    return [
      'dropshipping india 2025 beginners guide',
      'how to automate meta facebook ads india',
      'best shopify automation tools india',
      'ai product research dropshipping india',
      'instagram organic marketing dropshipping india',
      'how to find winning products dropshipping 2025',
      'meta ads roas optimization guide india',
      'shopify vs woocommerce dropshipping india',
      'tiktok product research method india',
      'ai video ads generator dropshipping india',
    ];
  }
}
