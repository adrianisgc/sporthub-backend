const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

// 1. Scraping Ultra-Rápido (<200ms) sin Puppeteer ni cuelgues de RAM
app.get('/api/agenda', async (req, res) => {
  try {
    let events = await fetchTarjetaRojaAgenda();
    
    // Si la fuente principal no responde, activar fuente de respaldo automáticamente
    if (!events || events.length === 0) {
      events = await fetchBackupAgenda();
    }

    // Ordenar por la hora de España (CET) más cercana a la hora actual
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

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

    return res.json({ success: true, count: events.length, events });

  } catch (error) {
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

async function fetchTarjetaRojaAgenda() {
  try {
    const response = await fetch('https://tarjetarojadirect.live/', { headers: BROWSER_HEADERS });
    if (!response.ok) return [];
    const html = await response.text();

    let events = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const rawHref = match[1];
      const rawText = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

      if (!rawHref || rawHref === '#' || rawHref.startsWith('javascript:')) continue;
      if (!rawText || rawText.length < 5) continue;

      const hasVs = rawText.toLowerCase().includes('vs') || rawText.includes('-') || rawText.toLowerCase().includes('f1');
      const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\b/);

      if (hasVs || timeMatch) {
        let fullUrl = rawHref;
        try { fullUrl = new URL(rawHref, 'https://tarjetarojadirect.live/').href; } catch (e) {}

        const time = timeMatch ? timeMatch[0] : 'EN VIVO';
        let cleanTitle = rawText
          .replace(/\b\d{1,2}:\d{2}\b/g, '')
          .replace(/Ver en Vivo|Canales\s*▼?|LOCAL|•/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (!cleanTitle || cleanTitle.length < 3) cleanTitle = 'Evento en Directo';

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

async function fetchBackupAgenda() {
  try {
    const response = await fetch('https://futbolvivo.tv/', { headers: BROWSER_HEADERS });
    if (!response.ok) return [];
    const html = await response.text();

    let events = [];
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const rawHref = match[1];
      const rawText = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

      if (rawHref && (rawText.toLowerCase().includes('vs') || rawText.includes('-'))) {
        let fullUrl = rawHref;
        try { fullUrl = new URL(rawHref, 'https://futbolvivo.tv/').href; } catch (e) {}

        const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\b/);
        const time = timeMatch ? timeMatch[0] : 'EN VIVO';
        const cleanTitle = rawText.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();

        events.push({
          idEvent: 'bk_' + events.length,
          strEvent: cleanTitle || 'Evento Deportivo',
          strLeague: 'FÚTBOL',
          strTime: time,
          sport: 'FÚTBOL',
          options: [{ name: 'Canal 1', url: fullUrl }]
        });
      }
    }
    return events;
  } catch (e) {
    return [];
  }
}

// 2. HTTP Proxy Directo Anti-Publicidad
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

          document.addEventListener('DOMContentLoaded', function() {
            setTimeout(function() {
              var btns = Array.from(document.querySelectorAll('button, a, .opcion, .senial, [class*="option"], [class*="btn"]'));
              var target = btns.find(function(el) {
                var t = (el.innerText || '').toLowerCase();
                return t.includes('opcion') || t.includes('opción') || t.includes('señal') || t.includes('senial') || t.includes('stream') || t.includes('ver');
              });
              if (target) target.click();
            }, 300);
          });
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
      <div style="text-align:center;"><h3>Error al cargar el reproductor</h3></div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`));