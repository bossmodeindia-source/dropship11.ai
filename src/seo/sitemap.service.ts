import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';


@Injectable()
export class SitemapService {
  private readonly logger = new Logger(SitemapService.name);
  /* eslint-disable */

  async generate(): Promise<string> {
    // In production: crawl all routes and build sitemap.xml with lastmod dates
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://aiempirebot.com/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>https://aiempirebot.com/features</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://aiempirebot.com/pricing</loc><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>https://aiempirebot.com/blog</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
</urlset>`;
    this.logger.debug('[SEO:Sitemap] Generated');
    return sitemap;
  }

  async submitToSearchEngines(): Promise<void> {
    const sitemapUrl = encodeURIComponent('https://aiempirebot.com/sitemap.xml');
    await Promise.allSettled([
      axios.get(`https://www.google.com/ping?sitemap=${sitemapUrl}`).catch(() => null),
      axios.get(`https://www.bing.com/ping?sitemap=${sitemapUrl}`).catch(() => null),
    ]);
    this.logger.log('[SEO:Sitemap] Submitted to search engines');
  }

  async auditTechnical(): Promise<string[]> {
    return []; // In production: check robots.txt, canonical issues, redirect chains, etc.
  }
}
