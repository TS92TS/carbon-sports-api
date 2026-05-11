// File: api/get-next-match.js
// This runs securely on the server. Your API key is safe here.

// File: functions/api/get-next-match.js

// Define your CORS headers once so they are easy to apply
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Global variable to store the last successful fetch in Cloudflare's memory
let lastKnownGoodData = null;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;
  const API_URL = 'https://api.football-data.org/v4/competitions/2000/matches';

  try {
    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'X-Auth-Token': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(4000) // Don't wait forever, timeout after 4s
    });

    if (!response.ok) throw new Error(`API Status: ${response.status}`);

    const data = await response.json();
    const now = new Date();
    const nextMatch = data.matches.find(m => new Date(m.utcDate) > now);

    const formattedData = {
      status: 'upcoming',
      badge: nextMatch?.stage === 'GROUP_STAGE' ? 'Group Stage' : 'Knockout',
      datetimeIso: nextMatch?.utcDate,
      teamA: { name: nextMatch?.homeTeam.tla, flag: nextMatch?.homeTeam.crest },
      teamB: { name: nextMatch?.awayTeam.tla, flag: nextMatch?.awayTeam.crest },
      source: 'live' // Added to track where data comes from
    };

    // Update the "Last Known Good" cache
    lastKnownGoodData = formattedData;

    return new Response(JSON.stringify(formattedData), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 's-maxage=600' }
    });

  } catch (error) {
    console.error('Fetch failed, checking cache:', error.message);

    // WORKAROUND: If the API fails (522), but we have a successful fetch in memory, serve it!
    if (lastKnownGoodData) {
      return new Response(JSON.stringify({ ...lastKnownGoodData, source: 'cache' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Only if both fail do we return the 500
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
