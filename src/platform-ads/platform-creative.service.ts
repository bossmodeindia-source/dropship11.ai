/**
 * PlatformCreativeService
 *
 * Generates AI Empire Bot platform-focused ad creatives.
 * ISOLATED from tenant / product / Shopify creative pipelines.
 *
 * Creative types:
 *   - AI automation ads
 *   - SaaS demo ads
 *   - Founder-style ads
 *   - Testimonial ads
 *   - "Earn online" ads
 *   - Shopify automation demos
 *   - Case study creatives
 *   - Onboarding video scripts
 *   - Reel scripts
 *
 * Uses AiCreativeProviderService when a real API key is configured,
 * falls back to battle-tested templates.
 */

import { Injectable, Logger, Inject } from '@nestjs/common';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { DB_TOKEN } from '../common/database/database.module';
import * as schema from '../common/database/schema';
import { platformCreatives } from './platform-ads.schema';
import { AiCreativeProviderService } from '../ad-creatives/ai-creative-provider.service';

// ── Lightweight inline scoring (avoids TypeORM dependency) ───────────────────

const HIGH_CTR_WORDS = [
  'free', 'secret', 'proven', 'instant', 'stop', 'now', 'limited',
  'exclusive', 'shocking', 'finally', 'transform', 'guaranteed', 'honest',
  'real', 'earn', 'profit', 'scale', 'autopilot', 'automated',
];

function scoreHook(hook: string): number {
  const lower = hook.toLowerCase();
  const wordScore = HIGH_CTR_WORDS.filter(w => lower.includes(w)).length;
  const lengthScore = hook.length < 80 ? 1 : 0;
  const emojiScore = /[\u{1F300}-\u{1FAFF}]/u.test(hook) ? 0.5 : 0;
  return Math.min(10, wordScore * 2 + lengthScore + emojiScore);
}

function inlineScore(hooks: string[]): {
  predicted_ctr: number; predicted_roas: number; confidence_score: number;
  recommendation: 'launch' | 'revise' | 'reject';
} {
  const avgHookStrength = hooks.reduce((s, h) => s + scoreHook(h), 0) / (hooks.length || 1);
  const predicted_ctr   = 0.019 + avgHookStrength * 0.003;
  const predicted_roas  = 1.8 + avgHookStrength * 0.25;
  const confidence_score = Math.min(1, 0.4 + avgHookStrength * 0.06);
  const recommendation: 'launch' | 'revise' | 'reject' =
    predicted_roas >= 2.5 ? 'launch' :
    predicted_roas >= 1.5 ? 'revise' : 'reject';
  return { predicted_ctr, predicted_roas, confidence_score, recommendation };
}

export interface PlatformCreativeBundle {
  hooks:       string[];
  captions:    string[];
  headlines:   string[];
  cta:         string;
  hashtags:    string[];
  imagePrompt: string;
  videoPrompt: string;
  reelScript:  string;
  adCopy:      string;
}

export type PlatformCreativeStyle =
  | 'AI_AUTOMATION'
  | 'SAAS_DEMO'
  | 'FOUNDER'
  | 'TESTIMONIAL'
  | 'EARN_ONLINE'
  | 'SHOPIFY_DEMO'
  | 'CASE_STUDY'
  | 'ONBOARDING_VIDEO';

// ── Template bank ─────────────────────────────────────────────────────────────

