/* eslint-disable no-console */

/**
 * Research grounding without a search-engine tool.
 *
 * MiniMax-M3 has no built-in web grounding, so the research pass reads real
 * pages itself: a Hacker News Algolia search finds stories on the topic, the
 * top articles are fetched and reduced to readable text, and the excerpts go
 * into the prompt as the only material a fact may cite. A topic that is itself
 * a URL is fetched directly.
 *
 * Every failure is contained. A page that times out, refuses the request, or
 * returns a JavaScript shell is skipped, and the caller gets whatever was
 * readable, possibly nothing. Nothing here invents content: an ungrounded pass
 * that says so is acceptable, a fabricated source is not.
 */

export interface ResearchSource {
  title: string;
  url: string;
  excerpt: string;
  /** Hacker News score, when the source came from a search hit. */
  points?: number;
  via: "hacker-news" | "direct";
}

export interface GatherSourcesOptions {
  /**
   * Asked for extra search queries when none of the heuristic ones finds a
   * linked story. Pass 1 supplies MiniMax-M3 here; tests leave it unset.
   */
  suggestQueries?: (topic: string) => Promise<string[]>;
  /** Article pages to keep (default 3). */
  maxSources?: number;
  /** Characters of readable text kept per page (default 6000). */
  maxCharsPerSource?: number;
  /** Timeout for the search request and for each page fetch (default 12 s). */
  signalTimeoutMs?: number;
}

export const HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search";
export const HN_HITS_PER_PAGE = 8;
/** Below this many readable characters a page is a paywall, a consent wall, or a JavaScript shell. */
export const MIN_READABLE_CHARS = 400;
/** Algolia rejects very long queries, and a pasted article makes a poor one anyway. */
export const MAX_QUERY_CHARS = 200;

const USER_AGENT = "InterdimensionalCable/1.0 (+show-research)";
const DEFAULT_MAX_SOURCES = 3;
const DEFAULT_MAX_CHARS = 6000;
const DEFAULT_TIMEOUT_MS = 12_000;

interface HnHit {
  title?: string | null;
  url?: string | null;
  points?: number | null;
}

interface FetchedPage {
  title?: string;
  text: string;
}

const ENTITIES: Record<string, string> = {
  "nbsp": " ",
  "amp": "&",
  "quot": "\"",
  "#39": "'",
  "lt": "<",
  "gt": ">",
};

/**
 * Reduces an HTML document to its readable prose, the way the show workflow
 * already reads news links: script, style and noscript bodies go first (tag
 * stripping alone would leave minified JS behind as if it were article text),
 * then the tags, then the common entities and runs of whitespace.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/g, (_, name: string) => ENTITIES[name] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True for a single absolute http(s) URL with nothing else around it. */
export function isHttpUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\/\S+$/i.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The URL a topic asks to be read, if any: either the topic is a bare URL or
 * it starts with a "URL: https://..." line, which is how the show workflow
 * hands over a news link together with its extracted text.
 */
export function extractTopicUrl(topic: string): string | undefined {
  const trimmed = topic.trim();
  if (isHttpUrl(trimmed)) {
    return trimmed;
  }
  const prefixed = trimmed.match(/^URL:\s*(https?:\/\/\S+)/i);
  if (prefixed && isHttpUrl(prefixed[1])) {
    return prefixed[1];
  }
  return undefined;
}

