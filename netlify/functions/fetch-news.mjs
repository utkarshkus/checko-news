/**
 * Netlify Scheduled Function — runs daily at 6:00 AM IST (00:30 UTC)
 *
 * Fixes applied in this version:
 *  [F1] GNews 429 — sequential calls with 1s delay instead of parallel
 *  [F2] RSS 422 — parse RSS feeds directly (no rss2json proxy needed)
 *  [F3] Blobs MissingBlobsEnvironmentError — pass siteID + token explicitly
 */

import { schedule } from "@netlify/functions";
import { getStore }  from "@netlify/blobs";

// ─── ENV ─────────────────────────────────────────────────────────────────────
const NEWS_API_KEY  = process.env.NEWS_API_KEY;
const GNEWS_API_KEY = process.env.GNEWS_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;
// [F3] Blobs needs these when invoked outside of the normal build/schedule context
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
const NETLIFY_TOKEN   = process.env.NETLIFY_TOKEN   || process.env.TOKEN;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS    = 12_000;
const MAX_RESPONSE_BYTES  = 5_242_880; // 5 MB
const MAX_TITLE_LEN       = 300;
const MAX_DESC_LEN        = 500;
// [F1] Delay between GNews requests to avoid 429 on free tier
const GNEWS_DELAY_MS      = 1_200;

// ─── CATEGORIES ──────────────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: "counterfeiting",
    label: "Counterfeiting & Seizures",
    icon: "⚠️",
    newsApiQuery: "counterfeiting fake goods seized customs",
    gnewsQuery: "counterfeit goods seized",
    // [F2] Direct RSS URLs — no proxy
    rssFeeds: [
      "https://www.ice.gov/news/releases.xml",          // US ICE — IP crime enforcement
      "https://www.europol.europa.eu/newsroom/rss",     // Europol operations
    ],
  },
  {
    id: "brand-protection",
    label: "Brand Protection",
    icon: "🛡️",
    newsApiQuery: "brand protection anti-counterfeiting authentication label trademark",
    gnewsQuery: "brand protection trademark infringement",
    rssFeeds: [
      "https://ipwatchdog.com/feed/",
    ],
  },
  {
    id: "supply-chain",
    label: "Supply Chain Security",
    icon: "🔗",
    newsApiQuery: "supply chain integrity traceability serialisation blockchain",
    gnewsQuery: "supply chain traceability product authentication",
    rssFeeds: [
      "https://www.supplychaindive.com/feeds/news/",
    ],
  },
  {
    id: "technology",
    label: "Authentication Technology",
    icon: "💡",
    newsApiQuery: "QR code NFC RFID PUF authentication product verification technology",
    gnewsQuery: "product authentication technology counterfeit",
    rssFeeds: [
      "https://www.technologyreview.com/feed/",
    ],
  },
  {
    id: "regulation",
    label: "Regulation & IP",
    icon: "⚖️",
    newsApiQuery: "intellectual property trademark counterfeit regulation enforcement WTO WIPO",
    gnewsQuery: "intellectual property law counterfeit regulation",
    rssFeeds: [
      "https://www.wipo.int/pressroom/en/rss.xml",      // WIPO pressroom (corrected path)
      "https://www.iam-media.com/rss.xml",              // IAM — IP management
    ],
  },
  {
    id: "luxury",
    label: "Luxury, Pharma & Retail",
    icon: "💎",
    newsApiQuery: "luxury goods fake counterfeit pharma medicine retail fashion",
    gnewsQuery: "counterfeit luxury pharma fake medicines",
    rssFeeds: [
      "https://www.thefashionlaw.com/feed/",            // Fashion Law — IP & counterfeiting
      "https://wwd.com/feed/",                          // WWD — luxury & fashion industry
    ],
  },
];

// ─── SECURITY HELPERS ────────────────────────────────────────────────────────

function sanitiseImageUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? raw : null;
  } catch { return null; }
}

function sanitiseText(raw, maxLen = MAX_DESC_LEN) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  s = s.replace(/<[^>]*>/g, " ");
  s = s
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
  s = s.replace(/\b(javascript|vbscript|data):/gi, "");
  return s.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

// ─── SAFE FETCH (timeout + size cap) ────────────────────────────────────────

async function safeFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const contentLength = Number(r.headers.get("content-length") || 0);
    if (contentLength > MAX_RESPONSE_BYTES)
      return { ok: false, error: `Content-Length too large` };
    const blob = await r.blob();
    if (blob.size > MAX_RESPONSE_BYTES)
      return { ok: false, error: `Body too large: ${blob.size}` };
    return { ok: true, text: await blob.text(), contentType: r.headers.get("content-type") || "" };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message };
  }
}

