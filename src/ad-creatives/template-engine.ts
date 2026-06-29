/**
 * Template-based creative engine.
 * Pure functions — no I/O, no side effects, fully testable.
 * Used as fallback when no AI API key is configured.
 */

export interface ProductContext {
  title:        string;
  category:     string | null;
  description:  string | null;
  tags:         string[];
  sellingPrice: string | null;
  supplierPrice?: string | null;
}

export interface VideoScript {
  hook:     string;
  problem:  string;
  solution: string;
  cta:      string;
}

export interface AdCreativeBundle {
  hooks:       string[];   // 3
  captions:    string[];   // 3
  headlines:   string[];   // 2
  videoScript: VideoScript;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function title(p: ProductContext): string {
  return p.title.length > 60 ? p.title.slice(0, 57) + '…' : p.title;
}

function cat(p: ProductContext): string {
  return p.category ?? 'product';
}

function price(p: ProductContext): string {
  return p.sellingPrice ? `$${p.sellingPrice}` : 'an unbeatable price';
}

function topTag(p: ProductContext): string {
  return p.tags?.[0] ?? 'trending';
}

// ── Hooks (3 per product) ─────────────────────────────────────────────────────

export function buildHooks(p: ProductContext): [string, string, string] {
  return [
    // Curiosity angle
    `Wait — have you seen this ${cat(p)} everyone's talking about? 👀`,
    // Problem/pain angle
    `Tired of overpriced ${cat(p)}s that never deliver? Here's the fix.`,
    // Social proof angle
    `This ${title(p)} is selling out fast — and here's why customers love it. 🔥`,
  ];
}

// ── Captions (3 per product) ─────────────────────────────────────────────────

export function buildCaptions(p: ProductContext): [string, string, string] {
  const desc = p.description?.slice(0, 120) ?? `a must-have ${cat(p)} for your daily life`;

  return [
    // Short punchy
    `✅ ${title(p)} — ${topTag(p)} quality at ${price(p)}. Limited stock. Grab yours now! 🛒`,

    // Problem → solution
    `Struggling to find a reliable ${cat(p)}? We've got you covered.\n\n` +
    `${title(p)} is designed to ${desc}.\n\n` +
    `🚚 Fast shipping · 💯 Satisfaction guaranteed · 🔒 Secure checkout`,

    // Feature → benefit
    `Introducing ${title(p)} — the ${topTag(p)} ${cat(p)} you've been waiting for.\n\n` +
    `✨ Premium quality  🎁 Great value at ${price(p)}  ⚡ Ships today\n\n` +
    `Don't miss out — tap the link to shop! 👇`,
  ];
}

// ── Headlines (2 per product) ─────────────────────────────────────────────────

export function buildHeadlines(p: ProductContext): [string, string] {
  return [
    // Benefit-focused (≤ 60 chars for Meta)
    `${title(p)} — Best ${cat(p)} at ${price(p)}`.slice(0, 60),
    // Urgency-focused
    `Limited Stock: Get ${title(p)} Today!`.slice(0, 60),
  ];
}

// ── Video script (15–30 sec) ──────────────────────────────────────────────────

export function buildVideoScript(p: ProductContext): VideoScript {
  const desc = p.description?.slice(0, 100) ?? `the perfect ${cat(p)}`;

  return {
    // Hook — first 3 seconds, stop the scroll
    hook:
      `POV: You just found the ${cat(p)} you've been searching for — ` +
      `${title(p)}, and it's only ${price(p)}.`,

    // Problem — 3–8 seconds
    problem:
      `Most ${cat(p)}s on the market are overpriced, low-quality, or take weeks to arrive. ` +
      `You deserve better.`,

    // Solution — 8–22 seconds
    solution:
      `${title(p)} is ${desc}. ` +
      `${p.tags.length ? `Loved by customers who value ${p.tags.slice(0, 2).join(' and ')}.` : 'Loved by thousands of happy customers.'} ` +
      `Premium quality. Fast delivery. Zero compromise.`,

    // CTA — last 3–8 seconds
    cta:
      `Tap the link below to grab yours today — before we sell out. ` +
      `Use code SHOP10 for 10% off your first order. Shop now! 🛒`,
  };
}

// ── Bundled entry point ───────────────────────────────────────────────────────

export function buildCreativeBundle(p: ProductContext): AdCreativeBundle {
  return {
    hooks:       buildHooks(p),
    captions:    buildCaptions(p),
    headlines:   buildHeadlines(p),
    videoScript: buildVideoScript(p),
  };
}
