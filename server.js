const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const PUPPETEER_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process'
];

// 1. Scraping de la Agenda Completa (Fútbol, Básquet, F1/Motor)
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(r.resourceType())) {
        r.abort();
      } else {
        r.continue();
      }
    });

    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('a', { timeout: 8000 }).catch(() => {});

    const events = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      let results = [];

      links.forEach((el, index) => {
        const text = (el.innerText || '').trim();
        const href = el.href || '';
        
        if (href && href.startsWith('http') && (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-') || text.toLowerCase().includes('grand prix') || text.toLowerCase().includes('f1'))) {
          let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          
          let timeMatch = lines.find(l => /^\d{2}:\d{2}$/.test(l));
          let time = timeMatch || 'En Vivo';
          
          let eventName = lines.find(l => l.toLowerCase().includes('vs') || l.toLowerCase().includes('f1') || l.toLowerCase().includes('gp')) || lines[0] || 'Evento Deportivo';
          let league = lines.find(l => !l.includes('vs') && !/^\d{2}:\d{2}$/.test(l)) || 'General';

          let sport = 'FUTBOL';
          const fullStr = (eventName + ' ' + league).toLowerCase();
          if (fullStr.includes('f1') || fullStr.includes('formula') || fullStr.includes('moto') || fullStr.includes('nascar') || fullStr.includes('rally')) {
            sport = 'MOTOR';
          } else if (fullStr.includes('basket') || fullStr.includes('nba') || fullStr.includes('acb') || fullStr.includes('euroleague')) {
            sport = 'BASKET';
          }

          let existing = results.find(r => r.strEvent.toLowerCase() === eventName.toLowerCase());
          if (existing) {
            if (!existing.options.some(o => o.url === href)) {
              existing.options.push({ name: `Señal ${existing.options.length + 1}`, url: href });
            }
          } else {
            results.push({
              idEvent: 'ev_' + index,
              strEvent: eventName.replace(/\n/g, ' '),
              strLeague: league,
              strTime: time,
              sport: sport,
              options: [{ name: 'Señal 1', url: href }]
            });
          }
        }
      });
      return results;
    });

    await browser.close();
    browser = null;

    // Ordenar por hora española (CET) más cercana al reloj actual
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    events.sort((a, b) => {
      const isLiveA = a.strTime === 'En Vivo';
      const isLiveB = b.strTime === 'En Vivo';

      if (isLiveA && isLiveB) return 0;
      if (isLiveA) return -1;
      if (isLiveB) return 1;

      const parseMin = (tStr) => {
        if (!tStr || typeof tStr !== 'string' || !tStr.includes(':')) return 9999;
        const parts = tStr.split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        return isNaN(h) || isNaN(m) ? 9999 : h * 60 + m;
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
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

// 2. Extractor de Reproductor Interno Directo
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (urlErr) {
      return res.status(400).send('URL no válida');
    }

    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://futbolvivo.tv/',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });

    let html = await response.text();

    // Extraer iframe del reproductor incrustado de la señal
    const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const embedMatches = [...html.matchAll(/(?:src|file|link|url)["']?\s*[:=]\s*["'](https?:\/\/[^"']+(?:embed|player|stream|live|hls|m3u8)[^"']*)["']/gi)].map(m => m[1]);
    
    const candidateUrls = [...iframeMatches, ...embedMatches].filter(src => 
      src && 
      !src.includes('google') && 
      !src.includes('facebook') && 
      !src.includes('analytics') &&
      !src.includes('doubleclick') &&
      !src.includes('twitter')
    );

    let finalPlayerUrl = candidateUrls[0] || null;

    if (finalPlayerUrl) {
      if (finalPlayerUrl.startsWith('//')) {
        finalPlayerUrl = 'https:' + finalPlayerUrl;
      } else if (finalPlayerUrl.startsWith('/')) {
        finalPlayerUrl = `${parsedUrl.protocol}//${parsedUrl.host}${finalPlayerUrl}`;
      }

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

    // Fallback: Si no hay iframe anidado, inyectar ocultado de menús y auto-clic sobre la plantilla de origen
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
      <div style="text-align:center;"><h3>Error al sintonizar canal</h3></div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`));