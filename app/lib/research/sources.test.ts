import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractTopicUrl,
  gatherSources,
  HN_SEARCH_URL,
  isHttpUrl,
  MAX_QUERY_CHARS,
  MIN_READABLE_CHARS,
  stripHtml,
  toSearchQuery,
} from "./sources";

/** A page with enough prose to count as readable, plus the junk that must not leak into an excerpt. */
function articleHtml(title: string, sentences = 40): string {
  const body = Array.from({ length: sentences }, (_, i) => `Paragraph ${i + 1} about ${title} says something concrete.`).join(" ");
  return `<!doctype html><html><head><title>${title} | Example</title>
<style>.hero { color: red }</style>
<script>function track(){ window.__x = 1; }</script>
</head><body><nav><a href="/">Home</a></nav><main><h1>${title}</h1><p>${body}</p><p>Sound &amp; fury, &quot;quoted&quot;.</p></main>
<noscript>Enable JavaScript to continue</noscript></body></html>`;
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

describe("research sources: pure helpers", () => {
  it("reduces a page to readable prose the way the show workflow reads news links", () => {
    const text = stripHtml(articleHtml("Toaster Firmware", 3));
    expect(text).not.toContain("function track");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("<");
    expect(text).toContain("Toaster Firmware | Example Home Toaster Firmware Paragraph 1");
    expect(text).toContain("Sound & fury, \"quoted\".");
    expect(text).not.toContain("Enable JavaScript");
  });

  it("recognises a bare URL and the workflow's URL-prefixed topic", () => {
    expect(isHttpUrl("https://example.com/story")).toBe(true);
    expect(isHttpUrl("  http://example.com  ")).toBe(true);
    expect(isHttpUrl("example.com/story")).toBe(false);
    expect(isHttpUrl("ftp://example.com/story")).toBe(false);
    expect(isHttpUrl("https://example.com is down")).toBe(false);

    expect(extractTopicUrl("https://example.com/story")).toBe("https://example.com/story");
    expect(extractTopicUrl("URL: https://example.com/story\n\nContent: pasted text")).toBe("https://example.com/story");
    expect(extractTopicUrl("Autonomous toasters")).toBeUndefined();
  });

  it("collapses and caps the search query so it can be reported honestly", () => {
    expect(toSearchQuery("  Autonomous   AI\nToasters ")).toBe("Autonomous AI Toasters");
    expect(toSearchQuery("x".repeat(500))).toHaveLength(MAX_QUERY_CHARS);
  });
});

describe("gatherSources", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("searches Hacker News and reads the top linked stories in rank order", async () => {
    const hits = [
      { title: "Toasters gain sentience", url: "https://a.example/story", points: 300 },
      { title: "Ask HN: toasters?", points: 50 }, // no link, skipped
      { title: "Paywalled toaster exposé", url: "https://c.example/paywall", points: 120 },
      { title: "Toaster firmware deep dive", url: "https://d.example/firmware", points: 80 },
      { title: "Kevin's diner napkin", url: "https://e.example/napkin", points: 40 },
      { title: "Another toaster story", url: "https://f.example/more", points: 10 },
    ];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith(HN_SEARCH_URL)) {
        return jsonResponse({ hits });
      }
      if (url === "https://c.example/paywall") {
        return htmlResponse("<html><body><p>Subscribe to continue reading.</p></body></html>");
      }
      return htmlResponse(articleHtml(new URL(url).hostname));
    });

    const sources = await gatherSources("Autonomous AI Toasters", { maxCharsPerSource: 1200 });

    const searchUrl = requestedUrls()[0];
    expect(searchUrl).toContain(`${HN_SEARCH_URL}?query=Autonomous%20AI%20Toasters`);
    expect(searchUrl).toContain("tags=story");
    expect(searchUrl).toContain("hitsPerPage=8");

    expect(sources.map(s => s.url)).toEqual([
      "https://a.example/story",
      "https://d.example/firmware",
      "https://e.example/napkin",
    ]);
    expect(sources[0]).toMatchObject({ title: "Toasters gain sentience", points: 300, via: "hacker-news" });
    for (const source of sources) {
      expect(source.excerpt.length).toBeGreaterThanOrEqual(MIN_READABLE_CHARS);
      expect(source.excerpt.length).toBeLessThanOrEqual(1200);
      expect(source.excerpt).not.toContain("function track");
    }

    // Every page request identifies itself and carries a timeout signal.
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain("Ask HN");
      const headers = init?.headers as Record<string, string>;
      expect(headers["User-Agent"]).toMatch(/InterdimensionalCable/);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("never throws for a page that fails and returns whatever was readable", async () => {
    const hits = [
      { title: "Network error", url: "https://a.example/down" },
      { title: "Server error", url: "https://b.example/500" },
      { title: "Readable", url: "https://c.example/ok" },
      { title: "A PDF", url: "https://d.example/report.pdf" },
    ];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith(HN_SEARCH_URL)) {
        return jsonResponse({ hits });
      }
      if (url.endsWith("/down")) {
        throw new TypeError("fetch failed");
      }
      if (url.endsWith("/500")) {
        return htmlResponse("<html><body>oops</body></html>", 500);
      }
      if (url.endsWith(".pdf")) {
        return new Response("%PDF-1.4 ".repeat(200), { status: 200, headers: { "content-type": "application/pdf" } });
      }
      return htmlResponse(articleHtml("Readable"));
    });

    const sources = await gatherSources("toasters");

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://c.example/ok");
  });

  it("returns an empty array when the search itself fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(gatherSources("toasters")).resolves.toEqual([]);

    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    await expect(gatherSources("toasters")).resolves.toEqual([]);

    fetchMock.mockResolvedValue(jsonResponse({ hits: [] }));
    await expect(gatherSources("toasters")).resolves.toEqual([]);
    await expect(gatherSources("   ")).resolves.toEqual([]);
  });

  it("fetches a topic that is itself a URL directly, without searching", async () => {
    fetchMock.mockImplementation(async input => htmlResponse(articleHtml(`Article at ${new URL(String(input)).hostname}`)));

    const sources = await gatherSources("https://news.example/story");

    expect(requestedUrls()).toEqual(["https://news.example/story"]);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      url: "https://news.example/story",
      title: "Article at news.example | Example",
      via: "direct",
    });
    expect(sources[0].points).toBeUndefined();

    fetchMock.mockClear();
    const prefixed = await gatherSources("URL: https://news.example/other\n\nContent: pasted article text");
    expect(requestedUrls()).toEqual(["https://news.example/other"]);
    expect(prefixed[0]?.via).toBe("direct");
  });

  it("reports nothing for a direct URL that cannot be read", async () => {
    fetchMock.mockResolvedValue(htmlResponse("<html><body>Please enable JavaScript.</body></html>"));
    await expect(gatherSources("https://spa.example/app")).resolves.toEqual([]);
  });

  it("honours maxSources and maxCharsPerSource", async () => {
    const hits = [
      { title: "One", url: "https://a.example/1" },
      { title: "Two", url: "https://b.example/2" },
      { title: "Three", url: "https://c.example/3" },
    ];
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      return url.startsWith(HN_SEARCH_URL) ? jsonResponse({ hits }) : htmlResponse(articleHtml(url));
    });

    const sources = await gatherSources("toasters", { maxSources: 1, maxCharsPerSource: 450 });

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("https://a.example/1");
    expect(sources[0].excerpt).toHaveLength(450);
  });

  it("gives up on a page that hangs past the timeout", async () => {
    fetchMock.mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
    }));

    const started = Date.now();
    await expect(gatherSources("https://slow.example/page", { signalTimeoutMs: 30 })).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
