// Netlify Function: POST /.netlify/functions/preview
// Needs env var GEMINI_API_KEY (Netlify > Site settings > Environment variables)
// Optional: GEMINI_MODEL (default gemini-2.5-flash-image)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (code, obj) => ({
  statusCode: code,
  headers: { ...CORS, 'Content-Type': 'application/json' },
  body: JSON.stringify(obj),
});

// "data:image/png;base64,XXXX" -> inlineData part
const part = (url) => {
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(url || '');
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null;
};


// FREE fallback: text-only (does NOT see the cutting design), anonymous Pollinations tier
async function freeImage(b) {
  const prompt =
    'Realistic fashion photo of a woman model wearing a Bangladeshi salwar kameez, full body, studio light. ' +
    (b.instruction ? b.instruction + '. ' : '');
  const url =
    'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt.slice(0, 700)) +
    '?width=768&height=1024&nologo=true&model=flux';
  const r = await fetch(url);
  if (!r.ok) throw new Error('Free service HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get('content-type') || 'image/jpeg';
  return `data:${type};base64,${buf.toString('base64')}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    try { return json(200, { image: await freeImage(JSON.parse(event.body || '{}')) }); }
    catch (e) { return json(502, { error: String(e) }); }
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-image';

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'bad json' }); }

  const parts = [];
  const text =
    'You are a fashion visualizer. The first image is a flat cutting design of a ' +
    'Bangladeshi salwar kameez. Generate one realistic photo of a model wearing this exact design. ' +
    'Keep the silhouette, sleeves, neckline and salwar shape faithful to the design. ' +
    'Use any following images as fabric/lace/model references. ' +
    (b.instruction ? 'Designer instruction: ' + b.instruction + '. ' : '') +
    (b.fabricTypes ? 'Fabric types: ' + JSON.stringify(b.fabricTypes) + '. ' : '');
  parts.push({ text });

  const d = part(b.design);
  if (d) parts.push(d);
  Object.values(b.materials || {}).forEach((m) => {
    const p = part(typeof m === 'string' ? m : m && (m.src || m.url || m.data));
    if (p && parts.length < 6) parts.push(p);
  });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );
    const j = await r.json();
    if (!r.ok) {
      if (r.status === 429 || /quota/i.test(j.error?.message || '')) {
        try { return json(200, { image: await freeImage(b) }); }
        catch (e) { return json(502, { error: 'Gemini quota + free fallback failed: ' + e }); }
      }
      return json(502, { error: j.error?.message || 'Gemini error' });
    }
    const img = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inlineData || p.inline_data);
    const id = img && (img.inlineData || img.inline_data);
    if (!id) return json(502, { error: 'No image returned' });
    return json(200, { image: `data:${id.mimeType || id.mime_type || 'image/png'};base64,${id.data}` });
  } catch (e) {
    return json(500, { error: String(e) });
  }
};
