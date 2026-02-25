/**
 * Netlify Scheduled Function — runs daily at 6:00 AM IST (00:30 UTC)
 * Sources: NewsAPI, GNews, RSS via rss2json (WIPO, Interpol, CBP, IP Watchdog, etc.)
 * Writes pre-built JSON to Netlify Blobs → served by get-news.mjs edge function
 *
 * Audit fixes applied:
 *  [P1] All 6 categories fetched in PARALLEL via Promise.allSettled
 *  [P2] AbortSignal.timeout(10_000) on ALL external fetch calls via safeFetch()
 *  [P3] Pool sorted by publishedAt DESC before sending to AI
 *  [S5] Response size guard (5 MB cap) before .json() on every call
 *  [S6] Multi-pass HTML sanitiser strips tags, entities, and dangerous URIs
 *  [S7] imageUrl validated to be http/https only before storing
 *  [S10] AI articleIndex bounds-checked before array access
 *  [S11] AI response validated: picks must be Array, length capped at 3
 */

import { schedule } from "@netlify/functions";
import { getStore }  from "@netlify/blobs";

const NEWS_API_KEY  = process.env.NEWS_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
const RSS2JSON_KEY  = process.env.RSS2JSON_KEY;

const FETCH_TIMEOUT_MS    = 10_000;
const MAX_RESPONSE_BYTES  = 5_242_880; // 5 MB
const MAX_TITLE_LEN       = 300;
const MAX_DESC_LEN        = 500;

const CATEGORIES = [
  {
    id: "counterfeiting",
    label: "Counterfeiting & Seizures",
    icon: "⚠️",
    newsApiQuery: "counterfeiting fake goods seized customs",
    gnewsQuery: "counterfeit goods seized",
    rssFeeds: [
      "https://www.cbp.gov/newsroom/rss-feeds/trade-news",
      "https://www.interpol.int/en/News-and-Events/News/rss",
    ],
  },
  {
    id: "brand-protection",
    label: "Brand Protection",
    icon: "🛡️",
    newsApiQuery: "brand protection anti-counterfeiting authentication label trademark",
    gnewsQuery: "brand protection trademark infringement",
    rssFeeds: ["https://ipwatchdog.com/feed/"],
  },
  {
    id: "supply-chain",
    label: "Supply Chain Security",
    icon: "🔗",
    newsApiQuery: "supply chain integrity traceability serialisation blockchain",
    gnewsQuery: "supply chain traceability product authentication",
    rssFeeds: ["https://www.supplychaindive.com/feeds/news/"],
  },
  {
    id: "technology",
    label: "Authentication Technology",
    icon: "💡",
    newsApiQuery: "QR code NFC RFID PUF authentication product verification technology",
    gnewsQuery: "anti-counterfeiting technology authentication QR NFC",
    rssFeeds: ["https://www.technologyreview.com/feed/"],
  },
  {
    id: "regulation",
    label: "Regulation & IP",
    icon: "⚖️",
    newsApiQuery: "intellectual property trademark counterfeit regulation enforcement WTO WIPO",
    gnewsQuery: "intellectual property law counterfeit regulation",
    rssFeeds: ["https://www.wipo.int/pressroom/en/articles/rss.xml"],
  },
  {
    id: "luxury",
    label: "Luxury, Pharma & Retail",
    icon: "💎",
    newsApiQuery: "luxury goods fake counterfeit pharma medicine retail fashion",
    gnewsQuery: "counterfeit luxury pharma fake medicines retail",
    rssFeeds: ["https://www.businessoffashion.com/rss"],
  },
];

// [S7] Only allow http/https image URLs
function sanitiseImageUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? raw : null;
  } catch {
    return null;
  }
}

// [S6] Multi-pass text sanitiser
function sanitiseText(raw, maxLen = MAX_DESC_LEN) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
  s = s.replace(/\b(javascript|vbscript|data):/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, maxLen);
}

