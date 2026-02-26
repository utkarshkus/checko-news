/**
 * Netlify Scheduled Function — runs daily at 6:00 AM IST (00:30 UTC)
 * Geography: INDIA-FOCUSED
 * Sources: NewsAPI (India queries), GNews (India queries), Indian RSS feeds
 */

import { schedule } from "@netlify/functions";
import { getStore }  from "@netlify/blobs";

// ─── ENV ─────────────────────────────────────────────────────────────────────
const NEWS_API_KEY    = process.env.NEWS_API_KEY;
const GNEWS_API_KEY   = process.env.GNEWS_API_KEY;
const OPENAI_KEY      = process.env.OPENAI_API_KEY;
const NETLIFY_SITE_ID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
const NETLIFY_TOKEN   = process.env.NETLIFY_TOKEN   || process.env.TOKEN;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS   = 12_000;
const MAX_RESPONSE_BYTES = 5_242_880; // 5 MB
const MAX_TITLE_LEN      = 300;
const MAX_DESC_LEN       = 500;
const GNEWS_DELAY_MS     = 1_200; // avoid 429 on free tier

// ─── INDIA-FOCUSED CATEGORIES ────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: "counterfeiting",
    label: "Counterfeiting & Seizures",
    icon: "⚠️",
    // NewsAPI: India-specific enforcement, customs, DGGI raids
    newsApiQuery: "counterfeit fake goods seized India customs DGGI raid",
    gnewsQuery: "counterfeit seized India customs",
    rssFeeds: [
      "https://economictimes.indiatimes.com/rssfeedstopstories.cms",   // Economic Times
      "https://www.business-standard.com/rss/home_page_top_stories.rss", // Business Standard
    ],
  },
  {
    id: "brand-protection",
    label: "Brand Protection",
    icon: "🛡️",
    newsApiQuery: "brand protection trademark infringement India anti-counterfeiting",
    gnewsQuery: "brand protection trademark India infringement",
    rssFeeds: [
      "https://spicyip.com/feed",          // SpicyIP — India's #1 IP law blog
      "https://www.barandbench.com/feed",  // Bar & Bench — Indian legal news
    ],
  },
  {
    id: "supply-chain",
    label: "Supply Chain Security",
    icon: "🔗",
    newsApiQuery: "supply chain India traceability serialisation product authentication",
    gnewsQuery: "supply chain India traceability authentication",
    rssFeeds: [
      "https://www.livemint.com/rss/industry",                          // Mint Industry
      "https://www.thehindubusinessline.com/economy/?service=rss",      // Hindu BusinessLine
    ],
  },
  {
    id: "technology",
    label: "Authentication Technology",
    icon: "💡",
    newsApiQuery: "QR code NFC RFID authentication India startup product verification",
    gnewsQuery: "authentication technology India QR NFC startup",
    rssFeeds: [
      "https://inc42.com/feed/",     // Inc42 — Indian tech & startups
      "https://yourstory.com/feed",  // YourStory — Indian entrepreneurship
    ],
  },
  {
    id: "regulation",
    label: "Regulation & IP",
    icon: "⚖️",
    newsApiQuery: "intellectual property India trademark patent enforcement IPAB court",
    gnewsQuery: "intellectual property India trademark patent law",
    rssFeeds: [
      "https://spicyip.com/feed",                                        // SpicyIP (IP-focused)
      "https://www.livelaw.in/feed",                                     // Live Law — Indian courts
    ],
  },
  {
    id: "luxury",
    label: "Luxury, Pharma & Retail",
    icon: "💎",
    newsApiQuery: "fake counterfeit medicines pharma luxury retail India FSSAI drug",
    gnewsQuery: "counterfeit medicine pharma fake luxury India",
    rssFeeds: [
      "https://www.financialexpress.com/feed/",   // Financial Express
      "https://www.moneycontrol.com/rss/results.xml", // Moneycontrol
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

function decodeEntities(s) {
  return s
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
}

function sanitiseText(raw, maxLen = MAX_DESC_LEN) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  // Decode entities FIRST so &lt;figure&gt; becomes <figure> before stripping
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, " ");
  // Decode and strip again for double-encoded content
  s = decodeEntities(s);
  s = s.replace(/<[^>]*>/g, " ");
  s = s.replace(/\b(javascript|vbscript|data):/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  // Last resort: if URL/attribute fragments remain, strip them
  if (s.includes("src=") || s.includes("href=") || s.includes("://")) {
    s = s.replace(/\S*[:=/]\S*/g, "").replace(/\s+/g, " ").trim();
  }
  return s.slice(0, maxLen);
}

// ─── SAFE FETCH ──────────────────────────────────────────────────────────────

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

// ─── NATIVE RSS PARSER ───────────────────────────────────────────────────────

function parseRSS(xml, feedUrl) {
  const items = [];
  let feedTitle = "";

  const chanTitle = xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([\s\S]*?))<\/title>/i);
  if (chanTitle) feedTitle = sanitiseText(chanTitle[1] || chanTitle[2], 80);
  if (!feedTitle) {
    try { feedTitle = new URL(feedUrl).hostname; } catch { feedTitle = feedUrl; }
  }

  const itemRegex = /<(?:item|entry)[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const getTag = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, "i");
      const m = block.match(re);
      return m ? (m[1] || m[2] || "").trim() : "";
    };
    const getAttr = (tag, attr) => {
      const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i");
      const m = block.match(re);
      return m ? m[1].trim() : "";
    };

    const title       = sanitiseText(getTag("title"), MAX_TITLE_LEN);
    const link        = getTag("link") || getAttr("link", "href") || getTag("id");
    const description = sanitiseText(
      getTag("description") || getTag("summary") || getTag("content:encoded") || getTag("content"),
      MAX_DESC_LEN
    );
    const pubDate  = getTag("pubDate") || getTag("published") || getTag("updated") || "";
    const rawImg   = getAttr("enclosure", "url") || getAttr("media:content", "url") || "";
    const imageUrl = sanitiseImageUrl(rawImg);

    if (!title || !link) continue;
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
    headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
               "User-Agent": "Checko-NewsBot/1.0" }
  });
  if (!result.ok) { console.error(`RSS [${feedUrl}]:`, result.error); return []; }
  try { return parseRSS(result.text, feedUrl); }
  catch (err) { console.error(`RSS parse [${feedUrl}]:`, err.message); return []; }
}

