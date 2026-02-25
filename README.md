#Deploy Status

[![Netlify Status](https://api.netlify.com/api/v1/badges/d4eaedf7-0646-4ebd-b9c1-c2312179f86d/deploy-status)](https://app.netlify.com/projects/checkonews/deploys)

# Checko Intelligence Hub 🛡️

> Daily AI-curated anti-counterfeiting news aggregator for [Checko.ai](https://checko.ai)

Built with: **Netlify Scheduled Functions** · **Netlify Blobs** · **NewsAPI** · **GNews** · **RSS Feeds** · **GPT-4o-mini** · **GitHub Actions**

---

## Architecture Overview

```
GitHub (source) ──push──► Netlify (host)
                                │
              ┌─────────────────┼─────────────────────┐
              │                 │                      │
    Scheduled Function     Edge Function          Static Site
    fetch-news.mjs         get-news.mjs           public/index.html
    (runs 6AM IST)         (serves /api/news)     (reads /api/news)
              │
    ┌─────────┴──────────┐
    │  Sources fetched:  │
    │  • NewsAPI         │
    │  • GNews           │
    │  • RSS: WIPO       │
    │  • RSS: INTERPOL   │
    │  • RSS: US CBP     │
    │  • RSS: IP Watchdog│
    │  • + more          │
    └────────────────────┘
              │
         GPT-4o-mini
         (top 3 picks)
              │
        Netlify Blobs
        (stores JSON)
              │
         Frontend
         (renders)
```

**Key design principle: API keys live only in Netlify environment variables — never in the browser.**

---

## Deployment Guide

### Step 1 — Fork / Clone the Repository

```bash
# Option A: Clone directly
git clone https://github.com/YOUR_USERNAME/checko-news.git
cd checko-news

# Option B: Create new repo and push
git init
git add .
git commit -m "feat: initial Checko Intelligence Hub"
gh repo create checko-news --public --push
```

---

### Step 2 — Create Netlify Site from GitHub

1. Go to [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an existing project**
2. Select **GitHub** → Authorise → choose your `checko-news` repository
3. Configure build settings:
   | Setting | Value |
   |---|---|
   | Base directory | *(leave blank)* |
   | Build command | `echo 'Static site'` |
   | Publish directory | `public` |
4. Click **Deploy site**

---

### Step 3 — Set Environment Variables in Netlify

Go to **Site settings → Environment variables → Add variable** for each:

| Variable | Value | Where to get it |
|---|---|---|
| `NEWS_API_KEY` | Your NewsAPI key | [newsapi.org](https://newsapi.org) — free plan: 100 req/day |
| `GNEWS_API_KEY` | Your GNews key | [gnews.io](https://gnews.io) — free plan: 100 req/day |
| `OPENAI_API_KEY` | `sk-...` | [platform.openai.com](https://platform.openai.com) |
| `RSS2JSON_KEY` | *(optional)* | [rss2json.com](https://rss2json.com) — free tier works without key |

> **Tip:** After adding env vars, trigger a new deploy for them to take effect.

---

### Step 4 — Enable Netlify Blobs

Netlify Blobs is enabled automatically on deploy. No extra steps needed.
The scheduled function writes to a blob named `news-data/latest` and the edge function reads from it.

---

### Step 5 — Trigger the First News Fetch

The scheduled function runs at **00:30 UTC (6:00 AM IST)** daily. For the first load:

**Option A — Netlify dashboard:**
- Go to **Functions** tab → find `fetch-news` → click **Invoke**

**Option B — Netlify CLI:**
```bash
npm install
netlify login
netlify link  # link to your site
netlify functions:invoke fetch-news
```

**Option C — Re-deploy** (triggers GitHub Actions which calls the build hook):
```bash
git commit --allow-empty -m "chore: trigger initial news fetch"
git push
```

---

### Step 6 — Set Up GitHub Actions Secret

GitHub Actions serves as a **backup scheduler** that triggers a Netlify build hook daily.

1. In Netlify: **Site settings → Build & deploy → Build hooks** → Create hook named `github-daily-trigger` → copy the URL
2. In GitHub repo: **Settings → Secrets → Actions** → New secret:
   - Name: `NETLIFY_BUILD_HOOK_URL`
   - Value: the hook URL you just copied
3. The workflow in `.github/workflows/daily-refresh.yml` runs at 00:30 UTC automatically

---

## Local Development

```bash
npm install
cp .env.example .env  # add your keys
netlify dev           # starts local dev server with functions
```

Visit `http://localhost:8888`

---

## News Sources

| Source | Type | Categories | Notes |
|---|---|---|---|
| **NewsAPI** | REST API | All | Free: 100 req/day, 1-month history |
| **GNews** | REST API | All | Free: 100 req/day, diverse global sources |
| **WIPO RSS** | RSS | Regulation & IP | Official UN IP agency |
| **INTERPOL RSS** | RSS | Counterfeiting | Law enforcement news |
| **US CBP RSS** | RSS | Counterfeiting | U.S. Customs seizure news |
| **IP Watchdog** | RSS | Brand Protection | Leading IP law blog |
| **Supply Chain Dive** | RSS | Supply Chain | Industry news |
| **MIT Tech Review** | RSS | Technology | Emerging tech coverage |
| **Business of Fashion** | RSS | Luxury & Retail | Luxury counterfeiting |

---

## Scheduled Refresh — How It Works

```
00:30 UTC (06:00 IST)
        │
        ├── Netlify Scheduled Function fires automatically
        │   └── fetch-news.mjs runs
        │       ├── Fetches NewsAPI (6 queries)
        │       ├── Fetches GNews (6 queries)
        │       ├── Fetches 9 RSS feeds via rss2json
        │       ├── Deduplicates ~100+ articles
        │       ├── Calls GPT-4o-mini → selects Top 3
        │       └── Writes result to Netlify Blobs
        │
        └── GitHub Actions workflow fires (backup)
            └── POSTs to Netlify build hook
```

Frontend loads `/api/news` → edge function reads from Netlify Blobs → returns JSON → page renders.

---

## File Structure

```
checko-news/
├── public/
│   └── index.html              # Frontend (reads /api/news)
├── netlify/
│   └── functions/
│       ├── fetch-news.mjs      # Scheduled: fetches + AI pick + stores
│       └── get-news.mjs        # Edge: serves /api/news from Blobs
├── .github/
│   └── workflows/
│       └── daily-refresh.yml   # GitHub Actions backup scheduler
├── netlify.toml                # Netlify config
├── package.json
└── README.md
```

---

## Customising Categories & Sources

Edit `CATEGORIES` array in `netlify/functions/fetch-news.mjs`:

```js
{
  id: "pharma",
  label: "Pharmaceutical Counterfeiting",
  icon: "💊",
  newsApiQuery: "counterfeit medicine pharma drug fake",
  gnewsQuery: "fake medicine pharmaceutical counterfeit",
  rssFeeds: [
    "https://www.who.int/rss-feeds/news-english.xml",
    "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml"
  ]
}
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| `/api/news` returns 404 | Trigger the scheduled function manually first |
| "NewsAPI source not available" | Free NewsAPI plan doesn't support all domains from production — upgrade to Developer plan |
| GNews returns empty | Check `GNEWS_API_KEY` in Netlify env vars |
| AI picks missing | Check `OPENAI_API_KEY` in Netlify env vars |
| Function timeout | Netlify free functions have 10s limit; scheduled functions have 15min — this project uses scheduled so it's fine |

---

## Built for Checko.ai

> Checko builds the world's first 100% copy-proof, tamper-proof anti-counterfeiting labels using 3D PUF (Physically Unclonable Functions) technology, founded at IIT Kanpur.

[checko.ai](https://checko.ai)
