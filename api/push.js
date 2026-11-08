// Phone notifications (Web Push). subscribe: from the app. notify: from the app, the database trigger or AURUM's hourly watch.
import webpush from "web-push";
import { authed, deny, kvGet, kvSet, readBody } from "./_lib.js";
export default async function handler(req, res) {
  const action = req.query.action;
  const fromServer = req.headers["x-aurum-token"] && req.headers["x-aurum-token"] === process.env.AURUM_DB_TOKEN;
  if (!fromServer && !authed(req)) return deny(res);
  if (!process.env.VAPID_PUBLIC) return res.status(503).json({ code: "no_push" });
  webpush.setVapidDetails("mailto:bouphavanh88@gmail.com", process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
  const b = await readBody(req);
  const cur = await kvGet("push/subs"), subs = cur.exists && Array.isArray(cur.data.items) ? cur.data.items : [];
  if (action === "subscribe") {
    if (!b.sub || !b.sub.endpoint) return res.status(400).end();
    const items = subs.filter(s => s.endpoint !== b.sub.endpoint).concat([b.sub]).slice(-5);
    await kvSet("push/subs", { items }); return res.json({ ok: true, n: items.length });
  }
  if (action === "notify") {
    const payload = JSON.stringify({ title: b.title || "AURUM", body: b.body || "", url: b.url || "/", tag: b.tag || "aurum" });
    const keep = []; let sent = 0;
    for (const s of subs) { try { await webpush.sendNotification(s, payload, { TTL: 3600, urgency: "high" }); keep.push(s); sent++; } catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); } }
    if (keep.length !== subs.length) await kvSet("push/subs", { items: keep });
    return res.json({ ok: true, sent });
  }
  res.status(400).end();
}
