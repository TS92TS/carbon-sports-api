const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Use the KV binding we created
  const KV = context.env.MATCH_KV;
  const API_KEY = context.env.FOOTBALL_DATA_API_KEY;
  const API_URL = 'https://api.football-data.org/v4/competitions/2000/matches';

  try {
    // 1. Try to fetch fresh data from the API
    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'X-Auth-Token': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(3000) 
    });

    if (!response.ok) throw new Error('API_DOWN');

    const data = await response.json();
    const now = new Date();
    const nextMatch = data.matches.find(m => new Date(m.utcDate) > now);

    if (!nextMatch) throw new Error('NO_MATCH_FOUND');

    const formattedData = {
      status: 'upcoming',
      badge: nextMatch.stage === 'GROUP_STAGE' ? 'Group Stage' : 'Knockout',
      datetimeIso: nextMatch.utcDate,
      teamA: { name: nextMatch.homeTeam.tla, flag: nextMatch.homeTeam.crest },
      teamB: { name: nextMatch.awayTeam.tla, flag: nextMatch.awayTeam.crest },
      lastUpdated: new Date().toISOString()
    };

    // 2. SUCCESS! Save this fresh data to our KV database for next time
    await KV.put('LATEST_MATCH', JSON.stringify(formattedData));

    return new Response(JSON.stringify(formattedData), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    // 3. FAIL! The API is blocked or down. Let's check our database.
    const cachedData = await KV.get('LATEST_MATCH');

    if (cachedData) {
      console.warn("Serving from Cloudflare KV Database");
      return new Response(cachedData, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'X-Data-Source': 'KV-Cache' }
      });
    }

    // 4. ULTIMATE FAIL (Only if database is empty)
    return new Response(JSON.stringify({ error: "No data available" }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