const HOOKS: Record<PlatformCreativeStyle, string[]> = {
  AI_AUTOMATION: [
    '🤖 What if your Shopify store ran itself 24/7?',
    'This AI bot made ₹1.2L in 30 days — here\'s how.',
    'Stop doing ads manually. Let AI do it for you. 👇',
  ],
  SAAS_DEMO: [
    'We built an AI that runs an entire ecommerce business.',
    '⚡ Product discovery → Ad launch → Order fulfilment — all automated.',
    'One dashboard. Zero manual work. Real profit.',
  ],
  FOUNDER: [
    '6 months ago I had zero dropshipping experience. Then I found AI Empire.',
    'I run 12 Shopify stores. My AI bot manages all of them.',
    'Honest question: are you still running ads manually in 2025? 👀',
  ],
  TESTIMONIAL: [
    '"I made ₹87,000 in my first month with AI Empire Bot." — Ravi, Mumbai',
    'Real results. Real users. No fake claims. See what our users say. 👇',
    '⭐⭐⭐⭐⭐ "Best investment I\'ve made for my ecommerce business."',
  ],
  EARN_ONLINE: [
    'Want to earn online without learning ads yourself?',
    '₹0 to ₹1L/month — the AI-powered dropshipping playbook.',
    'The smartest way to build passive income in India right now. 🇮🇳',
  ],
  SHOPIFY_DEMO: [
    '🛍️ Watch an AI find winning products and launch ads in under 5 minutes.',
    'This is what your Shopify store looks like on AI Empire Bot.',
    'Product research. Ad creatives. Campaign launch. All on autopilot.',
  ],
  CASE_STUDY: [
    'From ₹10,000 seed capital to ₹2.4L profit — the full breakdown.',
    'How this AI bot scaled a fashion store to ₹50L ARR.',
    '📈 Inside: the exact AI strategy that 3x\'d this store\'s ROAS.',
  ],
  ONBOARDING_VIDEO: [
    'Setting up AI Empire Bot takes 7 minutes. Here\'s the full walkthrough.',
    '🚀 Your first profitable campaign in 24 hours — step by step.',
    'New user? This video will change how you think about ecommerce.',
  ],
};

