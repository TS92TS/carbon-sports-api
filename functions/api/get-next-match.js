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
      headers: corsHeaders 
    });
  }

  const KV = context.env.MATCH_KV;
  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;
  const API_URL = "https://api.football-data.org/v4/competitions/2000/matches";

  // Check if KV is bound correctly
  if (!KV) {
    return new Response(JSON.stringify({ error: "KV_BINDING_MISSING" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    // 2. Try the Live API
    const response = await fetch(API_URL, {
      method: "GET",
      headers: {
        "X-Auth-Token": API_KEY,
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) throw new Error(`API_STATUS_${response.status}`);

    // --- Updated logic: build featured match + upcoming array ---
    const data = await response.json();
    const now = new Date();

    // Filter for all future matches
    const futureMatches = Array.isArray(data.matches)
      ? data.matches.filter(m => new Date(m.utcDate) > now)
      : [];

    if (futureMatches.length === 0) {
      // No upcoming fixtures — return a concluded status and attempt to update KV
      const concludedPayload = { status: "concluded", updatedAt: new Date().toISOString() };
      // Save concluded state as last known good
      await KV.put("LATEST_MATCH", JSON.stringify(concludedPayload));
      return new Response(JSON.stringify(concludedPayload), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // The "Featured" match is the very first one
    const featured = futureMatches[0];

    const formattedData = {
      // ROOT LEVEL (Backward compatibility for Featured Match)
      status: "upcoming",
      badge: featured.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout",
      datetimeIso: featured.utcDate,
      teamA: { name: featured.homeTeam.tla, flag: featured.homeTeam.crest },
      teamB: { name: featured.awayTeam.tla, flag: featured.awayTeam.crest },

      // NEW UPCOMING ARRAY (For the fixtures list)
      upcoming: futureMatches.slice(0, 12).map(match => ({
        datetimeIso: match.utcDate,
        teamA: { name: match.homeTeam.tla, flag: match.homeTeam.crest },
        teamB: { name: match.awayTeam.tla, flag: match.awayTeam.crest },
        badge: match.stage === "GROUP_STAGE" ? "Group Stage" : "Knockout"
      })),

      updatedAt: new Date().toISOString()
    };

    // Save this whole object to KV as the "Last Known Good"
    await KV.put("LATEST_MATCH", JSON.stringify(formattedData));

    return new Response(JSON.stringify(formattedData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });

  } catch (error) {
    // 3. FAILSAFE: If API times out or blocks Cloudflare, serve KV
    const cached = await KV.get("LATEST_MATCH");
    if (cached) {
      return new Response(cached, {
        status: 200, // Success status even though it's cached
        headers: { ...corsHeaders, "Content-Type": "application/json", "X-Data-Source": "KV-Cache" }
      });
    }

    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
}
