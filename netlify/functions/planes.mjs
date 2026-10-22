// Netlify function: relays live aircraft positions and aircraft/route details
// so the browser doesn't hit the feeds' cross-site (CORS) restrictions.
//
//   /.netlify/functions/planes?lat=51.4836&lon=-2.5063&r=30   -> { ac: [...] }
//   /.netlify/functions/planes?hex=4ca7b5&callsign=RYR123      -> adsbdb details

const HEADERS = { "User-Agent": "swannyspace-overhead/1.0", Accept: "application/json" };

const FEEDS = [
  (lat, lon, r) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${r}`,
  (lat, lon, r) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${r}`,
];

const json = (body, status = 200, maxAge = 5) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${maxAge}`,
      "Access-Control-Allow-Origin": "*",
    },
  });

async function getJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export default async (req) => {
  const q = new URL(req.url).searchParams;

  // Details mode
  const hex = (q.get("hex") || "").toLowerCase();
  if (hex) {
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "Bad hex code" }, 400);
    const cs = (q.get("callsign") || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const url = `https://api.adsbdb.com/v0/aircraft/${hex}` + (cs ? `?callsign=${cs}` : "");
    try {
      return json(await getJson(url), 200, 3600);
    } catch (e) {
      return json({ response: null, error: String(e.message || e) }, 200, 60);
    }
  }

  // Positions mode
  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  const r = Math.min(Math.max(Number(q.get("r")) || 30, 1), 250);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat and lon are required" }, 400);

  const errors = [];
  for (const feed of FEEDS) {
    try {
      const data = await getJson(feed(lat.toFixed(4), lon.toFixed(4), r));
      return json({ ac: data.ac || data.aircraft || [], source: new URL(feed(0, 0, 0)).host });
    } catch (e) {
      errors.push(String(e.message || e));
    }
  }
  return json({ error: "No flight feed answered", details: errors }, 502, 0);
};
