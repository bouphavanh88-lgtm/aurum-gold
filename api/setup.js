// Store / check the AI and data keys (kept server-side, never sent back to the phone).
import { authed, deny, kvGet, kvSet, readBody, clearSecretCache, secrets } from "./_lib.js";
export default async function handler(req, res) {
  if (!authed(req)) return deny(res);
  if (req.method === "GET") { const s = await secrets(); return res.json({ claude: !!s.anthropic, gemini: !!s.gemini, fmp: !!s.fmp, geminiModel: s.geminiModel, push: !!process.env.VAPID_PUBLIC, vapid: process.env.VAPID_PUBLIC || "" }); }
  if (req.method === "POST") {
    const b = await readBody(req), cur = await kvGet("secret/keys"), d = cur.exists ? cur.data : {};
    for (const k of ["anthropic", "gemini", "fmp", "geminiModel"]) if (typeof b[k] === "string") { const v = b[k].trim(); if (v) d[k] = v; else delete d[k]; }
    await kvSet("secret/keys", d); clearSecretCache();
    const s = await secrets(); return res.json({ claude: !!s.anthropic, gemini: !!s.gemini, fmp: !!s.fmp });
  }
  res.status(405).end();
}