const CAPTIONS: Record<PlatformCreativeStyle, string[]> = {
  AI_AUTOMATION: [
    'AI Empire Bot runs your entire Shopify dropshipping business on autopilot.\n\n🤖 AI product discovery\n📢 Auto ad campaigns\n📦 Automatic order fulfilment\n💰 Real-time profit tracking\n\nStart your free trial today. 👇',
    'Imagine waking up to new orders — without lifting a finger.\n\nAI Empire Bot scans for winning products, launches Meta campaigns, handles supplier fulfilment, and optimises everything automatically.\n\n✅ No ad experience needed\n✅ Works on any Shopify store\n✅ Risk-protected with AI spend limits',
    'The future of dropshipping is fully automated.\n\nAI Empire Bot uses advanced machine learning to:\n→ Find trending products before competitors\n→ Generate high-converting ad creatives\n→ Launch and scale profitable campaigns\n→ Kill losers before they drain your budget\n\n🎯 Try it free for 14 days.',
  ],
  SAAS_DEMO: [
    'AI Empire Bot is the only platform that runs a complete Shopify commerce cycle autonomously.\n\nSee the live demo. No credit card required.',
    'One platform. Everything automated.\n\n→ Product research ✅\n→ Creative generation ✅\n→ Meta Ads launch ✅\n→ Fulfilment ✅\n→ Analytics ✅\n\nStart free. Scale fast.',
    'Stop guessing which products will win.\n\nOur AI analyses thousands of signals daily — TikTok trends, Amazon bestsellers, Meta CPC data — and finds winners before you spend a rupee on ads.\n\n👇 Book a live demo.',
  ],
  FOUNDER: [
    'I\'m Arjun. I built AI Empire Bot because I was tired of losing money on bad ads.\n\nToday it runs 12 stores for me. I check in once a week.\n\nHere\'s exactly how it works. 👇',
    'Honest take: 90% of people fail at dropshipping because of bad product selection and poor ad strategy.\n\nAI Empire Bot solves both — automatically.\n\n14-day free trial. No risk.',
    'I didn\'t know anything about Facebook Ads when I started.\n\nAI Empire Bot generated my first profitable campaign in 48 hours.\n\nThat was 8 months ago. Now I\'m at ₹4L/month.\n\nStart today. 👇',
  ],
  TESTIMONIAL: [
    '"Before AI Empire, I was spending 6 hours a day on ads and barely breaking even. Now the bot does everything. I just check the profits." — Priya S., Delhi\n\n⭐⭐⭐⭐⭐ Join 1,000+ profitable store owners.',
    'Real numbers from a real user:\n\n📅 Month 1: ₹23,400 profit\n📅 Month 2: ₹51,200 profit\n📅 Month 3: ₹1.1L profit\n\nNo previous experience. Just the AI.\n\n👇 Start your free trial.',
    'Don\'t take our word for it.\n\n"AI Empire Bot found a winning product in my first week that I never would have found manually. The ROAS on that campaign is 4.2x." — Karthik R., Bangalore\n\nTry it free for 14 days.',
  ],
  EARN_ONLINE: [
    'The #1 mistake people make trying to earn online: doing everything manually.\n\nAI Empire Bot automates the entire dropshipping stack so you can focus on growth — not operations.\n\n🇮🇳 Made for Indian entrepreneurs. Start at ₹0 risk.',
    'Dropshipping in 2025 is an AI game.\n\nManual product research: 8 hours.\nAI Empire Bot product research: 4 minutes.\n\nManual ad setup: 3 hours.\nAI Empire Bot ad launch: automated.\n\nWhich would you choose? 👇',
    'Want to build a real online income stream without the guesswork?\n\nAI Empire Bot is the only platform that combines AI product intelligence, automated campaigns, and real-time profit protection — in one place.\n\n✅ Start free\n✅ No ad experience needed\n✅ Capital protected by AI',
  ],
  SHOPIFY_DEMO: [
    'Watch the AI find a winning product, generate 5 creatives, and launch a Meta campaign — in under 5 minutes.\n\n[Full demo in the comments] 👇',
    'This is what AI Empire Bot does every single day for your Shopify store:\n\n1️⃣ Scans 10,000+ products for winning signals\n2️⃣ Generates AI ad creatives automatically\n3️⃣ Launches optimised Meta campaigns\n4️⃣ Scales winners, kills losers\n5️⃣ Tracks profit in real time\n\nFully autonomous. Connect your store in 7 minutes.',
    'The Shopify automation demo everyone is asking about.\n\nLive walkthrough: AI Empire Bot running a full commerce cycle on autopilot.\n\n👇 Book your spot (free). Limited seats.',
  ],
  CASE_STUDY: [
    'Case study: ₹10,000 → ₹2.4L profit in 60 days.\n\nStore niche: Women\'s fashion accessories.\nAI strategy: Thompson Sampling + ROAS-based scaling.\nResult: 6.2x ROAS on winning campaigns.\n\nFull breakdown below. 👇',
    'How Meena scaled her Shopify store from ₹0 to ₹50L ARR using AI Empire Bot:\n\n✅ AI found her first winning product in 3 days\n✅ Meta campaigns launched automatically\n✅ Bot killed 4 losers before they wasted budget\n✅ Scaled winner to ₹1.8L/month spend\n\nShe didn\'t touch a single ad manually.',
    'The math behind a profitable AI Empire store:\n\n💰 Ad spend: ₹45,000\n📦 Revenue: ₹2,80,000\n📊 ROAS: 6.2x\n📈 Net profit: ₹1,75,000\n\nTime spent by the owner: ~2 hours/week (checking reports).\n\nStart your free trial. 👇',
  ],
  ONBOARDING_VIDEO: [
    'New to AI Empire Bot? Here\'s your complete setup guide.\n\n⏱️ 7 minutes to connect your Shopify store\n⏱️ 3 minutes to configure your AI settings\n⏱️ 24 hours to your first profitable campaign\n\n🎯 Watch this first.',
    'Step-by-step: launching your first AI-powered Shopify campaign.\n\n1. Connect Shopify store\n2. Set budget limits\n3. Enable AI product discovery\n4. Watch the bot work\n\nFull tutorial in the video. Subscribe for weekly AI commerce tips. 👇',
    'If you\'re new here — welcome.\n\nThis channel covers AI-powered ecommerce: product research, automated ads, AI scaling, and real profit tracking.\n\nStart with this video. Hit subscribe. Let\'s build together. 🚀',
  ],
};

const HEADLINES: Record<PlatformCreativeStyle, string[]> = {
  AI_AUTOMATION:   ['AI Runs Your Shopify Store 24/7', 'Automate. Scale. Profit.'],
  SAAS_DEMO:       ['See the Full AI Demo', 'One Platform. Everything Automated.'],
  FOUNDER:         ['Built by a Dropshipper, For Dropshippers', 'My AI Bot Makes ₹4L/Month'],
  TESTIMONIAL:     ['1,000+ Profitable Stores', 'Real Results. Real Users.'],
  EARN_ONLINE:     ['Earn Online With AI Commerce', 'No Experience? No Problem.'],
  SHOPIFY_DEMO:    ['Watch AI Launch Ads in 5 Min', 'Your Store on Autopilot'],
  CASE_STUDY:      ['₹10K → ₹2.4L in 60 Days', '6.2x ROAS. Real Case Study.'],
  ONBOARDING_VIDEO:['Setup in 7 Minutes', 'Your First AI Campaign 24hr'],
};

