// The app's database: documents by path (app/settings, journal/<id>, market/latest, ...).
import { authed, deny, kvGet, kvList, kvSet, kvDel, readBody } from "./_lib.js";
export default async function handler(req, res) {
  if (!authed(req)) return deny(res);
  try {
    const { path, prefix } = req.query;
    if (req.method === "GET" && prefix) return res.json({ docs: await kvList(prefix) });
    if (req.method === "GET" && path) { if (path.startsWith("secret/")) return res.status(403).end(); return res.json(await kvGet(path)); }
    if (req.method === "POST") { const b = await readBody(req); if (!b.path || b.path.startsWith("secret/")) return res.status(400).end(); await kvSet(b.path, b.data ?? {}); return res.json({ ok: true }); }
    if (req.method === "DELETE" && path && !path.startsWith("secret/")) { await kvDel(path); return res.json({ ok: true }); }
    res.status(400).end();
  } catch (e) { res.status(500).json({ code: "db_error", message: String(e.message || e) }); }
}
