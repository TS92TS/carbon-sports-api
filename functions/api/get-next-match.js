// File: functions/api/get-next-match.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*", // For production, you can change this to your GitHub URL
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent, X-Auth-Token, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

export async function onRequest(context) {
  // 1. Handle the Preflight (OPTIONS) - CRITICAL FOR MOBILE
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders,
    });
  }

  const KV = context.env.MATCH_KV;
  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;
  const API_URL = "https://api.football-data.org/v4/competitions/2000/matches";

  // Check bindings and required env
  if (!KV) {
    return new Response(JSON.stringify({ error: "KV_BINDING_MISSING" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!API_KEY) {
    return new Response(JSON.stringify({ error: "API_KEY_MISSING" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 2. Try the Live API
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY,
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(4000),
    });

    if (!response.ok) throw new Error(`API_STATUS_${response.status}`);

    // --- Updated logic: build featured match + multiple feeds ---
    const data = await response.json();
    const now = new Date();

    // Ensure matches is an array
    const allMatches = Array.isArray(data.matches) ? data.matches : [];

    // 1. Get all future matches
    const futureMatches = allMatches.filter((m) => new Date(m.utcDate) > now);

    if (futureMatches.length === 0) {
      // No upcoming fixtures — return a concluded status and attempt to update KV
      const concludedPayload = { status: "concluded", updatedAt: new Date().toISOString() };
      try {
        await KV.put("LATEST_MATCH", JSON.stringify(concludedPayload));
      } catch (e) {
        // ignore KV write errors, we'll still return the concluded payload
      }
      return new Response(JSON.stringify(concludedPayload), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // The "Featured" match is the very first one
    const featured = futureMatches[0];

    // Helper to keep the worker code tidy
    function formatMatch(m) {
      return {
        datetimeIso: m.utcDate,
        teamA: { name: m.homeTeam?.tla ?? "", flag: m.homeTeam?.crest ?? "" },
        teamB: { name: m.awayTeam?.tla ?? "", flag: m.awayTeam?.crest ?? "" },
        badge: m.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
      };
    }

    const formattedData = {
      // ROOT LEVEL (Featured Match)
      status: "upcoming",
      badge: featured.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
      datetimeIso: featured.utcDate,
      teamA: { name: featured.homeTeam?.tla ?? "", flag: featured.homeTeam?.crest ?? "" },
      teamB: { name: featured.awayTeam?.tla ?? "", flag: featured.awayTeam?.crest ?? "" },

      // FEED 1: The next 10 matches (General interest)
      upcoming: futureMatches.slice(0, 10).map((m) => formatMatch(m)),

      // FEED 2: The next 4 England matches (Targeted interest)
      england: futureMatches
        .filter((m) => m.homeTeam?.tla === "ENG" || m.awayTeam?.tla === "ENG")
        .slice(0, 4)
        .map((m) => formatMatch(m)),

      updatedAt: new Date().toISOString(),
    };

    // Save this whole object to KV as the "Last Known Good"
    try {
      await KV.put("LATEST_MATCH", JSON.stringify(formattedData));
    } catch (e) {
      // If KV write fails, continue — we'll still return the live data
      console.warn("KV.put failed:", e);
    }

    return new Response(JSON.stringify(formattedData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    // 3. FAILSAFE: If API times out or blocks Cloudflare, serve KV
    try {
      const cached = await KV.get("LATEST_MATCH");
      if (cached) {
        return new Response(cached, {
          status: 200, // Success status even though it's cached
          headers: { ...corsHeaders, "Content-Type": "application/json", "X-Data-Source": "KV-Cache" },
        });
      }
    } catch (kvErr) {
      // ignore KV read errors and fall through to error response
      console.warn("KV.get failed:", kvErr);
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
