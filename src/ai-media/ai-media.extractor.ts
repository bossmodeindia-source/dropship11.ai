/**
 * Prompt engineering logic extracted and adapted from open-generative-ai-main
 * (src/lib/promptUtils.js).  Pure TypeScript — zero side effects.
 */

// ── Quality / style tag banks (from ENHANCE_TAGS in source) ─────────────────
export const QUALITY_TAGS = [
  'professional photography',
  'ultra-detailed',
  '8K resolution',
  'high dynamic range',
  'award-winning',
] as const;

export const LIGHTING_TAGS = [
  'cinematic lighting',
  'golden hour',
  'dramatic studio lighting',
  'soft diffused light',
] as const;

export const ECOM_STYLE_TAGS = [
  'product-centred composition',
  'clean white studio backdrop',
  'sharp foreground focus',
  'high-conversion e-commerce ad style',
  'lifestyle context',
  'vibrant colour grading',
] as const;

// ── Product shape the prompt builder understands ─────────────────────────────
export interface ProductPromptContext {
  title:        string;
  category:     string | null;
  description:  string | null;
  tags:         string[];
  niche?:       string;
}

// ── Image prompt builder ─────────────────────────────────────────────────────
/**
 * Builds an ecom-optimised image prompt from product data.
 *
 * Structure:
 *   [product subject] + [emotional trigger] + [ecom style] + [quality suffix]
 */
export function buildImagePrompt(product: ProductPromptContext): string {
  const subject   = product.title.slice(0, 80);
  const category  = product.category ?? 'product';
  const niche     = product.niche ?? category;
  const topTag    = product.tags?.[0] ?? 'premium';

  const emotionalTrigger =
    `evoking desire and trust, styled for ${niche} enthusiasts`;

  const stylePart = ECOM_STYLE_TAGS.slice(0, 3).join(', ');
  const qualPart  = [QUALITY_TAGS[0], QUALITY_TAGS[2], LIGHTING_TAGS[0]].join(', ');

  return [
    `High-quality product advertisement photo of ${subject}`,
    `a ${topTag} ${category}`,
    emotionalTrigger,
    stylePart,
    qualPart,
    'aspect ratio 1:1',
  ].join(', ');
}

// ── Video prompt builder ─────────────────────────────────────────────────────
/**
 * Builds a 10–15 second reel-style video prompt.
 *
 * Structure (mirrors source VideoStudio pattern):
 *   Hook (first 2 sec) → product showcase → CTA ending
 */
export function buildVideoPrompt(product: ProductPromptContext): string {
  const subject  = product.title.slice(0, 70);
  const category = product.category ?? 'product';
  const benefit  = product.description?.slice(0, 100)
    ?? `premium quality ${category}`;

  const hook     = `POV: discovering the perfect ${category} — `;
  const showcase = `smooth cinematic reveal of ${subject}, `;
  const features = `close-up detail shots highlighting ${benefit}, `;
  const social   = `lifestyle context showing satisfied user, `;
  const cta      = `ending with clear call-to-action overlay "Shop Now". `;
  const style    = `10-second reel format, vertical 9:16 aspect ratio, `
                 + `vibrant colour grade, fast cuts, trending social media style`;

  return hook + showcase + features + social + cta + style;
}

// ── Ad-media unified prompt builder ─────────────────────────────────────────
export interface AdMediaPrompts {
  imagePrompt: string;
  videoPrompt: string;
}

export function buildAdMediaPrompts(product: ProductPromptContext): AdMediaPrompts {
  return {
    imagePrompt: buildImagePrompt(product),
    videoPrompt: buildVideoPrompt(product),
  };
}
