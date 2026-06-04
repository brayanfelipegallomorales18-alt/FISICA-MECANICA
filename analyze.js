/**
 * Vercel Serverless Function — /api/analyze
 *
 * Actúa como proxy entre el frontend (GitHub Pages / Vercel)
 * y la API de Anthropic. Resuelve el problema de CORS porque
 * la llamada a api.anthropic.com la hace el servidor, no el navegador.
 *
 * Variables de entorno requeridas en Vercel:
 *   ANTHROPIC_API_KEY  →  tu API Key de Anthropic
 */

export const config = { runtime: 'edge' };   // Edge Runtime: más rápido y gratuito en Vercel

export default async function handler(req) {
  // ── 1. Solo aceptar POST ──
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Método no permitido' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── 2. Leer API key del entorno ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY no configurada en las variables de entorno de Vercel.' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── 3. Leer el body enviado por el frontend ──
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Body JSON inválido.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { base64, mimeType } = body;

  if (!base64 || !mimeType) {
    return new Response(JSON.stringify({ error: 'Faltan campos: base64 y mimeType.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── 4. Validar MIME type ──
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const safeMime = allowed.includes(mimeType) ? mimeType : 'image/jpeg';

  // ── 5. Construir el prompt ──
  const prompt = `Analiza el enunciado de física mecánica que aparece en la imagen.
Extrae todos los datos del problema y devuelve SOLO un objeto JSON (sin texto extra, sin markdown) con exactamente estos campos:

{
  "cuerpos": [
    {
      "id": 1,
      "masa": 10,
      "angulo_superficie": 0,
      "fuerzas": [
        { "tipo": "Tension",  "magnitud": 50, "angulo": 0   },
        { "tipo": "Externa",  "magnitud": 20, "angulo": 45  },
        { "tipo": "Friccion", "magnitud": 10, "angulo": 180 }
      ]
    }
  ],
  "incognita_a_resolver": "aceleracion",
  "condicion": "dinamico",
  "mu_rozamiento": 0.25,
  "gravedad": 9.8,
  "explicacion_paso_a_paso": "Descripción breve del problema en español."
}

Reglas:
1. "masa" en kg.
2. "angulo_superficie": ángulo del plano inclinado (0 si superficie plana).
3. "tipo": exactamente "Tension", "Externa" o "Friccion".
4. "angulo": grados antihorario desde eje X+ (0=derecha, 90=arriba, 180=izquierda, 270=abajo).
5. "condicion": "equilibrio" o "dinamico".
6. "incognita_a_resolver": "normal", "tension", "friccion", "aceleracion" o "fuerza_ext".
7. NO incluyas Normal ni Peso en "fuerzas" — se calculan automáticamente.
8. Si hay varios cuerpos (poleas, bloques conectados), inclúyelos todos.
9. Si un dato no está claro, usa el valor más razonable.`;

  // ── 6. Llamar a la API de Anthropic ──
  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system:     'Eres un experto en Física Mecánica. Respondes ÚNICAMENTE con JSON válido, sin texto adicional, sin markdown.',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: safeMime, data: base64 }
              },
              { type: 'text', text: prompt }
            ]
          }
        ]
      })
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Error de red al contactar Anthropic: ' + err.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── 7. Manejar errores de la API ──
  if (!anthropicRes.ok) {
    const errData = await anthropicRes.json().catch(() => ({}));
    const msg = errData?.error?.message || `HTTP ${anthropicRes.status}`;
    return new Response(
      JSON.stringify({ error: `Anthropic API error ${anthropicRes.status}: ${msg}` }),
      { status: anthropicRes.status, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── 8. Extraer y limpiar el JSON devuelto por Claude ──
  const data = await anthropicRes.json();
  let rawText = (data?.content ?? [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Limpiar bloques markdown si Claude los añade
  rawText = rawText.trim()
    .replace(/^```json\s*/i, '').replace(/\s*```\s*$/i, '')
    .replace(/^```\s*/i,    '').replace(/\s*```\s*$/i, '');

  // Extraer el JSON más externo por si hay texto decorativo
  const first = rawText.indexOf('{');
  const last  = rawText.lastIndexOf('}');
  if (first !== -1 && last > first) rawText = rawText.substring(first, last + 1);

  // ── 9. Validar que es JSON parseable antes de devolver ──
  try {
    JSON.parse(rawText);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Claude devolvió respuesta no parseable: ' + e.message }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // ── 10. Devolver el JSON al frontend con headers CORS ──
  return new Response(rawText, {
    status: 200,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',         // Permite llamadas desde cualquier origen
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type',
    }
  });
}
