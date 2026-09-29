/**
 * "Similar widgets" over the full-text index: a package is similar when it shares keywords, the category or the
 * facet kind of the source package. Each signal is one search through the regular search surface, so callers pass
 * whichever search they have (the HTTP API in the SDK and WebMCP, the application service in MCP). A vector-search
 * implementation can replace this later behind the same result shape.
 */

/** The fields of a package this heuristic reads. */
export interface SimilaritySource {
  name: string;
  keywords: string[];
  categorySlug: string | null;
  latest: { facets: { kind: string }[] } | null;
}

export interface SimilarityCandidate {
  name: string;
  displayName: string;
  description: string;
  latestVersion: string | null;
  keywords: string[];
  categorySlug: string | null;
}

export interface SimilarityQuery {
  q?: string;
  category?: string;
  kind?: string;
  limit?: number;
}

export interface SimilarPackage<Candidate extends SimilarityCandidate = SimilarityCandidate> {
  package: Candidate;
  score: number;
  /** Why it matched, e.g. `keyword:clock`, `category:productivity`, `kind:widget`. */
  reasons: string[];
}

const MAX_KEYWORD_SEARCHES = 5;
const PER_SEARCH_LIMIT = 20;
const WEIGHTS = { keyword: 2, category: 1, kind: 1 } as const;

export async function findSimilarPackages<Candidate extends SimilarityCandidate>(
  source: SimilaritySource,
  search: (query: SimilarityQuery) => Promise<{ items: Candidate[] }>,
  limit = 5,
): Promise<SimilarPackage<Candidate>[]> {
  const signals: { reason: string; weight: number; query: SimilarityQuery }[] = [];
  const keywords = [...new Set(source.keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))];
  for (const keyword of keywords.slice(0, MAX_KEYWORD_SEARCHES)) {
    signals.push({ reason: `keyword:${keyword}`, weight: WEIGHTS.keyword, query: { q: keyword } });
  }
  if (source.categorySlug) {
    signals.push({ reason: `category:${source.categorySlug}`, weight: WEIGHTS.category, query: { category: source.categorySlug } });
  }
  const kind = source.latest?.facets[0]?.kind;
  if (kind) signals.push({ reason: `kind:${kind}`, weight: WEIGHTS.kind, query: { kind } });

  const results = await Promise.all(signals.map((signal) => search({ ...signal.query, limit: PER_SEARCH_LIMIT })));
  const scored = new Map<string, SimilarPackage<Candidate>>();
  results.forEach((result, index) => {
    const signal = signals[index];
    if (!signal) return;
    for (const candidate of result.items) {
      if (candidate.name === source.name) continue;
      const entry = scored.get(candidate.name) ?? { package: candidate, score: 0, reasons: [] };
      entry.score += signal.weight;
      entry.reasons.push(signal.reason);
      scored.set(candidate.name, entry);
    }
  });
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.package.name.localeCompare(b.package.name))
    .slice(0, Math.max(1, Math.min(limit, 50)));
}
