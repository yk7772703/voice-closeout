// Voice Closeout backend (Cloudflare Worker)
// - Serves the app (files in /public)
// - POST /api/transcribe : audio (WAV) -> text, using Cloudflare's built-in Whisper
// - POST /api/write      : notes + sheet text -> closeout JSON, using Claude
// Secrets (set with `npx wrangler secret put NAME`): ANTHROPIC_API_KEY, ACCESS_CODE

const MODEL = 'claude-haiku-5-5';
const MAX_AUDIO_BYTES = 4 * 1024 * 1024; // one chunk of audio per request

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);

    // Beta gate: only people with the access code can spend your credits.
    const code = request.headers.get('x-access-code') || '';
    if (!env.ACCESS_CODE || code.trim() !== String(env.ACCESS_CODE).trim()) {
      return json({ error: 'wrong_code' }, 401);
    }

    try {
      if (url.pathname === '/api/transcribe') return await transcribe(request, env);
      if (url.pathname === '/api/write') return await writeCloseout(request, env);
      return json({ error: 'Not found.' }, 404);
    } catch (e) {
      console.log('error', e && e.stack || e);
      return json({ error: 'server_error' }, 500);
    }
  },
};

async function transcribe(request, env) {
  const buf = new Uint8Array(await request.arrayBuffer());
  if (!buf.length) return json({ error: 'empty_audio' }, 400);
  if (buf.length > MAX_AUDIO_BYTES) return json({ error: 'audio_too_large' }, 413);
  const out = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
    audio: toBase64(buf),
    language: 'en',
    initial_prompt: 'Field technician closeout notes. Terms: DEMARC, NOC, IDF, MDF, Cat5e, Cat6, fiber, ONT, router, switch, patch panel, Mbps, speed test, work order.',
  });
  return json({ text: (out && out.text || '').trim() });
}

async function writeCloseout(request, env) {
  const body = await request.json().catch(() => ({}));
  const notes = String(body.notes || '').slice(0, 6000).trim();
  const sheet = String(body.sheet || '(no work order sheet uploaded)').slice(0, 7000);
  if (!notes) return json({ error: 'empty_notes' }, 400);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'missing_api_key' }, 500);

  const prompt = `You turn a field technician's spoken notes into closeout data for a work-order sign-off sheet.

WORK ORDER SHEET TEXT (scope and terminology only; never claim a step the technician did not mention):
<<<
${sheet}
>>>

TECHNICIAN'S NOTES (speech-to-text, expect errors such as "demark" for DEMARC, "cat 6" for Cat6, "fast dot com" for fast.com, "935 by 930" meaning 935/930 Mbps):
<<<
${notes}
>>>

Reply with only this JSON object, no other text:
{"arrival":"","departure":"","managerName":"","description":"","followUps":[],"missing":[]}

Rules:
- arrival / departure: times stated in the notes as "h:mm AM" or "h:mm PM"; infer AM/PM from context (a 9:50 arrival is AM, a 1:40 departure is PM). Empty string if not stated.
- managerName: the signing manager's name if stated, properly capitalized; else empty.
- description: what goes in "Description of Work Performed". Professional, past tense, no "I", 3 to 6 sentences, under 600 characters. Keep every concrete fact exactly: speeds, footage, ports, devices, serials, who was contacted. Fix speech-to-text errors and use the sheet's terms (e.g. NOC, DEMARC). Never invent facts, numbers, names or results.
- followUps: open issues, return-visit needs, equipment left behind, anything unresolved. [] if none.
- missing: up to 3 short items a dispatcher usually needs for this type of job that the notes do not mention (e.g. "Speed test results", "Departure time"). [] if nothing important is missing.`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    console.log('anthropic', r.status, (await r.text()).slice(0, 500));
    return json({ error: r.status === 429 ? 'busy' : 'ai_error' }, 502);
  }
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  let parsed = null;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e) {}
  if (!parsed) return json({ error: 'bad_ai_reply' }, 502);
  return json(parsed);
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
