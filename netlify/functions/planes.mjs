// Netlify function: relays live aircraft positions and aircraft/route details
// so the browser doesn't hit the feeds' cross-site (CORS) restrictions.
//
//   /.netlify/functions/planes?lat=51.4836&lon=-2.5063&r=30   -> { ac: [...] }
//   /.netlify/functions/planes?hex=4ca7b5                       -> aircraft + route details

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

// ---- Live lookup by hex (free) -----------------------------------------
async function liveAircraft(hex) {
  for (const base of ["https://api.adsb.lol/v2/hex/", "https://api.airplanes.live/v2/hex/"]) {
    try {
      const d = await getJson(base + hex);
      const a = (d.ac || d.aircraft || [])[0];
      if (a) return a;
      return null; // feed answered: plane isn't flying
    } catch (e) { /* try the next feed */ }
  }
  return null;
}

// ---- FlightAware AeroAPI with a hard daily cap ---------------------------
// Netlify environment variables:
//   AEROAPI_KEY  your FlightAware AeroAPI key (required to use FlightAware)
//   DAILY_CAP    max paid lookups per UTC day (default 100)
const ROUTE_TTL_MS = 2 * 60 * 60 * 1000;   // found routes are reused for 2 hours
const MISS_TTL_MS = 20 * 60 * 1000;        // "no airborne flight" is remembered for 20 minutes

async function blobStore() {
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "overhead", consistency: "strong" });
  } catch (e) {
    return null;
  }
}

async function flightAwareRoute(reg, cs) {
  const key = process.env.AEROAPI_KEY;
  if (!key) return { route: null, capped: false };

  // Fail closed: without storage we can't count calls, so we don't make any.
  const store = await blobStore();
  if (!store) return { route: null, capped: true };

  const cacheKey = `route/${reg || "-"}/${cs || "-"}`;
  try {
    const hit = await store.get(cacheKey, { type: "json" });
    if (hit && Date.now() - hit.at < (hit.route ? ROUTE_TTL_MS : MISS_TTL_MS)) {
      return { route: hit.route, capped: false };
    }
  } catch (e) { /* cache miss */ }

  // Daily budget
  const cap = Math.max(0, parseInt(process.env.DAILY_CAP || "100", 10) || 0);
  const day = new Date().toISOString().slice(0, 10);
  const countKey = `count/${day}`;
  let used = 0;
  try {
    used = Number(await store.get(countKey)) || 0;
  } catch (e) {
    return { route: null, capped: true };
  }
  if (used >= cap) return { route: null, capped: true };
  try {
    await store.set(countKey, String(used + 1));
  } catch (e) {
    return { route: null, capped: true }; // couldn't record the spend, so don't spend
  }

  // Registration is the most reliable identifier; fall back to the callsign.
  const ident = reg || cs;
  const typeParam = reg ? "&ident_type=registration" : "";
  let route = null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(
      `https://aeroapi.flightaware.com/aeroapi/flights/${encodeURIComponent(ident)}?max_pages=1${typeParam}`,
      { headers: { "x-apikey": key, Accept: "application/json" }, signal: ctrl.signal }
    ).finally(() => clearTimeout(t));
    if (r.ok) {
      const data = await r.json();
      const airborne = (data.flights || [])
        .filter(f => f.actual_off && !f.actual_on && !f.cancelled)
        .sort((a, b) => String(b.actual_off).localeCompare(String(a.actual_off)))[0];
      if (airborne && airborne.origin && airborne.destination) {
        const ap = a => ({
          iata: a.code_iata || null, icao: a.code_icao || a.code || null,
          name: a.name || null, city: a.city || null,
        });
        route = {
          origin: ap(airborne.origin),
          destination: ap(airborne.destination),
          flight: airborne.ident_iata || airborne.ident || null,
          airline: null,
          source: "FlightAware",
        };
      }
    }
  } catch (e) { /* fall through to free sources */ }

  try { await store.set(cacheKey, JSON.stringify({ at: Date.now(), route })); } catch (e) {}
  return { route, capped: false };
}

export default async (req) => {
  const q = new URL(req.url).searchParams;

  // Details mode
  const hex = (q.get("hex") || "").toLowerCase();
  if (hex) {
    if (!/^[0-9a-f]{6}$/.test(hex)) return json({ error: "Bad hex code" }, 400);

    // Look the plane up in the live feed ourselves. Registration, callsign and
    // position come from here, never from the request, and a code that isn't
    // currently flying never triggers a paid lookup.
    const [live, db] = await Promise.all([
      liveAircraft(hex),
      getJson(`https://api.adsbdb.com/v0/aircraft/${hex}`).catch(() => null),
    ]);
    const cs = (live?.flight || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const reg = (live?.r || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const pLat = Number(live?.lat), pLon = Number(live?.lon);
    const havePos = Number.isFinite(pLat) && Number.isFinite(pLon);

    const resp = db && typeof db.response === "object" ? db.response : {};
    const aircraft = resp.aircraft || null;

    let route = null, capped = false;

    // 1) FlightAware (paid, capped)
    if (live && (reg || cs)) {
      const fa = await flightAwareRoute(reg, cs);
      route = fa.route;
      capped = fa.capped;
    }

    // 2) Free sources, checked against the plane's position
    let fr = null;
    if (!route && cs) {
      const [db2, rs] = await Promise.all([
        getJson(`https://api.adsbdb.com/v0/callsign/${cs}`).catch(() => null),
        havePos ? routeset(cs, pLat, pLon).catch(() => null) : null,
      ]);
      fr = db2 && typeof db2.response === "object" ? db2.response.flightroute : null;
      if (rs) route = rs;
      else if (fr && fr.origin && fr.destination && havePos) {
        const cand = { origin: airportFromAdsbdb(fr.origin), destination: airportFromAdsbdb(fr.destination), source: "adsbdb" };
        if (onRoute(pLat, pLon, cand.origin, cand.destination)) route = cand;
      }
    }

    return json({
      aircraft,
      airline: route?.airline || (fr && fr.airline ? fr.airline.name : null),
      route,
      capped,
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
