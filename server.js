const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

// Cache en memoria para servir la agenda en <50ms
let agendaCache = { data: null, timestamp: 0 };
const CACHE_TTL = 45 * 1000; // 45 segundos

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  if (agendaCache.data && (now - agendaCache.timestamp < CACHE_TTL)) {
    return res.json(agendaCache.data);
  }

  try {
    const response = await fetch('https://tarjetarojadirect.live/', { headers: HEADERS });
    if (!response.ok) throw new Error('Error al conectar con la fuente');
    const html = await response.text();

    const events = parseTarjetaRojaHTML(html);

    // Ordenar agenda por la hora de España (CET)
    const dateNow = new Date();
    const currentMinutes = dateNow.getHours() * 60 + dateNow.getMinutes();

    events.sort((a, b) => {
      const isLiveA = a.strTime === 'EN VIVO' || a.strTime === 'En Vivo';
      const isLiveB = b.strTime === 'EN VIVO' || b.strTime === 'En Vivo';

      if (isLiveA && isLiveB) return 0;
      if (isLiveA) return -1;
      if (isLiveB) return 1;

      const parseMin = (tStr) => {
        if (!tStr || !tStr.includes(':')) return 9999;
        const parts = tStr.split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        return (isNaN(h) || isNaN(m)) ? 9999 : h * 60 + m;
      };

      let minA = parseMin(a.strTime);
      let minB = parseMin(b.strTime);

      let diffA = minA - currentMinutes;
      let diffB = minB - currentMinutes;

      if (diffA < 0) diffA += 1440;
      if (diffB < 0) diffB += 1440;

      return diffA - diffB;
    });

    const resultPayload = { success: true, count: events.length, events };
    agendaCache = { data: resultPayload, timestamp: now };
    return res.json(resultPayload);

  } catch (error) {
    if (agendaCache.data) return res.json(agendaCache.data);
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

function parseTarjetaRojaHTML(html) {
  let results = [];
  
  // Extraer bloques de partidos
  const matchBlockRegex = /<(div|li|article|tr)[^>]*>(.*?)<\/\1>/gis;
  const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  
  // Extraer todos los hipervínculos válidos de tarjetarojadirect.live
  let allLinks = [];
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    const href = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (href && href !== '#' && !href.startsWith('javascript:') && text.length > 2) {
      let fullUrl = href;
      try { fullUrl = new URL(href, 'https://tarjetarojadirect.live/').href; } catch(e){}
      allLinks.push({ text, url: fullUrl });
    }
  }

  // Agrupar enlaces por eventos
  let currentEvent = null;

  allLinks.forEach((item, idx) => {
    const rawText = item.text;
    const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\b/);
    const hasVs = rawText.toLowerCase().includes('vs') || rawText.includes('-') || rawText.toLowerCase().includes('f1');

    if (hasVs || timeMatch) {
      const time = timeMatch ? timeMatch[0] : 'EN VIVO';
      let title = rawText
        .replace(/\b\d{1,2}:\d{2}\b/g, '')
        .replace(/Ver en Vivo|Canales\s*▼?|LOCAL|•/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!title || title.length < 3) title = `Partido ${results.length + 1}`;

      let sport = 'FÚTBOL';
      const upper = rawText.toUpperCase();
      if (upper.includes('BALONCESTO') || upper.includes('BASKET') || upper.includes('NBA')) sport = 'BALONCESTO';
      else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
      else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
      else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
      else if (upper.includes('UFC') || upper.includes('BOXEO')) sport = 'UFC';
      else if (upper.includes('MOTOR') || upper.includes('F1') || upper.includes('GP')) sport = 'MOTOR';

      let existing = results.find(r => r.strEvent.toLowerCase() === title.toLowerCase());

      if (existing) {
        if (!existing.options.some(o => o.url === item.url)) {
          let name = rawText.includes('Canal') || rawText.includes('Señal') || rawText.includes('TV')
            ? rawText
            : `Canal ${existing.options.length + 1}`;
          existing.options.push({ name, url: item.url });
        }
      } else {
        results.push({
          idEvent: 'tr_' + idx,
          strEvent: title,
          strLeague: sport,
          strTime: time,
          sport: sport,
          options: [{ name: 'Canal 1', url: item.url }]
        });
      }
    } else if (results.length > 0) {
      // Si el enlace es de un canal secundario (ej. "LaLiga TV", "Canal 2 HD")
      let lastEvent = results[results.length - 1];
      if (!lastEvent.options.some(o => o.url === item.url)) {
        lastEvent.options.push({ name: item.text || `Canal ${lastEvent.options.length + 1}`, url: item.url });
      }
    }
  });

  return results;
}

// Proxy Anti-Bloqueos y Anti-Publicidad
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://tarjetarojadirect.live/',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });

    let html = await response.text();

    const streamMatches = [
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*redirectus[^"'\s<>]*)/gi),
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*latin\/[^"'\s<>]*)/gi),
      ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    const candidateUrls = streamMatches.filter(src => 
      src && 
      !src.includes('google') && 
      !src.includes('facebook') && 
      !src.includes('analytics') &&
      !src.includes('doubleclick')
    );

    let finalPlayerUrl = candidateUrls[0] || null;

    if (finalPlayerUrl) {
      if (finalPlayerUrl.startsWith('//')) {
        finalPlayerUrl = 'https:' + finalPlayerUrl;
      } else if (finalPlayerUrl.startsWith('/')) {
        finalPlayerUrl = `${parsedUrl.protocol}//${parsedUrl.host}${finalPlayerUrl}`;
      }

      finalPlayerUrl = finalPlayerUrl.replace(/^http:\/\//i, 'https://');

      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="utf-8">
          <meta name="referrer" content="no-referrer">
          <meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">
          <style>
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
            iframe { width: 100%; height: 100%; border: 0; }
          </style>
          <script>
            window.open = function() { return null; };
            window.alert = function() {};
            try {
              Object.defineProperty(window, 'top', { get: function() { return window.self; } });
              Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
            } catch(e) {}
          </script>
        </head>
        <body>
          <iframe src="${finalPlayerUrl}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>
        </body>
        </html>
      `);
    }

    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    const stealthCode = `
      <head>
        <base href="${baseUrl}">
        <meta name="referrer" content="no-referrer">
        <meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests">
        <style>
          header, footer, nav, .sidebar, .ads, .advertisement, .header, .footer, .menu { display: none !important; }
          html, body { background: #000 !important; margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
          iframe, video, #player, .player { width: 100% !important; height: 100% !important; position: absolute !important; top: 0 !important; left: 0 !important; }
        </style>
        <script>
          window.open = function() { return null; };
          window.alert = function() {};
          try {
            Object.defineProperty(window, 'top', { get: function() { return window.self; } });
            Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
          } catch(e) {}
        </script>
    `;

    if (html.includes('<head>')) {
      html = html.replace(/<head>/i, stealthCode);
    } else {
      html = stealthCode + html;
    }

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send(`
      <style>body{background:#060913;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;"><h3>Error al cargar la transmisión</h3></div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`));