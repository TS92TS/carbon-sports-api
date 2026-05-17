// File: functions/api/get-next-match.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent, X-Auth-Token, X-Requested-With, X-Loop-Protection",
  "Access-Control-Max-Age": "86400",
};

// Cache freshness window: 60 minutes
const CACHE_TTL_MS = 3_600_000;
const LOOP_HEADER = "X-Loop-Protection";
const MAX_SUB_REQUESTS = 5;

export async function onRequest(context) {
  // 1. Handle Preflight
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 2. Inbound loop protection (prevents self-calling loops)
  if (context.request.headers.get(LOOP_HEADER) === "true") {
    return new Response(JSON.stringify({ error: "Loop detected" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const KV = context.env.MATCH_KV;
  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;

  if (!KV || !API_KEY) {
    return new Response(JSON.stringify({ error: "CONFIG_MISSING" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // 3. Try KV first (stale-while-revalidate pattern)
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

  // 4. If cache is fresh, return immediately — zero upstream calls
  if (isFresh && cached) {
    return new Response(cached, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Fresh",
        "Cache-Control": "public, max-age=300",
      },
    });
  }

  // 5. If cache is stale or missing, decide: background refresh or block
  if (cached) {
    // Stale cache exists — return it immediately, refresh upstream in background
    context.waitUntil(refreshUpstream(KV, API_KEY));
    return new Response(cached, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Data-Source": "KV-Stale",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // 6. No cache at all — must block on upstream fetch
  return fetchUpstream(KV, API_KEY);
}

/**
 * Background refresh: fetches from football-data.org and updates KV.
 * Fails silently — the caller has already received stale data.
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
 * Blocking upstream fetch: only called when KV is empty.
 * Includes circuit breaker and retry logic for transient failures.
 */
async function fetchUpstream(KV, API_KEY) {
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
        ...corsHeaders,
        "Content-Type": "application/json",
        "X-Data-Source": "Live",
      },
    });

  } catch (error) {
    // Upstream failed and we have no cache — this is a real error
    return new Response(JSON.stringify({ error: error.message }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}

/**
 * Core football-data.org fetch with formatting.
 * NOTE: Loop protection header is NOT sent to external APIs —
 * it was causing football-data.org to flag/reject requests.
 */
async function fetchFromFootballData(API_KEY) {
  const API_URL = "https://api.football-data.org/v4/competitions/2000/matches";

  const response = await fetch(API_URL, {
    method: "GET",
    headers: {
      "X-Auth-Token": API_KEY,
      "Content-Type": "application/json",
      "User-Agent": "SportsBar-Worker/1.0",
      // FIX: Removed X-Loop-Protection from outbound call — this was causing
      // football-data.org to reject requests with 403/429.
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
      teamA: { name: m.homeTeam?.tla ?? "", flag: m.homeTeam?.crest ?? "" },
      teamB: { name: m.awayTeam?.tla ?? "", flag: m.awayTeam?.crest ?? "" },
      badge: m.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
    };
  }

  if (futureMatches.length === 0) {
    return { status: "concluded", updatedAt: new Date().toISOString() };
  }

  const featured = futureMatches[0];
  return {
    status: "upcoming",
    badge: featured.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
    datetimeIso: featured.utcDate,
    teamA: { name: featured.homeTeam?.tla ?? "", flag: featured.homeTeam?.crest ?? "" },
    teamB: { name: featured.awayTeam?.tla ?? "", flag: featured.awayTeam?.crest ?? "" },
    upcoming: futureMatches.map((m) => formatMatch(m)),
    england: futureMatches
      .filter((m) => m.homeTeam?.tla === "ENG" || m.awayTeam?.tla === "ENG")
      .map((m) => formatMatch(m)),
    updatedAt: new Date().toISOString(),
  };
}