const IMAGE_PROMPTS: Record<PlatformCreativeStyle, string> = {
  AI_AUTOMATION:   'Clean SaaS dashboard showing AI metrics, dark background, neon green accent, professional Indian entrepreneur looking at screen, modern office, 9:16 vertical format',
  SAAS_DEMO:       'Split screen: left shows chaotic manual spreadsheets, right shows clean AI Empire Bot dashboard, arrow pointing right, professional gradient background',
  FOUNDER:         'Authentic Indian founder sitting casually with laptop, Shopify dashboard visible, natural lighting, slight smile, relatable not corporate',
  TESTIMONIAL:     'Testimonial card design: profile photo, ₹ revenue number in large bold text, star rating, clean white/blue gradient, professional typography',
  EARN_ONLINE:     'Upward trending revenue chart overlaid on India map, ₹ currency symbols, gradient from orange to green, modern flat design',
  SHOPIFY_DEMO:    'Shopify admin panel with AI overlay showing product winner detection, green highlights, clean UI screenshot style, minimal frame',
  CASE_STUDY:      'Before/after revenue chart, month-by-month growth, bold ₹ numbers, clean data visualization, trust-building design',
  ONBOARDING_VIDEO:'Clean step-by-step UI walkthrough, numbered steps, Shopify + AI Empire logos, modern tutorial style, soft gradient background',
};

const VIDEO_PROMPTS: Record<PlatformCreativeStyle, string> = {
  AI_AUTOMATION:   'Screencast of AI Empire Bot dashboard: show product discovery scanning, creative generation, then Meta campaign launching — time-lapse style, add upbeat background music',
  SAAS_DEMO:       'Full product demo: connect Shopify store → AI scans products → generates creatives → launches campaign → shows ROAS metric — 60 seconds, professional voiceover',
  FOUNDER:         'Talking head: Indian founder (casual setting, laptop visible) explaining how AI Empire Bot changed their business — authentic, not scripted-sounding — 30-45 seconds',
  TESTIMONIAL:     'User testimonial: real person on camera sharing revenue results, then screen recording of their AI Empire dashboard showing the numbers — 45 seconds',
  EARN_ONLINE:     'Hook: "What if your phone could make you money while you sleep?" — show AI Empire bot running — cut to revenue notification — 15-second reel style',
  SHOPIFY_DEMO:    'Screen recording: full flow from product discovery to campaign launch — speed-ramped to 30 seconds — no talking, just UI motion + captions',
  CASE_STUDY:      'Animated revenue graph growing over time, narrated with key milestones, end with current monthly revenue — 45 seconds, professional animation',
  ONBOARDING_VIDEO:'Tutorial walkthrough: step by step setup, calm voiceover, clean screen recording, chapter markers, end with "first campaign is live" moment — 7 minutes',
};

const REEL_SCRIPTS: Record<PlatformCreativeStyle, string> = {
  AI_AUTOMATION:   'Hook (0-3s): "This AI bot made me ₹1.2L last month" / Problem (3-8s): Show manual ad work chaos / Solution (8-20s): AI Empire dashboard running automatically / CTA (20-30s): "Link in bio — 14-day free trial"',
  SAAS_DEMO:       'Hook (0-3s): "Watch an AI launch a Shopify campaign in 4 minutes" / Demo (3-25s): Screencast of full flow / CTA (25-30s): "Try it free — link in bio"',
  FOUNDER:         'Hook (0-3s): "I quit my job to run Shopify stores. Here\'s my setup." / Story (3-20s): Brief founder journey / CTA (20-30s): "Use my tool — link in bio"',
  TESTIMONIAL:     'Hook (0-3s): Revenue notification sound + "This came in while I was sleeping" / Show (3-20s): Dashboard screenshot + quick story / CTA (20-30s): "Start free today"',
  EARN_ONLINE:     'Hook (0-3s): "Easiest way to earn online in India right now" / Explain (3-20s): 3 AI features in quick cuts / CTA (20-30s): "Free trial — no card needed"',
  SHOPIFY_DEMO:    'Hook (0-3s): "POV: your Shopify store runs itself" / Demo (3-25s): Time-lapse of full automation cycle / CTA (25-30s): "Try AI Empire — link bio"',
  CASE_STUDY:      'Hook (0-3s): "₹10K investment → ₹2.4L profit. Here\'s how." / Breakdown (3-25s): Key metrics as text overlays / CTA (25-30s): "Full case study at link in bio"',
  ONBOARDING_VIDEO:'Hook (0-3s): "Setup took me 7 minutes. First order in 24 hours." / Tutorial (3-25s): Quick setup walkthrough / CTA (25-30s): "Start free — link in bio"',
};

