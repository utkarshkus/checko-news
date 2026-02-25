/**
 * Netlify Edge Function — GET /api/news
 * Reads latest news JSON from Netlify Blobs and returns it to the frontend.
 *
 * Audit fixes applied:
 *  [P8] ETag header based on fetchedAt timestamp for conditional requests
 *  [S1] CORS wildcard documented — acceptable for a public read-only feed
 */

import { getStore } from "@netlify/blobs";

export default async (request, context) => {
  // [S1] Wildcard CORS is intentional — this is a public read-only news feed.
  // No sensitive data is returned; no credentials are involved.
  const baseHeaders = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age":       "86400",
  };

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: baseHeaders });
  }

  // Only allow GET
  if (request.method !== "GET") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { ...baseHeaders, Allow: "GET, OPTIONS" } }
    );
  }

  try {
    const store = getStore("news-data");
    const data  = await store.get("latest", { type: "json" });

    if (!data) {
      return new Response(
        JSON.stringify({ error: "Feed not yet available. Scheduled fetch may not have run." }),
        { status: 404, headers: baseHeaders }
      );
    }

    // [P8] ETag based on fetchedAt — enables browser/CDN conditional requests
    const etag = `"${Buffer.from(data.fetchedAt || "").toString("base64").slice(0, 16)}"`;
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: { ...baseHeaders, ETag: etag },
      });
    }

    const body = JSON.stringify(data);
    return new Response(body, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Cache-Control":  "public, max-age=3600, stale-while-revalidate=86400",
        "ETag":           etag,                           // [P8]
        "Last-Modified":  new Date(data.fetchedAt).toUTCString(),
        "Content-Length": String(Buffer.byteLength(body, "utf8")),
      },
    });
  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error" }), // [S1] Don't leak err.message
      { status: 500, headers: baseHeaders }
    );
  }
};

export const config = {
  path: "/api/news",
};
