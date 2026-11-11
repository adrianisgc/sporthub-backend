const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Cabeceras exactas para simular un navegador real y evitar bloqueos de Cloudflare
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1'
};

let cache = { data: null, time: 0 };

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.time < 45000)) {
    return res.json(cache.data);
  }

  // Multi-espejo: Si el dominio principal bloquea la IP de Render, usa alternativas exactas
  const mirrors = [
    'https://tarjetarojadirect.live/',
    'https://futbolvivo.tv/',
    'https://pirlotv.fr/'
  ];

  let events = [];
  let errorMsg = '';

  for (let url of mirrors) {
    try {
      events = await scrapeTarget(url);
      if (events.length > 0) break; // Si encuentra partidos, detiene la búsqueda
    } catch (e) {
      errorMsg = e.message;
    }
  }

  if (events.length > 0) {
    const payload = { success: true, count: events.length, events };
    cache = { data: payload, time: now };
    return res.json(payload);
  } else {
    if (cache.data) return res.json(cache.data);
    return res.json({ success: false, count: 0, events: [], error: 'Bloqueo de red en todos los espejos.' });
  }
});

async function scrapeTarget(targetUrl) {
  const response = await fetch(targetUrl, { headers: HEADERS });
  if (!response.ok) return [];
  const html = await response.text();

  let events = [];
  const regexBloques = /<(li|tr|div)[^>]*>(.*?)<\/\1>/gis;
  let bloqueMatch;

  while ((bloqueMatch = regexBloques.exec(html)) !== null) {
    const htmlBloque = bloqueMatch[2];
    
    // Buscar enlaces y horas en el bloque
    const timeMatch = htmlBloque.match(/\b\d{1,2}:\d{2}\b/);
    const isLive = htmlBloque.toLowerCase().includes('en vivo');
    
    if (!timeMatch && !isLive) continue;

    const time = isLive ? 'EN VIVO' : timeMatch[0];
    
    const linksRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    let linkMatch;
    let enlaces = [];
    
    while ((linkMatch = linksRegex.exec(htmlBloque)) !== null) {
      const href = linkMatch[1];
      const text = linkMatch[2].replace(/<[^>]+>/g, '').trim();
      if (href && href !== '#' && !href.startsWith('javascript')) {
        let finalUrl = href;
        try { finalUrl = new URL(href, targetUrl).href; } catch(e){}
        enlaces.push({ url: finalUrl, text: text });
      }
    }

    if (enlaces.length === 0) continue;

    let title = "";
    let options = [];
    
    enlaces.forEach((l, index) => {
      if (l.text.toLowerCase().includes('vs') || l.text.includes('-')) {
        title = l.text;
      } else {
        let nombre = l.text.replace(/Canales\s*▼?/gi, '').trim();
        if (!nombre || nombre.toLowerCase() === 'ver en vivo') nombre = `Canal ${options.length + 1}`;
        options.push({ name: nombre, url: l.url, lang: 'Español' });
      }
    });

    if (!title && enlaces.length > 0) {
      title = enlaces[0].text;
    }

    let cleanTitle = title.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
    if (cleanTitle.length < 5) continue;

    let sport = 'FÚTBOL';
    const upper = htmlBloque.toUpperCase();
    if (upper.includes('BALONCESTO') || upper.includes('NBA')) sport = 'BALONCESTO';
    else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
    else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
    else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
    else if (upper.includes('UFC') || upper.includes('BOXEO')) sport = 'UFC';
    else if (upper.includes('MOTOR') || upper.includes('F1')) sport = 'MOTOR';

    if (options.length === 0) {
      options.push({ name: 'Emisión 1', url: enlaces[0].url, lang: 'Español' });
    }

    if (!events.some(e => e.strEvent === cleanTitle)) {
      events.push({
        idEvent: 'tr_' + events.length,
        strEvent: cleanTitle,
        sport: sport,
        strTime: time,
        options: options
      });
    }
  }

  return events;
}

// Proxy de Emisión
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': HEADERS['User-Agent'], 'Referer': 'https://tarjetarojadirect.live/' }
    });

    let html = await response.text();
    const streamMatches = [
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*redirectus[^"'\s<>]*)/gi),
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*latin\/[^"'\s<>]*)/gi),
      ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    const candidateUrls = streamMatches.filter(src => src && !src.includes('google') && !src.includes('facebook'));
    let finalPlayerUrl = candidateUrls[0] || null;

    if (finalPlayerUrl) {
      if (finalPlayerUrl.startsWith('//')) finalPlayerUrl = 'https:' + finalPlayerUrl;
      else if (finalPlayerUrl.startsWith('/')) finalPlayerUrl = `${parsedUrl.protocol}//${parsedUrl.host}${finalPlayerUrl}`;
      finalPlayerUrl = finalPlayerUrl.replace(/^http:\/\//i, 'https://');

      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html><head><meta name="referrer" content="no-referrer"><style>body{margin:0;overflow:hidden;background:#000;}iframe{width:100vw;height:100vh;border:0;}</style></head><body><iframe src="${finalPlayerUrl}" allowfullscreen></iframe></body></html>`);
    }

    const stealthCode = `<head><base href="${targetUrl}"><meta name="referrer" content="no-referrer"><style>header,footer,nav,.ads{display:none!important}html,body{background:#000!important;margin:0!important;overflow:hidden!important}iframe,video{width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important}</style></head>`;
    html = html.includes('<head>') ? html.replace(/<head>/i, stealthCode) : stealthCode + html;

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send('<body style="background:#000;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;">Error en la emisión.</body>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));