// ── Service ────────────────────────────────────────────────────────────────────

@Injectable()
export class PlatformCreativeService {
  private readonly logger = new Logger(PlatformCreativeService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: NodePgDatabase<typeof schema>,
    private readonly aiProvider: AiCreativeProviderService,
  ) {}

  // ── Generate creative bundle ──────────────────────────────────────────────

  async generateBundle(
    style: PlatformCreativeStyle,
    campaignId?: string,
  ): Promise<PlatformCreativeBundle> {
    this.logger.log(`Generating platform creative: style=${style}, campaign=${campaignId ?? 'standalone'}`);

    const hooks     = HOOKS[style];
    const captions  = CAPTIONS[style];
    const headlines = HEADLINES[style];

    // Try AI generation when key is available
    if (this.aiProvider.hasRealKey) {
      try {
        const ctx = this.toPlatformContext(style);
        const result = await this.aiProvider.generate(ctx);
        return {
          hooks:       result.bundle.hooks,
          captions:    result.bundle.captions,
          headlines:   result.bundle.headlines,
          cta:         this.pickCta(style),
          hashtags:    this.buildHashtags(style),
          imagePrompt: IMAGE_PROMPTS[style],
          videoPrompt: VIDEO_PROMPTS[style],
          reelScript:  REEL_SCRIPTS[style],
          adCopy:      result.bundle.captions[0],
        };
      } catch (err) {
        this.logger.warn(`AI creative generation failed, using templates: ${(err as Error).message}`);
      }
    }

    return {
      hooks,
      captions,
      headlines,
      cta:         this.pickCta(style),
      hashtags:    this.buildHashtags(style),
      imagePrompt: IMAGE_PROMPTS[style],
      videoPrompt: VIDEO_PROMPTS[style],
      reelScript:  REEL_SCRIPTS[style],
      adCopy:      captions[0],
    };
  }

  // ── Score a creative ──────────────────────────────────────────────────────

  async scoreAndPersist(
    bundle:       PlatformCreativeBundle,
    style:        PlatformCreativeStyle,
    campaignId:   string,
    creativeType: 'IMAGE' | 'VIDEO' | 'REEL' | 'CAROUSEL' | 'STORY' = 'IMAGE',
  ): Promise<typeof platformCreatives.$inferSelect> {
    // Inline lightweight scoring (no external TypeORM dependency)
    const scoring = inlineScore(bundle.hooks);

    const [row] = await this.db.insert(platformCreatives).values({
      campaignId:            campaignId,
      name:                  `${style} Creative ${new Date().toISOString().slice(0, 10)}`,
      type:                  creativeType,
      status:                'DRAFT',
      hook:                  bundle.hooks[0],
      caption:               bundle.captions[0],
      headline:              bundle.headlines[0],
      cta:                   bundle.cta,
      hashtags:              bundle.hashtags,
      imagePrompt:           bundle.imagePrompt,
      videoPrompt:           bundle.videoPrompt,
      reelScript:            bundle.reelScript,
      adCopy:                bundle.adCopy,
      predictedCtr:          String(scoring.predicted_ctr.toFixed(4)),
      predictedRoas:         String(scoring.predicted_roas.toFixed(2)),
      confidenceScore:       String(scoring.confidence_score.toFixed(2)),
      scoringRecommendation: scoring.recommendation,
      aiGenerated:           true,
    }).returning();

    return row;
  }