// ─── NEWS API (India domain filter) ─────────────────────────────────────────

async function fetchNewsAPI(query) {
  if (!NEWS_API_KEY) return [];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "en");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "10");
  // Restrict to Indian news domains
  url.searchParams.set("domains",
    "timesofindia.indiatimes.com,economictimes.indiatimes.com,business-standard.com," +
    "livemint.com,thehindu.com,hindustantimes.com,financialexpress.com,ndtv.com,moneycontrol.com"
  );
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

// ─── GNEWS (India country filter) ───────────────────────────────────────────

async function fetchAllGNews(queries) {
  if (!GNEWS_API_KEY) return {};
  const results = {};
  for (const query of queries) {
    const url = new URL("https://gnews.io/api/v4/search");
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "en");
    url.searchParams.set("country", "in"); // India only
    url.searchParams.set("max", "5");
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
    await new Promise((r) => setTimeout(r, GNEWS_DELAY_MS));
  }
  return results;
}

// ─── PARALLEL CATEGORY FETCH ─────────────────────────────────────────────────

async function fetchAllCategories() {
  const gnewsQueries = CATEGORIES.map((c) => c.gnewsQuery);
  const gnewsByQuery = await fetchAllGNews(gnewsQueries);

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

  const seen = new Set();
  const dedupedAll = allArticles.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id); return true;
  });

  return { byCategory, dedupedAll };
}

// ─── AI PICKS ────────────────────────────────────────────────────────────────

// Keywords that indicate an article is genuinely relevant to anti-counterfeiting.
// Used to pre-score articles before sending to AI, ensuring the pool is high-quality.
const RELEVANCE_KEYWORDS = [
  // Core topic
  "counterfeit", "fake", "spurious", "duplicate", "imitation", "knockoff", "piracy", "pirated",
  "forgery", "forged", "adulterated", "substandard",
  // Enforcement
  "seized", "raid", "bust", "arrest", "crackdown", "enforcement", "confiscated", "nabbed",
  "DGGI", "customs", "CDSCO", "FSSAI", "IPR", "trademark infringement",
  // Brand & IP
  "brand protection", "intellectual property", "trademark", "patent", "copyright",
  "anti-counterfeiting", "authentication", "verification", "traceability",
  // Technology
  "QR code", "NFC", "RFID", "hologram", "PUF", "blockchain", "serialisation", "track and trace",
  // Sectors
  "pharma", "medicine", "drug", "luxury", "FMCG", "agri", "pesticide", "fertiliser",
  // India-specific
  "India", "Indian",
];