async function safeFetchJSON(url, options = {}) {
  const result = await safeFetch(url, options);
  if (!result.ok) return result;
  try {
    return { ok: true, data: JSON.parse(result.text) };
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err.message}` };
  }
}

// ─── [F2] NATIVE RSS PARSER ──────────────────────────────────────────────────
// Parses RSS/Atom XML directly — no third-party proxy required.

function parseRSS(xml, feedUrl) {
  const items = [];
  let feedTitle = "";

  // Extract feed title
  const chanTitle = xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i);
  if (chanTitle) feedTitle = sanitiseText(chanTitle[1], 80);
  if (!feedTitle) {
    try { feedTitle = new URL(feedUrl).hostname; } catch { feedTitle = feedUrl; }
  }

  // Match <item> or <entry> blocks (RSS 2.0 and Atom)
  const itemRegex = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const getTag = (tag) => {
      // Handle CDATA and plain text
      const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, "i");
      const m = block.match(re);
      return m ? (m[1] || m[2] || "").trim() : "";
    };

    const getAttr = (tag, attr) => {
      const re = new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, "i");
      const m = block.match(re);
      return m ? m[1].trim() : "";
    };

    const title       = sanitiseText(getTag("title"), MAX_TITLE_LEN);
    const link        = getTag("link") || getAttr("link", "href") || getTag("id");
    const description = sanitiseText(getTag("description") || getTag("summary") || getTag("content"), MAX_DESC_LEN);
    const pubDate     = getTag("pubDate") || getTag("published") || getTag("updated") || "";
    const rawImg      = getAttr("enclosure", "url") || getAttr("media:content", "url") || "";
    const imageUrl    = sanitiseImageUrl(rawImg);

    if (!title || !link) continue;

    // Validate link is a real URL
    try { new URL(link); } catch { continue; }

    let publishedAt = null;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d.getTime())) publishedAt = d.toISOString();
    }

    items.push({ id: link, title, description, url: link, imageUrl, source: feedTitle, publishedAt, sourceType: "rss" });
  }

  return items;
}

async function fetchRSSFeed(feedUrl) {
  const result = await safeFetch(feedUrl, {
    headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }
  });
  if (!result.ok) {
    console.error(`RSS [${feedUrl}]:`, result.error);
    return [];
  }
  try {
    return parseRSS(result.text, feedUrl);
  } catch (err) {
    console.error(`RSS parse [${feedUrl}]:`, err.message);
    return [];
  }
}

// ─── NEWS API ────────────────────────────────────────────────────────────────

async function fetchNewsAPI(query) {
  if (!NEWS_API_KEY) return [];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "10");
  url.searchParams.set("apiKey", NEWS_API_KEY);
  const result = await safeFetchJSON(url.toString());
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

// [F1] GNews sequential fetcher with delay to respect free-tier rate limits
async function fetchAllGNews(queries) {
  if (!GNEWS_API_KEY) return {};
  const results = {};
  for (const query of queries) {
    const url = new URL("https://gnews.io/api/v4/search");
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "en");
    url.searchParams.set("max", "5"); // reduced from 10 to be kinder to rate limits
    url.searchParams.set("token", GNEWS_API_KEY);
    const result = await safeFetchJSON(url.toString());
    if (!result.ok) {
      console.error(`GNews [${query}]:`, result.error);
      results[query] = [];
    } else {
      results[query] = (result.data.articles || [])
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
    // [F1] Wait between each GNews call to avoid 429
    await new Promise((r) => setTimeout(r, GNEWS_DELAY_MS));
  }
  return results;
}

// ─── PARALLEL CATEGORY FETCH ─────────────────────────────────────────────────

async function fetchAllCategories() {
  // [F1] Fetch all GNews queries sequentially first (rate-limit safe)
  const gnewsQueries  = CATEGORIES.map((c) => c.gnewsQuery);
  const gnewsByQuery  = await fetchAllGNews(gnewsQueries);

  // NewsAPI + RSS can still run in parallel (no shared rate limits)
  const results = await Promise.allSettled(
    CATEGORIES.map(async (cat) => {
      const [newsApiResults, ...rssResults] = await Promise.all([
        fetchNewsAPI(cat.newsApiQuery),
        ...cat.rssFeeds.map(fetchRSSFeed),
      ]);

      const gnewsResults = gnewsByQuery[cat.gnewsQuery] || [];
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

// ─── AI PICKS ────────────────────────────────────────────────────────────────

async function selectAIPicks(allArticles) {
  if (!OPENAI_KEY) { console.warn("OPENAI_API_KEY not set."); return []; }

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

  const result = await safeFetchJSON("https://api.openai.com/v1/chat/completions", {
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
    if (!Array.isArray(parsed.picks)) throw new Error("picks is not an array");

    return parsed.picks.slice(0, 3).map((pick) => {
      const idx = Number(pick.articleIndex);
      if (!Number.isInteger(idx) || idx < 1 || idx > pool.length) {
        console.warn(`Invalid articleIndex from AI: ${pick.articleIndex}`);
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
    }).filter(Boolean);
  } catch (err) {
    console.error("AI parse error:", err.message);
    return [];
  }
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

const handler = schedule("30 0 * * *", async (event, context) => {
  const startMs = Date.now();
  console.log("🔄 Checko news fetch starting…");

  const { byCategory, dedupedAll } = await fetchAllCategories();
  console.log(`📰 Fetched ${dedupedAll.length} articles across ${Object.keys(byCategory).length} categories`);

  const aiPicks = await selectAIPicks(dedupedAll);
  console.log(`🤖 AI selected ${aiPicks.length} picks`);

  const output = {
    fetchedAt:     new Date().toISOString(),
    totalArticles: dedupedAll.length,
    durationMs:    Date.now() - startMs,
    aiPicks,
    byCategory,
  };

  // [F3] Pass siteID + token explicitly so Blobs works in all invocation contexts
  const storeOptions = {};
  if (NETLIFY_SITE_ID && NETLIFY_TOKEN) {
    storeOptions.siteID = NETLIFY_SITE_ID;
    storeOptions.token  = NETLIFY_TOKEN;
  }

  const store = getStore({ name: "news-data", ...storeOptions });
  await store.setJSON("latest", output);

  console.log(`✅ Done in ${Date.now() - startMs}ms. ${dedupedAll.length} articles, ${aiPicks.length} AI picks stored.`);
  return { statusCode: 200 };
});

export { handler };
