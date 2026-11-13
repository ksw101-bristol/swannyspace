// Thanksgiving Buffet sign-up — stores dishes in Netlify Blobs.
// GET    /.netlify/functions/thanksgiving            -> { entries: [...] }
// POST   /.netlify/functions/thanksgiving            body { household, category, dish } -> { entry, token }
// DELETE /.netlify/functions/thanksgiving?id=<id>    header x-edit-token (from POST) or x-admin-key
import { getStore } from "@netlify/blobs";

const HOUSEHOLDS = [
  "K & V", "Pauline/Fordy", "Chris", "Jane", "Laura", "Soph", "Katie/Josh", "Mayer",
  "Budd", "Ken", "Meli", "Jarv", "Eggy", "Yvette/Darren", "Cameron/Lilly", "Elliot/Ellie",
];
const CATEGORIES = ["mains", "savoury", "meats", "cheese", "bread", "crisps", "veg", "desserts"];
const MAX_PER_HOUSEHOLD = 8;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const clean = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export default async (req) => {
  const store = getStore({ name: "thanksgiving-2026", consistency: "strong" });
  const url = new URL(req.url);

  const loadAll = async () => {
    const { blobs } = await store.list({ prefix: "entry/" });
    const rows = await Promise.all(
      blobs.map(async (b) => {
        const v = await store.get(b.key, { type: "json" });
        return v ? { ...v, _key: b.key } : null;
      })
    );
    return rows.filter(Boolean);
  };
  const publicView = ({ token, _key, ...e }) => e;

  if (req.method === "GET") {
    const entries = (await loadAll()).map(publicView).sort((a, b) => a.ts - b.ts);
    return json({ entries });
  }

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
    const household = clean(body.household, 40);
    const category = clean(body.category, 20);
    const dish = clean(body.dish, 60);
    if (!HOUSEHOLDS.includes(household)) return json({ error: "Pick your name from the list" }, 400);
    if (!CATEGORIES.includes(category)) return json({ error: "Pick a category" }, 400);
    if (dish.length < 2) return json({ error: "Tell us what you're bringing" }, 400);

    const prefix = `entry/${HOUSEHOLDS.indexOf(household)}/`;
    const { blobs } = await store.list({ prefix });
    if (blobs.length >= MAX_PER_HOUSEHOLD) return json({ error: "That's plenty from you already!" }, 400);

    const id = crypto.randomUUID();
    const token = crypto.randomUUID();
    const entry = { id, household, category, dish, ts: Date.now() };
    await store.setJSON(prefix + id, { ...entry, token });
    return json({ entry, token }, 201);
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, 400);
    const all = await loadAll();
    const row = all.find((r) => r.id === id);
    if (!row) return json({ error: "Not found" }, 404);
    const adminKey = process.env.THANKSGIVING_ADMIN_KEY;
    const isAdmin = adminKey && req.headers.get("x-admin-key") === adminKey;
    const isOwner = req.headers.get("x-edit-token") === row.token;
    if (!isAdmin && !isOwner) return json({ error: "Only the person who added this (or Kirk) can remove it" }, 403);
    await store.delete(row._key);
    return json({ ok: true });
  }

  return json({ error: "Method not allowed" }, 405);
};
