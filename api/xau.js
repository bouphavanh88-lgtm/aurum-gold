// Spot XAUUSD candles shaped like MT5 (IUX), from free public feeds. No keys, read-only, cached.
//   GET /api/xau?tf=15m|1h|4h|1d -> { source, tf, serverOffsetH, candles: [[unixSec, o, h, l, c], ...], spot: {bid, ask, mid, at, source}, prevClose }
// Live price: Swissquote spot feed. History: PAXG (1 token = 1 oz gold, Binance) shifted onto spot,
// with weekend/closed hours removed and H4/D1 grouped on MT5 server time (GMT+2 winter, GMT+3 summer).
const cache = new Map();
const HDR = { "User-Agent": "Mozilla/5.0 (AURUM app)", Accept: "application/json" };
const TTL = { "15m": 30e3, "1h": 60e3, "4h": 120e3, "1d": 300e3 };

async function j(url, ms = 7000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: HDR, signal: c.signal }); if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
function usDst(ms) {            // US daylight time: 2nd Sunday of March .. 1st Sunday of November
  const d = new Date(ms), y = d.getUTCFullYear();
  const nth = (m, n) => { const f = new Date(Date.UTC(y, m, 1)); return Date.UTC(y, m, 1 + ((7 - f.getUTCDay()) % 7) + 7 * (n - 1), 7); };
  return ms >= nth(2, 2) && ms < nth(10, 1);
}
function goldOpen(sec) {        // is spot gold trading at this time? (Sun open .. Fri close, daily 1-hour break)
  const ms = sec * 1000, d = new Date(ms), wd = d.getUTCDay(), h = d.getUTCHours(), close = usDst(ms) ? 21 : 22;
  if (wd === 6) return false;
  if (wd === 5 && h >= close) return false;
  if (wd === 0 && h < close + 1) return false;
  if (h === close) return false;
  return true;
}
const srvOff = sec => (usDst(sec * 1000) ? 3 : 2) * 3600;
function group(rows, secs) {    // group by MT5 server-time buckets
  const out = []; let cur = null;
  for (const [t, o, h, l, c] of rows) {
    const off = srvOff(t), k = Math.floor((t + off) / secs) * secs - off;
    if (!cur || cur[0] !== k) { if (cur) out.push(cur); cur = [k, o, h, l, c]; }
    else { cur[2] = Math.max(cur[2], h); cur[3] = Math.min(cur[3], l); cur[4] = c; }
  }
  if (cur) out.push(cur); return out;
}
async function paxg(iv, limit = 1000, endTime) {
  const d = await j(`https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${iv}&limit=${limit}${endTime ? "&endTime=" + endTime : ""}`);
  return d.map(k => [Math.floor(k[0] / 1000), +k[1], +k[2], +k[3], +k[4]]);
}
async function spotSwissquote() {
  const d = await j("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD");
  const best = []; for (const pf of d || []) for (const sp of pf.spreadProfilePrices || []) if (sp.bid && sp.ask) best.push({ bid: sp.bid, ask: sp.ask, at: pf.ts });
  if (!best.length) throw new Error("swissquote empty");
  best.sort((a, b) => (a.ask - a.bid) - (b.ask - b.bid));
  const b = best[0]; return { bid: +b.bid, ask: +b.ask, mid: (b.bid + b.ask) / 2, at: b.at || Date.now(), source: "Swissquote spot" };
}
async function build(tf) {
  const errors = [];
  let spot = null; try { spot = await spotSwissquote(); } catch (e) { errors.push(String(e.message)); }
  let rows;
  if (tf === "15m") rows = (await paxg("15m", 1000)).filter(r => goldOpen(r[0]));
  else if (tf === "1h" || tf === "4h") { rows = (await paxg("1h", 1000)).filter(r => goldOpen(r[0])); if (tf === "4h") rows = group(rows, 4 * 3600); }
  else {
    const h1 = (await paxg("1h", 1000)).filter(r => goldOpen(r[0])), recent = group(h1, 86400);
    const firstRecent = recent.length ? recent[0][0] : Infinity;
    const older = (await paxg("1d", 1000)).filter(r => { const wd = new Date(r[0] * 1000).getUTCDay(); return wd !== 6 && wd !== 0 && r[0] < firstRecent - 3600; });
    rows = older.concat(recent.slice(1));    // first grouped day may be partial
  }
  if (!rows.length) throw new Error("no candles");
  // shift PAXG onto spot gold using the live spot price (PAXG trades at a small premium/discount)
  const last = rows[rows.length - 1];
  let off = 0;
  if (spot && Date.now() / 1000 - last[0] < 3 * 86400) { const h1 = tf === "15m" || tf === "1h" ? rows : (await paxg("1h", 2)); off = spot.mid - h1[h1.length - 1][4]; }
  rows = rows.map(([t, o, h, l, c]) => [t, +(o + off).toFixed(2), +(h + off).toFixed(2), +(l + off).toFixed(2), +(c + off).toFixed(2)]);
  if (!spot) { const c = rows[rows.length - 1]; spot = { bid: c[4], ask: c[4], mid: c[4], at: c[0] * 1000, source: "PAXG" }; }
  return { source: "Swissquote spot + PAXG history shifted to spot", tf, serverOffsetH: srvOff(Date.now() / 1000) / 3600, candles: rows, spot, offset: +off.toFixed(2), open: goldOpen(Date.now() / 1000), errors };
}
export default async function handler(req, res) {
  const tf = ["15m", "1h", "4h", "1d"].includes(req.query.tf) ? req.query.tf : "1h";
  res.setHeader("Cache-Control", "no-store");
  const hit = cache.get(tf);
  if (hit && Date.now() - hit.at < TTL[tf]) return res.json(hit.data);
  try { const data = await build(tf); cache.set(tf, { at: Date.now(), data }); res.json(data); }
  catch (e) { if (hit) return res.json({ ...hit.data, stale: true }); res.status(502).json({ code: "no_data", message: String(e.message || e) }); }
}
