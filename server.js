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

// 1. Scraping Agenda (Fútbol, Básquet, Motor/F1) resolviendo URLs relativas
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.goto('https://futbolvivo.tv/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(async () => {
      await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    });

    await new Promise(r => setTimeout(r, 1500));

    const events = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      let results = [];

      links.forEach((el, index) => {
        const rawText = (el.innerText || el.textContent || '').trim();
        let href = el.getAttribute('href') || '';
        
        if (!href || href === '#' || href.startsWith('javascript:')) return;

        // Convertir URLs relativas a absolutas para no descartar partidos
        try {
          href = new URL(href, window.location.origin).href;
        } catch(e) {}

        const text = rawText.replace(/\s+/g, ' ');

        const isMatch = text.toLowerCase().includes('vs') || 
                        text.includes('-') || 
                        text.toLowerCase().includes('f1') || 
                        text.toLowerCase().includes('gp') ||
                        text.toLowerCase().includes('grand prix') ||
                        /\b\d{2}:\d{2}\b/.test(text);

        if (isMatch && href) {
          let timeMatch = text.match(/\b\d{2}:\d{2}\b/);
          let time = timeMatch ? timeMatch[0] : 'En Vivo';
          
          let eventName = text.replace(/\b\d{2}:\d{2}\b/g, '').trim();
          if (!eventName || eventName.length < 3) eventName = `Evento Deportivo ${index + 1}`;

          let sport = 'FUTBOL';
          const lower = (eventName + ' ' + href).toLowerCase();
          if (lower.includes('f1') || lower.includes('formula') || lower.includes('moto') || lower.includes('nascar') || lower.includes('gp')) {
            sport = 'MOTOR';
          } else if (lower.includes('basket') || lower.includes('nba') || lower.includes('acb') || lower.includes('euroleague')) {
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
              strEvent: eventName,
              strLeague: sport === 'MOTOR' ? 'Motor / F1' : (sport === 'BASKET' ? 'Baloncesto' : 'Fútbol'),
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
    if (browser) await browser.close().catch(() => {});
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

// 2. HTTP Proxy Directo
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Referer': 'https://futbolvivo.tv/',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });

    let html = await response.text();

    const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const candidateUrls = iframeMatches.filter(src => 
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
      <div style="text-align:center;"><h3>Error al cargar el reproductor</h3></div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`));