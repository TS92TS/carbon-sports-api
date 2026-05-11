// File: api/get-next-match.js
// This runs securely on the server. Your API key is safe here.

// File: functions/api/get-next-match.js

// Define your CORS headers once so they are easy to apply
const corsHeaders = {
  'Access-Control-Allow-Origin': '*', // Change '*' to 'https://yourwebsite.com' before going live!
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  // Handle preflight OPTIONS request (browsers send this first to check CORS)
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const API_KEY = context.env.FOOTBALL_DATA_API_KEY; 
  const API_URL = 'https://api.football-data.org/v4/competitions/2000/matches';

  try {
// 4. Fetch the data securely with a User-Agent to bypass bot-blockers
    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'X-Auth-Token': API_KEY,
        'Content-Type': 'application/json',
        // Add this line to pretend we are a normal Google Chrome browser:
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const data = await response.json();

    const now = new Date();
    const nextMatch = data.matches.find(match => new Date(match.utcDate) > now);

    if (!nextMatch) {
      return new Response(JSON.stringify({ status: 'concluded' }), {
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders // Inject CORS headers here
        }
      });
    }

    const formattedData = {
      status: 'upcoming',
      badge: nextMatch.stage === 'GROUP_STAGE' ? 'Group Stage' : 'Knockout',
      datetimeIso: nextMatch.utcDate,
      teamA: {
        name: nextMatch.homeTeam.tla || 'TBD',
        flag: nextMatch.homeTeam.crest 
      },
      teamB: {
        name: nextMatch.awayTeam.tla || 'TBD',
        flag: nextMatch.awayTeam.crest
      }
    };

    return new Response(JSON.stringify(formattedData), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=300',
        ...corsHeaders // Inject CORS headers here
      }
    });

} catch (error) {
    console.error('Proxy Error:', error);
    
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders 
      }
    });
  }