/** The exact string sent to the search API for a topic, so it can be reported honestly. */
export function toSearchQuery(topic: string): string {
  return topic.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "in",
  "on",
  "at",
  "to",
  "for",
  "from",
  "by",
  "with",
  "about",
  "into",
  "over",
  "why",
  "how",
  "what",
  "when",
  "where",
  "who",
  "which",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "it's",
  "your",
  "you",
  "yours",
  "our",
  "their",
  "they",
  "them",
  "we",
  "us",
  "i",
  "me",
  "my",
  "every",
  "eventually",
  "always",
  "never",
  "just",
  "really",
  "very",
  "also",
  "than",
  "then",
  "so",
  "as",
  "if",
  "not",
  "no",
  "do",
  "does",
  "did",
  "doing",
  "can",
  "could",
  "will",
  "would",
  "should",
  "may",
  "might",
  "up",
  "down",
  "out",
  "all",
  "any",
  "some",
  "more",
  "most",
  "much",
  "many",
  "one",
  "two",
  "new",
  "old",
  "big",
  "little",
  "plotting",
  "kitchen",
  // Topic filler that never appears in a headline.
  "strangest",
  "strange",
  "strangely",
  "weird",
  "weirdest",
  "wild",
  "wildest",
  "crazy",
  "craziest",
  "true",
  "truth",
  "things",
  "thing",
  "facts",
  "fact",
  "stuff",
  "actually",
  "secretly",
  "surprising",
  "surprisingly",
  "story",
  "stories",
  "behind",
  "inside",
  "explained",
  "everything",
  "nobody",
  "everyone",
  "tells",
  "tell",
  "know",
  "knows",
]);

/** Short tokens worth keeping even though they fail the length check. */
const SHORT_KEEP = new Set(["ai", "ml", "vr", "ar", "3d", "5g", "gpu", "llm", "api", "ios", "cpu", "nft", "ceo", "eu", "us", "uk"]);

/**
 * Search queries to try, most specific first. A full sentence rarely matches a
 * Hacker News title, so the fallbacks shorten it: the first clause, then the
 * content words, then the first three of those.
 */
export function searchQueryCandidates(topic: string): string[] {
  const full = toSearchQuery(topic);
  const firstClause = full.split(/[,:;?!]| \band\b | \bbecause\b /)[0]?.trim() ?? "";
  const words = full
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => (w.length > 2 || SHORT_KEEP.has(w)) && !STOPWORDS.has(w));
  const compact = words.slice(0, 5).join(" ");
  const shortest = words.slice(0, 3).join(" ");
  const seen = new Set<string>();
  return [full, firstClause, compact, shortest]
    .map(q => q.trim())
    .filter(q => q.length > 0 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
}

export interface GatherSourcesResult {
  sources: ResearchSource[];
  /** Every query actually sent to Hacker News, in order. */
  queriesTried: string[];
  /** The query that produced the sources, when one did. */
  queryUsed?: string;
}

function looksTextual(contentType: string | null): boolean {
  if (!contentType) {
    return true;
  }
  const type = contentType.toLowerCase();
  return type.includes("text") || type.includes("html") || type.includes("xml");
}

function readTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? stripHtml(match[1]) : "";
  return title.length > 0 ? title.slice(0, 200) : undefined;
}

/**
 * Fetches one page and returns its readable text, or null for anything that
 * cannot be used: a network failure, a timeout, a non-2xx status, a binary
 * body, or too little prose to ground anything.
 */
