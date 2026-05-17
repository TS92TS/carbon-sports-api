// File: functions/api/get-next-match.js
// Optimized Edge Caching Framework with Closed CORS Permissions

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
  "http://localhost:8788",               // Wrangler Pages dev
  "http://localhost:3000",               // Standard Vite dev port
  "http://localhost:5173",               // Alternate Vite dev port
  "null",                                // Allows local file:// browser inspection
];

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": allowOrigin,
  };
}

// Cache freshness window: 60 minutes
const CACHE_TTL_MS = 3_600_000;
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

  // 2. Inbound loop protection
  if (request.headers.get(LOOP_HEADER) === "true") {
    return new Response(JSON.stringify({ error: "Loop detected" }), {
      status: 403,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }

  const KV = env.MATCH_KV;
  const API_KEY = env.FOOTBALL_DATA_API_KEY;

  if (!KV || !API_KEY) {
    return new Response(JSON.stringify({ error: "CONFIG_MISSING" }), {
      status: 500,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }

  // 3. Evaluate Edge Cache (Stale-While-Revalidate Framework)
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

  // 4. If cache is fresh, return immediately — zero downstream calls
  if (isFresh && cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Fresh",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // 5. If cache is stale or missing, return stale data and update in background
  if (cached) {
    context.waitUntil(refreshUpstream(KV, API_KEY));
    return new Response(cached, {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Stale",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // 6. Hard Cache Miss — block execution to perform live data build
  return fetchUpstream(request, KV, API_KEY);
}

/**
 * Background refresh workflow
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
 * Blocking upstream fetch handler
 */
async function fetchUpstream(request, KV, API_KEY) {
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

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        ...getCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Data-Source": "Live",
      },
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { ...getCorsHeaders(request), "Content-Type": "application/json" },
    });
  }
}

/**
 * Upstream pipeline data construction
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

  // Preserve clear mapping rules to avoid layout text breaking on the front-end
  function formatMatch(m) {
    return {
      datetimeIso: m.utcDate,
      teamA: { 
        name: m.homeTeam?.name ?? "",  // Returns full readable country name (e.g. "England")
        tla: m.homeTeam?.tla ?? "",    // Retains short code signature for filtering references
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
