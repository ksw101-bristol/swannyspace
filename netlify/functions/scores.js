// netlify/functions/scores.js
// Pulls fixtures across all 4 top English divisions for a date range and merges
// them into one array. Node 22 native fetch — no node-fetch dependency needed.
//
// Usage: /.netlify/functions/scores?from=2026-08-15&to=2026-08-17
//
// IMPORTANT: uses score.fulltime.home / score.fulltime.away for the 90-minute
// result — NOT goals.home / goals.away, which can include extra-time goals in
// cup competitions. For these leagues ET doesn't apply, but we keep to
// fulltime for consistency with the World Cup pages.

const LEAGUES = [
  { id: 39, name: 'Premier League' },
  { id: 40, name: 'Championship' },
  { id: 41, name: 'League One' },
  { id: 42, name: 'League Two' },
];

const SEASON = 2026; // 2026/27 season

exports.handler = async (event) => {
  const { from, to } = event.queryStringParameters || {};

  if (!from || !to) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required query params: from, to (YYYY-MM-DD)' }),
    };
  }

  if (!process.env.API_FOOTBALL_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'API_FOOTBALL_KEY is not set in the environment' }),
    };
  }

  try {
    const requests = LEAGUES.map((league) =>
      fetch(
        `https://v3.football.api-sports.io/fixtures?league=${league.id}&season=${SEASON}&from=${from}&to=${to}`,
        { headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY } }
      )
        .then((res) => {
          if (!res.ok) {
            throw new Error(`api-football request failed for league ${league.id}: ${res.status}`);
          }
          return res.json();
        })
        .then((data) => ({ league, data }))
    );

    const results = await Promise.all(requests);

    const matches = [];
    for (const { league, data } of results) {
      const fixtures = data.response || [];
      for (const fixture of fixtures) {
        matches.push({
          fixtureId: fixture.fixture.id,
          league: league.id,
          leagueName: league.name,
          status: fixture.fixture.status.short, // e.g. NS, 1H, HT, 2H, FT
          kickoff: fixture.fixture.date,
          home: fixture.teams.home.name,
          away: fixture.teams.away.name,
          // Use fulltime score, NOT goals.home/away (which can include ET in cup ties)
          homeScore: fixture.score.fulltime.home,
          awayScore: fixture.score.fulltime.away,
          // Live/in-progress elapsed score, useful while a match is still on
          liveHomeScore: fixture.goals.home,
          liveAwayScore: fixture.goals.away,
        });
      }
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
      body: JSON.stringify({ matches }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
