// Ask the AI brain. Claude first; Gemini when Claude is missing or fails. Streams plain text back.
import { authed, deny, secrets, readBody } from "./_lib.js";
export const config = { maxDuration: 60 };

const CLAUDE_MODEL = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5", complex: "claude-sonnet-5-5" };

function mergeTurns(turns) {   // the API wants alternating roles; join consecutive same-role turns
  const out = [];
  for (const t of turns || []) {
    const role = t.role === "assistant" ? "assistant" : "user", text = String(t.content ?? "");
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].text += "\n\n" + text;
    else out.push({ role, text });
  }
  if (out.length && out[0].role !== "user") out.unshift({ role: "user", text: "(start)" });
  return out;
}

async function* sse(resp) {
  const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line.startsWith("data:")) yield line.slice(5).trim(); }
  }
}

async function claude(key, turns, tier, images, write) {
  const msgs = mergeTurns(turns).map(m => ({ role: m.role, content: [{ type: "text", text: m.text }] }));
  if (images?.length) { const last = msgs[msgs.length - 1]; last.content = [...images.map(im => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } })), ...last.content]; }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL[tier] || CLAUDE_MODEL.default, max_tokens: tier === "quick" ? 1024 : 4096, stream: true, messages: msgs }),
  });
  if (!r.ok) throw new Error("claude " + r.status + " " + (await r.text()).slice(0, 300));
  let n = 0;
  for await (const d of sse(r)) {
    if (d === "[DONE]") break;
    try { const ev = JSON.parse(d); if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { write(ev.delta.text); n++; } if (ev.type === "error") throw new Error("claude stream " + JSON.stringify(ev.error)); } catch (e) { if (String(e.message).startsWith("claude")) throw e; }
  }
  return n;
}

async function gemini(key, model, turns, images, write) {
  const contents = mergeTurns(turns).map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.text }] }));
  if (images?.length) contents[contents.length - 1].parts.unshift(...images.map(im => ({ inlineData: { mimeType: im.media_type, data: im.data } })));
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST", headers: { "x-goog-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ contents }),
  });
  if (!r.ok) throw new Error("gemini " + r.status + " " + (await r.text()).slice(0, 300));
  let n = 0;
  for await (const d of sse(r)) { try { const ev = JSON.parse(d); for (const p of ev.candidates?.[0]?.content?.parts || []) if (p.text && !p.thought) { write(p.text); n++; } } catch {} }
  return n;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  if (!authed(req)) return deny(res);
  const body = await readBody(req), s = await secrets();
  const { turns, tier = "default", images = [], brain = "auto" } = body;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Accel-Buffering", "no");
  let started = false;
  const write = t => { started = true; res.write(t); };
  const order = brain === "gemini" ? ["gemini", "claude"] : ["claude", "gemini"];
  const errors = [];
  for (const b of order) {
    try {
      if (b === "claude" && s.anthropic) { res.setHeader("X-Brain", "claude"); await claude(s.anthropic, turns, tier, images, write); return res.end(); }
      if (b === "gemini" && s.gemini) { res.setHeader("X-Brain", "gemini"); await gemini(s.gemini, s.geminiModel, turns, images, write); return res.end(); }
    } catch (e) { errors.push(String(e.message || e)); if (started) return res.end(); }
  }
  if (!res.headersSent) res.status(503);
  res.end(JSON.stringify({ code: (s.anthropic || s.gemini) ? "brain_error" : "no_key", message: errors.join(" | ") || "No AI key yet. Open Setup and paste your Claude or Gemini key." }));
}