  // ── Thompson Sampling — pick winning creative ─────────────────────────────

  async pickWinnerThompson(campaignId: string): Promise<typeof platformCreatives.$inferSelect | null> {
    const creatives = await this.db
      .select()
      .from(platformCreatives)
      .where(eq(platformCreatives.campaignId, campaignId));

    if (!creatives.length) return null;

    // Beta(wins+1, trials-wins+1) sampling
    let best: typeof platformCreatives.$inferSelect | null = null;
    let bestSample = -1;

    for (const c of creatives) {
      const wins   = c.wins   ?? 0;
      const trials = c.trials ?? 0;
      const alpha  = wins + 1;
      const beta   = trials - wins + 1;
      const sample = this.betaSample(alpha, beta);
      if (sample > bestSample) {
        bestSample = sample;
        best = c;
      }
    }

    return best;
  }

  // ── Mark result ───────────────────────────────────────────────────────────

  async recordResult(creativeId: string, won: boolean): Promise<void> {
    const [current] = await this.db
      .select({ wins: platformCreatives.wins, trials: platformCreatives.trials })
      .from(platformCreatives)
      .where(eq(platformCreatives.id, creativeId));

    if (!current) return;

    await this.db
      .update(platformCreatives)
      .set({
        wins:      (current.wins   ?? 0) + (won ? 1 : 0),
        trials:    (current.trials ?? 0) + 1,
        isWinner:  won ? true : undefined,
        updatedAt: new Date(),
      })
      .where(eq(platformCreatives.id, creativeId));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private toPlatformContext(style: PlatformCreativeStyle) {
    return {
      title:        'AI Empire Bot — AI-Powered Shopify Dropshipping Platform',
      category:     'SaaS',
      description:  'Automate product discovery, ad campaigns, and fulfilment for your Shopify store using AI.',
      tags:         ['AI', 'automation', 'dropshipping', 'Shopify', 'ecommerce', 'India'],
      sellingPrice: null,
    };
  }

  private pickCta(style: PlatformCreativeStyle): string {
    const ctaMap: Record<PlatformCreativeStyle, string> = {
      AI_AUTOMATION:   'SIGN_UP',
      SAAS_DEMO:       'LEARN_MORE',
      FOUNDER:         'SIGN_UP',
      TESTIMONIAL:     'SIGN_UP',
      EARN_ONLINE:     'SIGN_UP',
      SHOPIFY_DEMO:    'LEARN_MORE',
      CASE_STUDY:      'LEARN_MORE',
      ONBOARDING_VIDEO:'SUBSCRIBE',
    };
    return ctaMap[style];
  }

  private buildHashtags(style: PlatformCreativeStyle): string[] {
    const base = ['#aiempirebot', '#dropshipping', '#shopify', '#aicommerce', '#ecommerceindia', '#makemoneyonline'];
    const extras: Record<PlatformCreativeStyle, string[]> = {
      AI_AUTOMATION:   ['#aiautomation', '#passiveincome'],
      SAAS_DEMO:       ['#saas', '#productdemo'],
      FOUNDER:         ['#founderstory', '#entrepreneurship'],
      TESTIMONIAL:     ['#results', '#successstory'],
      EARN_ONLINE:     ['#earnonline', '#workfromhome'],
      SHOPIFY_DEMO:    ['#shopifystore', '#ecommercetips'],
      CASE_STUDY:      ['#casestudy', '#roas'],
      ONBOARDING_VIDEO:['#tutorial', '#howto'],
    };
    return [...base, ...(extras[style] ?? [])];
  }

  /** Approximate Beta distribution sample using the Johnk method */
  private betaSample(alpha: number, beta: number): number {
    // Simple gamma-based approximation
    const gamma1 = this.gammaApprox(alpha);
    const gamma2 = this.gammaApprox(beta);
    return gamma1 / (gamma1 + gamma2);
  }

  private gammaApprox(shape: number): number {
    // Marsaglia-Tsang squeeze for integer-ish shapes
    if (shape < 1) return this.gammaApprox(shape + 1) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x: number, v: number;
      do {
        x = this.normalSample();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  private normalSample(): number {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