function scoreArticle(article) {
  const text = `${article.title} ${article.description}`.toLowerCase();
  return RELEVANCE_KEYWORDS.reduce((score, kw) => {
    return score + (text.includes(kw.toLowerCase()) ? 1 : 0);
  }, 0);
}

async function selectAIPicks(allArticles) {
  if (!OPENAI_KEY) { console.warn("OPENAI_API_KEY not set."); return []; }

  // [FIX 3] Guarantee category diversity: take top 4 by relevance score from each category
  // then sort the combined pool by score DESC and take top 30
  const scoredByCategory = {};
  for (const article of allArticles) {
    const cat = article.categoryId;
    if (!scoredByCategory[cat]) scoredByCategory[cat] = [];
    scoredByCategory[cat].push({ ...article, _score: scoreArticle(article) });
  }

  const candidatePool = [];
  for (const cat of Object.keys(scoredByCategory)) {
    const top = scoredByCategory[cat]
      .filter((a) => a.publishedAt)
      .sort((a, b) => b._score - a._score || new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 4); // top 4 per category
    candidatePool.push(...top);
  }

  // [FIX 1] Sort combined pool by relevance score, break ties by recency
  const pool = candidatePool
    .sort((a, b) => b._score - a._score || new Date(b.publishedAt) - new Date(a.publishedAt))
    .slice(0, 30);

  if (!pool.length) return [];

  console.log(`🎯 Pool relevance scores: min=${pool.at(-1)._score} max=${pool[0]._score} avg=${(pool.reduce((s,a)=>s+a._score,0)/pool.length).toFixed(1)}`);

  // [FIX 5] Send up to 400 chars of description so AI has real context
  const articleList = pool.map((a, i) =>
    `${i + 1}. [${a.categoryLabel}] ${a.title}\n   Source: ${a.source} | Score: ${a._score}\n   ${a.description.slice(0, 400)}`
  ).join("\n\n");

  // [FIX 6] Split into system + user messages for better gpt-4o-mini performance
  const systemPrompt = `You are the Chief Intelligence Analyst at Checko.ai — India's anti-counterfeiting company that builds 100% copy-proof, tamper-proof labels using 3D PUF (Physically Unclonable Functions) technology, founded at IIT Kanpur.

Your job is to curate the 3 most important news stories each day for Checko's audience:
- Brand owners and manufacturers fighting fakes in India
- IP lawyers and trademark professionals
- Customs officers, DGGI, FSSAI, and drug enforcement agencies
- Retail and pharma companies protecting their supply chains
- Investors and policy makers in the anti-counterfeiting space

STRICT SELECTION RULES:
1. Only pick articles that are DIRECTLY about: counterfeiting, fake goods, IP enforcement, brand protection, authentication technology, supply chain security, trademark/patent law, or product fraud.
2. REJECT articles about general business news, stock markets, earnings, macroeconomics, or politics UNLESS they have a clear and specific connection to counterfeiting or IP protection.
3. Prioritise articles with a specific India angle — raids, court rulings, Indian brands, Indian regulatory action.
4. If fewer than 3 articles meet the relevance bar, return only the ones that do. Never force a connection.
5. The "whyItMatters" field must cite a SPECIFIC implication — never write generic statements like "this affects brand owners."`;

  const userPrompt = `From the articles below, select up to 3 that best meet your selection rules. Each article has a relevance Score (higher = more on-topic).

For each selected article return:
- articleIndex: the 1-based number from the list (must be between 1 and ${pool.length})
- headline: sharp, specific rewritten headline (max 120 chars) — avoid clickbait
- summary: exactly 2 sentences covering what happened and who is affected (max 300 chars)
- whyItMatters: 1 specific sentence — cite a concrete implication for brand owners, enforcers, or consumers in India (max 200 chars)
- category: precise topic tag e.g. "Pharma Raid India", "Trademark Ruling", "QR Authentication"

[FIX 4] If an article is not genuinely about counterfeiting or IP protection, do NOT include it.

Respond ONLY with valid compact JSON, no markdown:
{"picks":[{"articleIndex":1,"headline":"...","summary":"...","whyItMatters":"...","category":"..."}]}

ARTICLES:
${articleList}`;

  const result = await safeFetchJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      // [FIX 6] System + user message split
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.2,  // lower = more deterministic, less hallucination
      max_tokens: 1000,  // slightly more room for 3 detailed picks
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
        console.warn(`Invalid articleIndex: ${pick.articleIndex}`);
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

const handler = schedule("30 0 * * *", async () => {
  const startMs = Date.now();
  console.log("🔄 Checko news fetch starting (India-focused)…");

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