// [P2][S5] Guarded fetch with timeout + size cap
async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const contentLength = Number(r.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES)
      return { ok: false, error: `Content-Length too large: ${contentLength}` };
    const blob = await r.blob();
    if (blob.size > MAX_RESPONSE_BYTES)
      return { ok: false, error: `Body too large: ${blob.size}` };
    const data = JSON.parse(await blob.text());
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message };
  }
}

async function fetchNewsAPI(query) {
  if (!NEWS_API_KEY) return [];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("apiKey", NEWS_API_KEY);
  const result = await safeFetch(url.toString());
  if (!result.ok) { console.error(`NewsAPI [${query}]:`, result.error); return []; }
  return (result.data.articles || [])
    .filter((a) => a.title && a.url && a.title !== "[Removed]")
    .map((a) => ({
      id: a.url,
      title: sanitiseText(a.title, MAX_TITLE_LEN),
      description: sanitiseText(a.description),
      url: a.url,
      imageUrl: sanitiseImageUrl(a.urlToImage),
      source: sanitiseText(a.source?.name || "NewsAPI", 80),
      publishedAt: a.publishedAt || null,
      sourceType: "newsapi",
    }));
}

async function fetchGNews(query) {
  if (!GNEWS_API_KEY) return [];
  const url = new URL("https://gnews.io/api/v4/search");
  url.searchParams.set("q", query);
  url.searchParams.set("lang", "en");
  url.searchParams.set("max", "10");
  url.searchParams.set("token", GNEWS_API_KEY);
  const result = await safeFetch(url.toString());
  if (!result.ok) { console.error(`GNews [${query}]:`, result.error); return []; }
  return (result.data.articles || [])
    .filter((a) => a.title && a.url)
    .map((a) => ({
      id: a.url,
      title: sanitiseText(a.title, MAX_TITLE_LEN),
      description: sanitiseText(a.description),
      url: a.url,
      imageUrl: sanitiseImageUrl(a.image),
      source: sanitiseText(a.source?.name || "GNews", 80),
      publishedAt: a.publishedAt || null,
      sourceType: "gnews",
    }));
}

async function fetchRSSFeed(feedUrl) {
  const apiUrl = new URL("https://api.rss2json.com/v1/api.json");
  apiUrl.searchParams.set("rss_url", feedUrl);
  apiUrl.searchParams.set("count", "8");
  if (RSS2JSON_KEY) apiUrl.searchParams.set("api_key", RSS2JSON_KEY);
  const result = await safeFetch(apiUrl.toString());
  if (!result.ok) { console.error(`RSS [${feedUrl}]:`, result.error); return []; }
  if (result.data.status !== "ok") return [];
  let hostname = feedUrl;
  try { hostname = new URL(feedUrl).hostname; } catch {}
  return (result.data.items || [])
    .filter((i) => i.title && i.link)
    .map((i) => ({
      id: i.link,
      title: sanitiseText(i.title, MAX_TITLE_LEN),
      description: sanitiseText(i.description),
      url: i.link,
      imageUrl: sanitiseImageUrl(i.thumbnail || i.enclosure?.link || null),
      source: sanitiseText(result.data.feed?.title || hostname, 80),
      publishedAt: i.pubDate || new Date().toISOString(),
      sourceType: "rss",
    }));
}

// [P1] All categories fetched in parallel
async function fetchAllCategories() {
  const results = await Promise.allSettled(
    CATEGORIES.map(async (cat) => {
      const [newsApiResults, gnewsResults, ...rssResults] = await Promise.all([
        fetchNewsAPI(cat.newsApiQuery),
        fetchGNews(cat.gnewsQuery),
        ...cat.rssFeeds.map(fetchRSSFeed),
      ]);
      const combined = [...newsApiResults, ...gnewsResults, ...rssResults.flat()];
      const seen = new Set();
      const deduped = combined.filter((a) => {
        if (seen.has(a.id)) return false;
        seen.add(a.id); return true;
      });
      return {
        cat,
        articles: deduped.map((a) => ({
          ...a,
          categoryId:    cat.id,
          categoryLabel: cat.label,
          categoryIcon:  cat.icon,
        })),
      };
    })
  );

  const byCategory = {};
  const allArticles = [];
  for (const r of results) {
    if (r.status === "rejected") { console.error("Category failed:", r.reason); continue; }
    const { cat, articles } = r.value;
    byCategory[cat.id] = articles;
    allArticles.push(...articles);
  }
  // Global dedupe
  const seen = new Set();
  const dedupedAll = allArticles.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id); return true;
  });
  return { byCategory, dedupedAll };
}

