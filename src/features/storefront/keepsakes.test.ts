import { describe, expect, it } from 'vitest';
import { parseCatalogFacts } from './keepsakes';

const FULL = JSON.stringify({
  brand: 'Tumzak',
  rating: 4.5,
  review_count: 94,
  rating_breakdown: { 1: 0.05, 2: 0.04, 3: 0.03, 4: 0.03, 5: 0.85 },
  images: [
    'https://example.com/a.jpg',
    'https://example.com/b.jpg',
    'not-a-url',
    'https://example.com/a.jpg',
  ],
  features: ['Keeps drinks hot', '  ', 42],
  review_insights: [
    { label: 'quality', summary: 'Great quality.', mentions: 29, mention_percent: 97 },
    { label: 'value', summary: 'Good value.', mentions: 14, mention_percent: 86 },
    { label: '', summary: 'No label, dropped.' },
  ],
});

describe('parseCatalogFacts', () => {
  it('parses a full catalog item', () => {
    const facts = parseCatalogFacts(FULL);
    expect(facts).not.toBeNull();
    expect(facts?.brand).toBe('Tumzak');
    expect(facts?.rating).toBe(4.5);
    expect(facts?.reviewCount).toBe(94);
    expect(facts?.ratingBreakdown).toEqual([
      { stars: 5, percent: 85 },
      { stars: 4, percent: 3 },
      { stars: 3, percent: 3 },
      { stars: 2, percent: 4 },
      { stars: 1, percent: 5 },
    ]);
    // Only http(s) URLs, deduplicated.
    expect(facts?.images).toEqual(['https://example.com/a.jpg', 'https://example.com/b.jpg']);
    // Blank and non-string features dropped.
    expect(facts?.features).toEqual(['Keeps drinks hot']);
    expect(facts?.reviewInsights).toEqual([
      { label: 'quality', summary: 'Great quality.', mentions: 29, mentionPercent: 97 },
      { label: 'value', summary: 'Good value.', mentions: 14, mentionPercent: 86 },
    ]);
  });

  it('returns null for missing or malformed JSON', () => {
    expect(parseCatalogFacts(null)).toBeNull();
    expect(parseCatalogFacts('')).toBeNull();
    expect(parseCatalogFacts('{not json')).toBeNull();
    expect(parseCatalogFacts('"just a string"')).toBeNull();
    expect(parseCatalogFacts('[1,2,3]')).toBeNull();
  });

  it('degrades to empty facts when fields are missing or mistyped', () => {
    const facts = parseCatalogFacts(JSON.stringify({ rating: 'high', review_count: -3 }));
    expect(facts).not.toBeNull();
    expect(facts?.brand).toBeNull();
    expect(facts?.rating).toBeNull();
    expect(facts?.reviewCount).toBeNull();
    expect(facts?.ratingBreakdown).toEqual([]);
    expect(facts?.images).toEqual([]);
    expect(facts?.features).toEqual([]);
    expect(facts?.reviewInsights).toEqual([]);
  });
});
