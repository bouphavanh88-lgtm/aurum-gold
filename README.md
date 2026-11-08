# AURUM · ຫ້ອງການ AI ເທຣດທອງ (personal PWA)

Personal gold-trading assistant for ATEE. Static app in `public/`, serverless API in `api/` (Vercel).

- `api/ask.js` – AI brain: Claude (Haiku 5.5 quick, Sonnet 5.5 analysis), Gemini fallback, streamed
- `api/fmp.js` – gold prices (FMP GCUSD) with cache
- `api/kv.js` – app database (Supabase table `aurum_kv`, RLS by server token)
- `api/setup.js` – stores API keys server-side
- `api/push.js` – Web Push notifications

Env vars (Vercel): AURUM_PASSCODE, AURUM_DB_TOKEN, SUPABASE_URL, SUPABASE_KEY, VAPID_PUBLIC, VAPID_PRIVATE (+ optional ANTHROPIC_API_KEY, GEMINI_API_KEY, FMP_API_KEY, GEMINI_MODEL).
Analysis, not financial advice.
