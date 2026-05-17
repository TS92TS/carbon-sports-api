// File: functions/api/get-next-match.js
// Dual-Layer Edge Caching Framework (CDN Cache API + Global KV Store)
// Locks down CORS permissions and prevents background cache stampedes.

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Requested-With",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

// === ORIGIN SECURITY LOCKDOWN ===
const ALLOWED_ORIGINS = [
  "https://carbonfootball.co.uk",
  "https://welovecarbon.com",
  "https://carbonfootball.pages.dev",
  "https://ts92ts.github.io",
  "http://localhost:8788",                // Wrangler Pages dev
  "http://localhost:3000",                // Standard Vite dev port
  "http://localhost:5173",                // Alternate Vite dev port
  "null",                                 // Allows local file:// browser inspection
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": allowOrigin,
  };
}

// Caching parameters
const CACHE_TTL_MS = 3600000; // 60 minutes KV freshness window
const LOOP_HEADER = "X-Loop-Protection";
const MAX_SUB_REQUESTS = 5;

export async function onRequest(context) {
  const { request, env } = context;

  // 1. Handle Preflight Options Request
  if (request.method === "OPTIONS") {
    return new Response(null, { 
      status: 204, 
      headers: getCorsHeaders(request) 
    });
  }

  // 2. Inbound Loop Protection
  if (request.headers.get(LOOP_HEADER) === "true") {
    return new Response(JSON.stringify({ error: "Loop detected" }), {
      status: 403,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }

  // =========================================================================
  // === LAYER 1: CDN EDGE CACHE API SHIELD (PREVENTS THUNDERING HERD) ===
  // =========================================================================
  const cacheUrl = new URL(request.url);
  cacheUrl.search = ""; // Normalize cache key by stripping query/cache-busting parameters
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;

  try {
    const edgeCachedResponse = await cache.match(cacheKey);
    if (edgeCachedResponse) {
      // Return edge-cached response immediately.
      // Zero Worker compute execution, zero KV reads, zero background stampedes.
      return edgeCachedResponse;
    }
  } catch (cacheErr) {
    console.warn("CDN Edge Cache API split state or unavailable");
  }
  // =========================================================================

  const KV = env.MATCH_KV;
  const API_KEY = env.FOOTBALL_DATA_API_KEY;

  if (!KV || !API_KEY) {
    return new Response(JSON.stringify({ error: "CONFIG_MISSING" }), {
      status: 500,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }

  // 3. Evaluate Layer 2: KV Store
  let cached = null;
  let cacheMeta = null;
  let isFresh = false;

  try {
    const kvResult = await KV.getWithMetadata("LATEST_MATCH");
    cached = kvResult?.value;
    cacheMeta = kvResult?.metadata;

    if (cached && cacheMeta?.updatedAt) {
      const ageMs = Date.now() - new Date(cacheMeta.updatedAt).getTime();
      isFresh = ageMs < CACHE_TTL_MS;
    }
  } catch (kvErr) {
    console.warn("KV read failed:", kvErr);
  }

  // 4. KV Fresh Cache Path
  if (isFresh && cached) {
    const freshResponse = new Response(cached, {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Fresh",
        "Cache-Control": "public, max-age=300", // Cache at CDN layer for 5 minutes
      },
    });

    // Populate Layer 1 CDN memory so subsequent concurrent hits never execute the worker script
    context.waitUntil(cache.put(cacheKey, freshResponse.clone()));
    return freshResponse;
  }

  // 5. KV Stale Path -> Background Revalidate
  if (cached) {
    context.waitUntil(refreshUpstream(KV, API_KEY));
    
    const staleResponse = new Response(cached, {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Stale",
        "Cache-Control": "public, max-age=60", // Throttle concurrent stampedes down to 60-second intervals
      },
    });

    // Populate Layer 1 CDN memory briefly to anchor background execution
    context.waitUntil(cache.put(cacheKey, staleResponse.clone()));
    return staleResponse;
  }

  // 6. Hard Cache Miss Path (Blocking Live Build)
  return fetchUpstream(context, KV, API_KEY, cache, cacheKey);
}

/**
 * Asynchronous Background Refresh Pipeline
 */
async function refreshUpstream(KV, API_KEY) {
  try {
    const payload = await fetchFromFootballData(API_KEY);
    await KV.put("LATEST_MATCH", JSON.stringify(payload), {
      metadata: { updatedAt: new Date().toISOString() },
    });
  } catch (err) {
    console.warn("Background refresh failed:", err.message);
  }
}

/**
 * Blocking Upstream Fetch Handler (Executed only when KV is empty)
 */
async function fetchUpstream(context, KV, API_KEY, cache, cacheKey) {
  const { request } = context;
  let subRequestCount = 0;
  
  const incrementAndCheck = () => {
    subRequestCount++;
    if (subRequestCount > MAX_SUB_REQUESTS) {
      throw new Error("CIRCUIT_BREAKER_TRIGGERED");
    }
  };

  try {
    incrementAndCheck();
    const payload = await fetchFromFootballData(API_KEY);

    try {
      incrementAndCheck();
      await KV.put("LATEST_MATCH", JSON.stringify(payload), {
        metadata: { updatedAt: new Date().toISOString() },
      });
    } catch (kvErr) {
      console.warn("KV write failed:", kvErr);
    }

    const liveResponse = new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "Live",
        "Cache-Control": "public, max-age=300",
      },
    });

    // Seed Layer 1 CDN memory right away safely using the inherited context
    context.waitUntil(cache.put(cacheKey, liveResponse.clone()));
    return liveResponse;

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }
}

/**
 * Upstream API Payload Construction
 */
async function fetchFromFootballData(API_KEY) {
  const API_URL = "https://api.football-data.org/v4/competitions/2000/matches";

  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      "X-Auth-Token": API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "SportsBar-Worker/1.0",
    },
    signal: AbortSignal.timeout(4000),
  });

  if (!response.ok) {
    throw new Error(`API_STATUS_${response.status}`);
  }

  const data = await response.json();
  const now = new Date();
  const allMatches = Array.isArray(data.matches) ? data.matches : [];
  const futureMatches = allMatches.filter((m) => new Date(m.utcDate) > now);

  function formatMatch(m) {
    return {
      datetimeIso: m.utcDate,
      id: `${m.utcDate?.slice(0, 10)}_${m.homeTeam?.tla ?? "TBD"}_VS_${m.awayTeam?.tla ?? "TBD"}`,
      teamA: { 
        name: m.homeTeam?.name ?? "",  
        tla: m.homeTeam?.tla ?? "",    
        flag: m.homeTeam?.crest ?? "" 
      },
      teamB: { 
        name: m.awayTeam?.name ?? "", 
        tla: m.awayTeam?.tla ?? "",
        flag: m.awayTeam?.crest ?? "" 
      },
      badge: m.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
    };
  }

  if (futureMatches.length === 0) {
    return { status: "concluded", updatedAt: new Date().toISOString() };
  }

  const featured = futureMatches[0];
  const formattedFeatured = formatMatch(featured);

  return {
    status: "upcoming",
    badge: featured.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
    datetimeIso: featured.utcDate,
    teamA: formattedFeatured.teamA,
    teamB: formattedFeatured.teamB,
    upcoming: futureMatches.map((m) => formatMatch(m)),
    england: futureMatches
      .filter((m) => m.homeTeam?.tla === "ENG" || m.awayTeam?.tla === "ENG")
      .map((m) => formatMatch(m)),
    updatedAt: new Date().toISOString(),
  };
}
