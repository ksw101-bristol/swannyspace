const fetch = require('node-fetch');

exports.handler = async function(event) {
  const apiKey = process.env.API_FOOTBALL_KEY;
  
  try {
    const response = await fetch(
      'https://v3.football.api-sports.io/fixtures?league=1&season=2026&from=2026-06-11&to=2026-06-29',
      {
        headers: {
          'x-rapidapi-host': 'v3.football.api-sports.io',
          'x-rapidapi-key': apiKey
        }
      }
    );
    
    const data = await response.json();
    
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    };
    
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to fetch scores' })
    };
  }
};
