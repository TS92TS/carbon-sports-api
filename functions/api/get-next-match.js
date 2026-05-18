// File: functions/api/get-next-match.js
// Dual-Layer Edge Caching Framework (CDN Cache API + Global KV Store)
// Strict CORS partitioning — the CDN cache stores a "naked" payload (no
// ACAO) and per-request responses are rebuilt with the calling origin's
// headers so one origin's cold-fill cannot poison another origin's hit.

const CORS_BASE_HEADERS = {
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
// Local wrangler & build servers
  "http://localhost:8788",
  "http://127.0.0.1:8788",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  
  // VS Code Live Server / Five Server Defaults
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:5501",
  "http://127.0.0.1:5501",
  "null",                                 // Allows local file:// browser inspection
];

/**
 * Builds CORS headers for THIS request only. Origins not on the allow-list
 * receive a response with NO Access-Control-Allow-Origin header — the
 * browser then blocks the response. We never echo an unauthorised origin,
 * and we never default to a "safe" allow-listed origin: that legacy
 * fallback was what made the CDN cache poisonable in the first place.
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = { ...CORS_BASE_HEADERS };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// Caching parameters
const CACHE_TTL_MS = 3600000; // 60 minutes KV freshness window
const LOOP_HEADER = "X-Loop-Protection";
const MAX_SUB_REQUESTS = 5;

/**
 * Build the response sent to the client. CORS headers are synthesised at
 * response time using the current caller's Origin — never cached.
 */
function buildClientResponse(request, body, source, maxAgeSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      ...getCorsHeaders(request),
      "Content-Type": "application/json",
      "X-Data-Source": source,
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    },
  });
}

/**
 * Build the "naked" Response stored in caches.default. No CORS headers —
 * those are per-request and synthesised by buildClientResponse on every
 * hit. The X-Data-Source marker rides along so cache hits can faithfully
 * report whether the underlying body was originally KV-Fresh / KV-Stale /
 * Live. The Cache-Control on this shell controls how long the CDN itself
 * retains it before re-invoking the Worker.
 */
function buildCacheableShell(body, source, maxAgeSeconds) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "X-Data-Source": source,
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  // 1. Handle Preflight Options Request
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
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
  // Stores a naked payload (no ACAO) — per-request CORS is rebuilt below so
  // origin A's cold-fill never serves the wrong header to origin B.
  // =========================================================================
  const cacheUrl = new URL(request.url);
  cacheUrl.search = ""; // Normalize cache key by stripping cache-busting parameters
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const cache = caches.default;

  try {
    const edgeCachedShell = await cache.match(cacheKey);
    if (edgeCachedShell) {
      // Read body + provenance from the cached shell, rebuild the response
      // with THIS request's CORS headers. Zero KV reads, zero background
      // refresh, zero risk of serving a foreign origin's ACAO.
      const body = await edgeCachedShell.text();
      const source = edgeCachedShell.headers.get("X-Data-Source") || "Edge-Cache";
      // Mirror the underlying shell's freshness window to the browser so a
      // stale-anchored hit doesn't extend client-side staleness to 5 min.
      const maxAge = source === "KV-Stale" ? 60 : 300;
      return buildClientResponse(request, body, source, maxAge);
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
      // Hardened parse: rejects NaN, future-clock skew, and garbage strings
      // so a corrupted metadata write can never silently pass the gate.
      const updatedAtMs = Date.parse(cacheMeta.updatedAt);
      if (Number.isFinite(updatedAtMs)) {
        const ageMs = Date.now() - updatedAtMs;
        isFresh = ageMs >= 0 && ageMs < CACHE_TTL_MS;
      }
    }
  } catch (kvErr) {
    console.warn("KV read failed:", kvErr);
  }

  // 4. KV Fresh Cache Path
  if (isFresh && cached) {
    // Seed the CDN cache with a naked shell so subsequent concurrent hits
    // never execute the worker. The client-bound response is built
    // separately so its CORS headers are scoped to THIS request only.
    context.waitUntil(cache.put(cacheKey, buildCacheableShell(cached, "KV-Fresh", 300)));
    return buildClientResponse(request, cached, "KV-Fresh", 300);
  }

  // 5. KV Stale Path -> Background Revalidate
  if (cached) {
    // OPTIMIZATION FIXED: Write the 60s cache anchor FIRST to instantly seal the micro-window
    context.waitUntil(cache.put(cacheKey, buildCacheableShell(cached, "KV-Stale", 60)));
    
    // Kick off the slow background network call safely behind the shield
    context.waitUntil(refreshUpstream(KV, API_KEY));
    
    return buildClientResponse(request, cached, "KV-Stale", 60);
  }

  // 6. Hard Cache Miss Path (Blocking Live Build)
  return fetchUpstream(context, KV, API_KEY, cache, cacheKey);
}

/**
 * Asynchronous Background Refresh Pipeline.
 * Fires from `context.waitUntil` on the stale path — write-only, never
 * responds to the client. Errors are swallowed because the stale payload
 * already shipped.
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
 * Blocking Upstream Fetch Handler (Executed only when KV is empty).
 * MAX_SUB_REQUESTS is a per-invocation guardrail against a future fan-out
 * bug inside this function — it cannot prevent cross-invocation stampedes.
 * Cross-invocation defence is the CDN cache anchor + the stale-path
 * background refresh, both of which fire eagerly via context.waitUntil.
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
    const bodyString = JSON.stringify(payload);

    try {
      incrementAndCheck();
      await KV.put("LATEST_MATCH", bodyString, {
        metadata: { updatedAt: new Date().toISOString() },
      });
    } catch (kvErr) {
      console.warn("KV write failed:", kvErr);
    }

    // Seed CDN cache with the naked shell; client response carries this
    // caller's CORS headers built freshly via buildClientResponse.
    context.waitUntil(cache.put(cacheKey, buildCacheableShell(bodyString, "Live", 300)));
    return buildClientResponse(request, bodyString, "Live", 300);
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
        flag: m.homeTeam?.crest ?? "",
      },
      teamB: {
        name: m.awayTeam?.name ?? "",
        tla: m.awayTeam?.tla ?? "",
        flag: m.awayTeam?.crest ?? "",
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
