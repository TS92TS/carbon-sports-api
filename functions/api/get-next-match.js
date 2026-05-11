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
    const response = await fetch(API_URL, {
      method: 'GET',
      headers: {
        'X-Auth-Token': API_KEY,
        'Content-Type': 'application/json'
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
    console.error(error);
    return new Response(JSON.stringify({ error: 'Failed to fetch match data' }), {
      status: 500,
      headers: { 
        'Content-Type': 'application/json',
        ...corsHeaders // Inject CORS headers here too!
      }
    });
  }
}