async function selectAIPicks(allArticles) {
  if (!OPENAI_KEY) { console.warn("OPENAI_API_KEY not set — skipping AI picks."); return []; }

  // [P3] Sort by freshness DESC, top 30
  const pool = [...allArticles]
    .filter((a) => a.publishedAt)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 30);

  if (!pool.length) return [];

  const articleList = pool.map((a, i) =>
    `${i + 1}. [${a.categoryLabel}] ${a.title}\n   Source: ${a.source}\n   Summary: ${a.description.slice(0, 200)}`
  ).join("\n\n");

  const prompt = `You are an expert analyst in anti-counterfeiting, brand protection, and supply chain security for Checko.ai — a company building the world's first 100% copy-proof, tamper-proof labels using 3D PUF technology, founded at IIT Kanpur.

Select the TOP 3 most impactful and relevant stories for brand owners, IP professionals, customs regulators, and consumers fighting counterfeit goods.

For each pick:
- articleIndex: 1-based index (must be between 1 and ${pool.length})
- headline: rewritten headline (max 120 chars)
- summary: 2-sentence summary (max 300 chars)
- whyItMatters: 1 sentence relevance to anti-counterfeiting (max 200 chars)
- category: short label e.g. "Pharma Counterfeiting"

Respond ONLY with valid compact JSON:
{"picks":[{"articleIndex":1,"headline":"...","summary":"...","whyItMatters":"...","category":"..."}]}

Articles:
${articleList}`;

  const result = await safeFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 900,
    }),
  });

  if (!result.ok) { console.error("OpenAI error:", result.error); return []; }

  try {
    const text = result.data.choices?.[0]?.message?.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in AI response");
    const parsed = JSON.parse(jsonMatch[0]);

    // [S11] Validate structure
    if (!Array.isArray(parsed.picks)) throw new Error("picks is not an array");

    return parsed.picks
      .slice(0, 3) // enforce max 3
      .map((pick) => {
        // [S10] Bounds-check index
        const idx = Number(pick.articleIndex);
        if (!Number.isInteger(idx) || idx < 1 || idx > pool.length) {
          console.warn(`AI returned out-of-bounds articleIndex: ${pick.articleIndex}`);
          return null;
        }
        return {
          articleIndex: idx,
          headline:     sanitiseText(pick.headline, 120),
          summary:      sanitiseText(pick.summary, 300),
          whyItMatters: sanitiseText(pick.whyItMatters, 200),
          category:     sanitiseText(pick.category, 60),
          article:      pool[idx - 1],
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("AI parse error:", err.message);
    return [];
  }
}

const handler = schedule("30 0 * * *", async () => {
  const startMs = Date.now();
  console.log("🔄 Checko news fetch starting…");

  const { byCategory, dedupedAll } = await fetchAllCategories();
  const aiPicks = await selectAIPicks(dedupedAll);

  const output = {
    fetchedAt:     new Date().toISOString(),
    totalArticles: dedupedAll.length,
    durationMs:    Date.now() - startMs,
    aiPicks,
    byCategory,
  };

  const store = getStore("news-data");
  await store.setJSON("latest", output);

  console.log(`✅ Done in ${output.durationMs}ms. ${dedupedAll.length} articles, ${aiPicks.length} AI picks stored.`);
  return { statusCode: 200 };
});

export { handler };