async function fetchReadablePage(url: string, timeoutMs: number, maxChars: number): Promise<FetchedPage | null> {
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    if (!response.ok) {
      console.warn(`[research:sources] ${url} returned HTTP ${response.status}; skipping`);
      return null;
    }
    if (!looksTextual(response.headers.get("content-type"))) {
      console.warn(`[research:sources] ${url} is ${response.headers.get("content-type")}; skipping`);
      return null;
    }
    const html = await response.text();
    const text = stripHtml(html);
    if (text.length < MIN_READABLE_CHARS) {
      console.warn(`[research:sources] ${url} yielded ${text.length} readable characters; skipping`);
      return null;
    }
    return { title: readTitle(html), text: text.slice(0, maxChars) };
  } catch (err) {
    console.warn(`[research:sources] Could not read ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function searchHackerNews(query: string, timeoutMs: number): Promise<HnHit[]> {
  const url = `${HN_SEARCH_URL}?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${HN_HITS_PER_PAGE}`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      console.warn(`[research:sources] Hacker News search returned HTTP ${response.status}`);
      return [];
    }
    const body = await response.json() as { hits?: unknown };
    return Array.isArray(body.hits) ? body.hits as HnHit[] : [];
  } catch (err) {
    console.warn(`[research:sources] Hacker News search failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Finds and reads sources for a topic. Never throws; an empty array means the
 * research pass has to run on the model's own knowledge and say so.
 */
export async function gatherSources(topic: string, options: GatherSourcesOptions = {}): Promise<ResearchSource[]> {
  return (await gatherSourcesDetailed(topic, options)).sources;
}

export async function gatherSourcesDetailed(topic: string, options: GatherSourcesOptions = {}): Promise<GatherSourcesResult> {
  const maxSources = Math.max(1, Math.floor(options.maxSources ?? DEFAULT_MAX_SOURCES));
  const maxChars = Math.max(1, Math.floor(options.maxCharsPerSource ?? DEFAULT_MAX_CHARS));
  const timeoutMs = Math.max(1, Math.floor(options.signalTimeoutMs ?? DEFAULT_TIMEOUT_MS));

  const directUrl = extractTopicUrl(topic);
  if (directUrl) {
    const page = await fetchReadablePage(directUrl, timeoutMs, maxChars);
    if (!page) {
      return { sources: [], queriesTried: [directUrl] };
    }
    return {
      sources: [{ title: page.title ?? new URL(directUrl).hostname, url: directUrl, excerpt: page.text, via: "direct" }],
      queriesTried: [directUrl],
      queryUsed: directUrl,
    };
  }

  const queriesTried: string[] = [];
  const seen = new Set<string>();
  const candidates: Array<{ title: string; url: string; points?: number }> = [];
  let query = "";
  const queue = searchQueryCandidates(topic);
  let askedModel = false;
  while (queue.length > 0) {
    const candidateQuery = queue.shift()!;
    if (queriesTried.some(q => q.toLowerCase() === candidateQuery.toLowerCase())) {
      continue;
    }
    queriesTried.push(candidateQuery);
    for (const hit of await searchHackerNews(candidateQuery, timeoutMs)) {
      const url = typeof hit.url === "string" ? hit.url.trim() : "";
      if (!isHttpUrl(url) || seen.has(url)) {
        continue;
      }
      seen.add(url);
      candidates.push({
        title: typeof hit.title === "string" && hit.title.trim() ? hit.title.trim() : new URL(url).hostname,
        url,
        points: typeof hit.points === "number" ? hit.points : undefined,
      });
    }
    if (candidates.length > 0) {
      query = candidateQuery;
      break;
    }
    // Heuristics exhausted: let the model phrase the search the way a headline would.
    if (queue.length === 0 && !askedModel && options.suggestQueries) {
      askedModel = true;
      try {
        const suggested = (await options.suggestQueries(topic))
          .map(q => q.replace(/\s+/g, " ").trim().slice(0, 80))
          .filter(q => q.length > 0)
          .slice(0, 4);
        queue.push(...suggested);
      } catch (err) {
        console.warn(`[research:sources] query suggestion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (candidates.length === 0) {
    console.log(`[research:sources] no linked Hacker News stories for ${queriesTried.map(q => `"${q.slice(0, 60)}"`).join(", ")}`);
    return { sources: [], queriesTried };
  }

  // A couple of spares cover the paywalled or script-only pages that get
  // skipped, without reading the whole result page for three excerpts.
  const attempted = candidates.slice(0, maxSources + 2);
  const pages = await Promise.all(attempted.map(candidate => fetchReadablePage(candidate.url, timeoutMs, maxChars)));

  const sources: ResearchSource[] = [];
  for (let i = 0; i < attempted.length && sources.length < maxSources; i++) {
    const page = pages[i];
    if (!page) {
      continue;
    }
    sources.push({
      title: attempted[i].title,
      url: attempted[i].url,
      excerpt: page.text,
      points: attempted[i].points,
      via: "hacker-news",
    });
  }

  console.log(`[research:sources] "${query.slice(0, 80)}": ${candidates.length} stories with links, ${attempted.length} read, ${sources.length} usable`);
  return { sources, queriesTried, queryUsed: sources.length > 0 ? query : undefined };
}
