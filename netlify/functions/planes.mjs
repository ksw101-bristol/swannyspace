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

// ---- Route helpers ------------------------------------------------------
const rad = d => (d * Math.PI) / 180;
function distKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
function brg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return Math.atan2(y, x);
}
// Is the plane plausibly flying between these two airports?
// Accept if it's near either airport, or close to the great-circle line between them.
function onRoute(lat, lon, a, b) {
  if (![a?.lat, a?.lon, b?.lat, b?.lon].every(Number.isFinite)) return false;
  const dA = distKm(a.lat, a.lon, lat, lon), dB = distKm(b.lat, b.lon, lat, lon);
  if (Math.min(dA, dB) < 60) return true;
  const total = distKm(a.lat, a.lon, b.lat, b.lon);
  const xt = Math.abs(Math.asin(Math.sin(dA / 6371) * Math.sin(brg(a.lat, a.lon, lat, lon) - brg(a.lat, a.lon, b.lat, b.lon))) * 6371);
  const allowed = Math.max(80, total * 0.12);  // airways wander a bit from the straight line
  return xt <= allowed && dA <= total + 60 && dB <= total + 60;
}
const airportFromAdsbdb = ap => ({
  iata: ap.iata_code || null, icao: ap.icao_code || null,
  name: ap.name || null, city: ap.municipality || null,
  lat: Number(ap.latitude), lon: Number(ap.longitude),
});
const airportFromRouteset = ap => ({
  iata: ap.iata || null, icao: ap.icao || null,
  name: ap.name || null, city: ap.location || null,
  lat: Number(ap.lat), lon: Number(ap.lon),
});

// adsb.lol route lookup: checks the route against where the plane actually is
async function routeset(callsign, lat, lon) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch("https://api.adsb.lol/api/0/routeset", {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ planes: [{ callsign, lat, lng: lon }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const arr = await r.json();
    const hit = Array.isArray(arr) ? arr.find(x => (x.callsign || "").toUpperCase() === callsign) || arr[0] : null;
    if (!hit || !Array.isArray(hit._airports) || hit._airports.length < 2) return null;
    const plausible = hit.plausible === true || hit.plausible === 1 || hit.plausible === "1";
    if (!plausible) return null;
    // Multi-leg flights: pick the leg the plane is on
    const aps = hit._airports.map(airportFromRouteset);
    let best = null;
    for (let i = 0; i < aps.length - 1; i++) {
      if (onRoute(lat, lon, aps[i], aps[i + 1])) { best = [aps[i], aps[i + 1]]; break; }
    }
    if (!best) return null;
    return { origin: best[0], destination: best[1], source: "adsb.lol" };
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
    const pLat = Number(q.get("lat")), pLon = Number(q.get("lon"));
    const havePos = Number.isFinite(pLat) && Number.isFinite(pLon) && q.get("lat") !== null;

    const [db, rs] = await Promise.all([
      getJson(`https://api.adsbdb.com/v0/aircraft/${hex}` + (cs ? `?callsign=${cs}` : "")).catch(() => null),
      cs && havePos ? routeset(cs, pLat, pLon).catch(() => null) : null,
    ]);
    const resp = db && typeof db.response === "object" ? db.response : {};
    const aircraft = resp.aircraft || null;
    const fr = resp.flightroute || null;

    let route = null;
    // 1) adsb.lol route, which is checked against the plane's position
    if (rs) route = rs;
    // 2) adsbdb route, only if the plane is plausibly on it
    else if (fr && fr.origin && fr.destination) {
      const cand = {
        origin: airportFromAdsbdb(fr.origin),
        destination: airportFromAdsbdb(fr.destination),
        source: "adsbdb",
      };
      if (!havePos || onRoute(pLat, pLon, cand.origin, cand.destination)) route = cand;
    }

    return json({
      aircraft,
      airline: fr && fr.airline ? fr.airline.name : null, // airline comes from the callsign prefix, so it's reliable
      route,
    }, 200, 60);
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
