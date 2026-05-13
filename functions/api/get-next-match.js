// File: functions/api/get-next-match.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent, X-Auth-Token, X-Requested-With, X-Loop-Protection",
  "Access-Control-Max-Age": "86400",
};

// 1. Loop Protection Configuration
const LOOP_HEADER = "X-Loop-Protection";

export async function onRequest(context) {
  // Handle Preflight
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // --- SAFETY CHECK: Inbound Loop Protection ---
  if (context.request.headers.get(LOOP_HEADER) === "true") {
    return new Response(JSON.stringify({ error: "Loop detected" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // --- SAFETY CHECK: Circuit Breaker Counter ---
  let subRequestCount = 0;
  const MAX_SUB_REQUESTS = 5;

  const incrementAndCheck = () => {
    subRequestCount++;
    if (subRequestCount > MAX_SUB_REQUESTS) {
      throw new Error("CIRCUIT_BREAKER_TRIGGERED");
    }
  };

  const KV = context.env.MATCH_KV;
  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;
  const API_URL = "https://api.football-data.org/v4/competitions/2000/matches";

  if (!KV || !API_KEY) {
    return new Response(JSON.stringify({ error: "CONFIG_MISSING" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // --- Live API Fetch ---
    incrementAndCheck(); // Counter: 1
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "SportsBar-Worker/1.0",
        [LOOP_HEADER]: "true", // Outbound loop protection
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) throw new Error(`API_STATUS_${response.status}`);

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

    let finalPayload;

    if (futureMatches.length === 0) {
      finalPayload = { status: "concluded", updatedAt: new Date().toISOString() };
    } else {
      const featured = futureMatches[0];
      finalPayload = {
        status: "upcoming",
        badge: featured.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
        datetimeIso: featured.utcDate,
        teamA: { name: featured.homeTeam?.tla ?? "", flag: featured.homeTeam?.crest ?? "" },
        teamB: { name: featured.awayTeam?.tla ?? "", flag: featured.awayTeam?.crest ?? "" },
        upcoming: futureMatches.slice(0, 10).map((m) => formatMatch(m)),
        england: futureMatches
          .filter((m) => m.homeTeam?.tla === "ENG" || m.awayTeam?.tla === "ENG")
          .slice(0, 4)
          .map((m) => formatMatch(m)),
        updatedAt: new Date().toISOString(),
      };
    }

    // --- KV Write ---
    try {
      incrementAndCheck(); // Counter: 2
      await KV.put("LATEST_MATCH", JSON.stringify(finalPayload));
    } catch (e) {
      console.warn("KV Write Fail:", e);
    }

    return new Response(JSON.stringify(finalPayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    // --- FAILSAFE: Serve from KV ---
    try {
      incrementAndCheck(); // Counter: 3 (max)
      const cached = await KV.get("LATEST_MATCH");
      if (cached) {
        return new Response(cached, {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Data-Source": "KV-Cache" },
        });
      }
    } catch (kvErr) {
      console.error("Critical Failure:", kvErr);
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
