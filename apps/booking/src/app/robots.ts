import type { MetadataRoute } from 'next';

/**
 * A guest's booking is opened with a personal link, and `/api/` is not pages
 * at all: neither belongs in a search engine. Everything else may be read.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/booking/', '/api/'] }],
  };
}
