const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Cabeceras anti-bot completas para evitar bloqueos 403 / Cloudflare en Render
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1'
};

let cache = { data: null, time: 0 };

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.time < 30000)) {
    return res.json(cache.data);
  }

  try {
    let events = await scrapeTarget('https://tarjetarojadirect.live/');
    
    // Si la web principal no devuelve partidos por bloqueo de IP, usar fuente de respaldo instantánea
    if (!events || events.length === 0) {
      events = await scrapeTarget('https://futbolvivo.tv/');
    }

    const payload = { success: true, count: events.length, events };
    if (events.length > 0) {
      cache = { data: payload, time: now };
    }
    return res.json(payload);

  } catch (error) {
    if (cache.data) return res.json(cache.data);
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

async function scrapeTarget(targetUrl) {
  try {
    const response = await fetch(targetUrl, { headers: BROWSER_HEADERS });
    if (!response.ok) return [];
    const html = await response.text();

    let events = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const rawText = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

      if (!href || href === '#' || href.startsWith('javascript:') || rawText.length < 4) continue;

      const hasVs = rawText.toLowerCase().includes('vs') || rawText.includes('-') || rawText.toLowerCase().includes('f1');
      const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\b/);

      if (hasVs || timeMatch) {
        let fullUrl = href;
        try { fullUrl = new URL(href, targetUrl).href; } catch (e) {}

        const time = timeMatch ? timeMatch[0] : 'EN VIVO';
        let cleanTitle = rawText
          .replace(/\b\d{1,2}:\d{2}\b/g, '')
          .replace(/Ver en Vivo|Canales\s*▼?|LOCAL|•/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!cleanTitle || cleanTitle.length < 3) continue;

        let sport = 'FÚTBOL';
        const upper = rawText.toUpperCase();
        if (upper.includes('BALONCESTO') || upper.includes('BASKET') || upper.includes('NBA')) sport = 'BALONCESTO';
        else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
        else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
        else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
        else if (upper.includes('UFC') || upper.includes('BOXEO')) sport = 'UFC';
        else if (upper.includes('MOTOR') || upper.includes('F1') || upper.includes('GP')) sport = 'MOTOR';

        let existing = events.find(e => e.strEvent.toLowerCase() === cleanTitle.toLowerCase());
        if (existing) {
          if (!existing.options.some(o => o.url === fullUrl)) {
            existing.options.push({ name: `Canal ${existing.options.length + 1}`, url: fullUrl });
          }
        } else {
          events.push({
            idEvent: 'tr_' + events.length,
            strEvent: cleanTitle,
            strLeague: sport,
            strTime: time,
            sport: sport,
            options: [{ name: 'Canal 1', url: fullUrl }]
          });
        }
      }
    }
    return events;
  } catch (e) {
    return [];
  }
}

// Proxy Anti-Publicidad para la reproducción
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': BROWSER_HEADERS['User-Agent'],
        'Referer': `${parsedUrl.protocol}//${parsedUrl.host}/`,
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
      if (finalPlayerUrl.startsWith('//')) finalPlayerUrl = 'https:' + finalPlayerUrl;
      else if (finalPlayerUrl.startsWith('/')) finalPlayerUrl = `${parsedUrl.protocol}//${parsedUrl.host}${finalPlayerUrl}`;

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
          <style>
            html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
            iframe { width: 100%; height: 100%; border: 0; }
          </style>
          <script>
            window.open = function() { return null; };
            window.alert = function() {};
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
        <style>
          header, footer, nav, .sidebar, .ads, .advertisement, .header, .footer, .menu { display: none !important; }
          html, body { background: #000 !important; margin: 0 !important; padding: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
          iframe, video, #player, .player { width: 100% !important; height: 100% !important; position: absolute !important; top: 0 !important; left: 0 !important; }
        </style>
        <script>
          window.open = function() { return null; };
          window.alert = function() {};
        </script>
    `;

    if (html.includes('<head>')) html = html.replace(/<head>/i, stealthCode);
    else html = stealthCode + html;

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send('<body style="background:#000;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;">Error al cargar señal</body>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`));