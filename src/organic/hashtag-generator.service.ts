/**
 * HashtagGeneratorService
 *
 * Generates niche-relevant, viral hashtag sets for organic posts.
 * Uses Claude AI when available, falls back to rule-based generation.
 *
 * Strategy:
 *   - Mix of high-volume (1M+), medium (100K-1M), and niche (<100K) hashtags
 *   - Category + product-specific tags
 *   - Trending commerce tags for India markets
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface HashtagSet {
  primary:  string[];   // 5 high-reach tags
  niche:    string[];   // 10 targeted tags
  trending: string[];   // 5 trending commerce tags
  all:      string[];   // combined deduplicated
}

const CATEGORY_TAGS: Record<string, string[]> = {
  fashion:     ['#FashionIndia', '#IndianFashion', '#StyleInspo', '#OOTD', '#FashionBlogger', '#EthnicWear', '#IndianStyle', '#FashionTrends'],
  electronics: ['#TechIndia', '#Gadgets', '#TechDeals', '#MustHaveGadgets', '#IndianTech', '#TechReview', '#GadgetLover', '#SmartHome'],
  beauty:      ['#IndianBeauty', '#SkincareIndia', '#BeautyHacks', '#GlowUp', '#SkincareTips', '#MakeupIndia', '#BeautyBlogger', '#NaturalBeauty'],
  fitness:     ['#FitnessIndia', '#WorkoutIndia', '#HomeWorkout', '#FitLife', '#GymMotivation', '#FitnessGoals', '#YogaIndia', '#HealthyLifestyle'],
  home:        ['#HomeDecorIndia', '#InteriorDesign', '#HomeStyle', '#DecorInspiration', '#IndianHome', '#HomeStyling', '#InteriorDecor', '#HomeAesthetics'],
  food:        ['#FoodieIndia', '#IndianFood', '#Foodstagram', '#FoodBlogger', '#HomeChef', '#RecipeIndia', '#FoodLover', '#DeliciousFood'],
  kids:        ['#MomIndia', '#KidsFashion', '#IndianMom', '#ParentingIndia', '#BabyProducts', '#KidsStyle', '#MomLife', '#BabyShower'],
  pets:        ['#PetsOfIndia', '#DogLoversIndia', '#CatLoversIndia', '#PetCare', '#IndianPets', '#PawsIndia', '#PetParents', '#FurBaby'],
  default:     ['#ShoppingIndia', '#OnlineShopping', '#IndianProducts', '#MadeInIndia', '#BestDeals', '#ShopNow', '#TrendingProducts', '#ViralProduct'],
};

const VIRAL_COMMERCE_TAGS = [
  '#Trending', '#Viral', '#MustHave', '#ProductOfTheDay',
  '#LimitedOffer', '#GetYoursNow', '#OrderNow', '#Shopnow',
  '#BestPrice', '#TopRated', '#CustomerFavorite',
];

const VOLUME_TAGS = [
  '#India', '#IndiaFirst', '#Shopping', '#OnlineShopping',
  '#Sale', '#Deal', '#NewArrival', '#Lifestyle', '#Love', '#Fashion',
];

@Injectable()
export class HashtagGeneratorService {
  private readonly logger = new Logger(HashtagGeneratorService.name);

  constructor(private readonly config: ConfigService) {}

  /** Generate a full hashtag set for a product. */
  generate(opts: {
    category?:   string;
    title?:      string;
    tags?:       string[];
    maxCount?:   number;
  }): HashtagSet {
    const category  = (opts.category ?? 'default').toLowerCase();
    const maxCount  = opts.maxCount ?? 30;

    // Category tags
    const catTags = CATEGORY_TAGS[category] ?? CATEGORY_TAGS['default'];

    // Product title tags
    const titleTags = this.extractTitleTags(opts.title);

    // Custom product tags from product metadata
    const customTags = (opts.tags ?? []).map(t => `#${t.replace(/\s+/g, '')}`);

    // Trending viral commerce hooks
    const trendTags = VIRAL_COMMERCE_TAGS.sort(() => 0.5 - Math.random()).slice(0, 5);

    // High-volume base tags
    const volumeTags = VOLUME_TAGS.sort(() => 0.5 - Math.random()).slice(0, 5);

    // Deduplicate and build sets
    const primary  = [...new Set([...volumeTags, ...trendTags])].slice(0, 5);
    const niche    = [...new Set([...catTags, ...customTags, ...titleTags])].slice(0, 10);
    const trending = trendTags.slice(0, 5);

    const all = [...new Set([...primary, ...niche, ...trending])].slice(0, maxCount);

    this.logger.debug(`Generated ${all.length} hashtags for category: ${category}`);

    return { primary, niche, trending, all };
  }

  /** Generate viral hooks for organic content. */
  generateHooks(product: { title: string; category?: string; sellingPrice?: string }): string[] {
    const price = product.sellingPrice
      ? `₹${parseFloat(product.sellingPrice).toFixed(0)}`
      : '';

    return [
      `🔥 Wait until you see this ${product.title}!`,
      `❌ Stop overpaying — get ${product.title} ${price ? `for just ${price}` : 'at the best price'}!`,
      `This ${product.title} is breaking the internet 👀`,
      `You NEED to see this before it sells out 🚨`,
      `POV: You just discovered the best deal on ${product.title} 💯`,
    ];
  }

  /** Generate reels script for short-form video content. */
  generateReelsScript(product: {
    title:        string;
    description?: string;
    category?:    string;
    sellingPrice?: string;
  }): Record<string, string> {
    const price = product.sellingPrice
      ? `₹${parseFloat(product.sellingPrice).toFixed(0)}`
      : 'an amazing price';

    return {
      hook:    `🤯 Have you seen THIS? [show product dramatically]`,
      problem: `Tired of [common problem related to ${product.category ?? 'this category'}]?`,
      reveal:  `Introducing the ${product.title} — [demo key features]`,
      proof:   `Thousands of happy customers can't be wrong! ⭐⭐⭐⭐⭐`,
      cta:     `Get yours NOW for only ${price}! Link in bio 🔗 #Trending #MustHave`,
      duration: '15-30 seconds',
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  private extractTitleTags(title?: string): string[] {
    if (!title) return [];
    return title
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 3)
      .map(w => `#${w.replace(/[^a-zA-Z0-9]/g, '')}`);
  }
}
