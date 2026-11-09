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

// 1. Scraping Directo y Completo de tarjetarojadirect.live
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    // Carga de la web de Tarjeta Roja esperando al renderizado dinámico
    await page.goto('https://tarjetarojadirect.live/', { waitUntil: 'networkidle2', timeout: 35000 }).catch(async () => {
      await page.goto('https://tarjetarojadirect.live/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    });

    await new Promise(r => setTimeout(r, 2500));

    const events = await page.evaluate(() => {
      let items = [];

      // Buscar todos los bloques que contengan partidos (hora + vs/- + enlaces)
      const allElements = Array.from(document.querySelectorAll('div, tr, li, article'));
      const matchRows = allElements.filter(el => {
        const txt = el.innerText || '';
        return /\b\d{1,2}:\d{2}\b/.test(txt) && 
               (txt.includes('VS') || txt.includes('vs') || txt.includes('-')) && 
               el.querySelectorAll('a').length > 0;
      });

      // Quedarse únicamente con los contenedores más específicos (nodos hoja)
      const leafRows = matchRows.filter(row => !matchRows.some(other => other !== row && row.contains(other)));

      leafRows.forEach((row, index) => {
        const rawText = (row.innerText || '').trim();
        const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
        
        const timeMatch = rawText.match(/\b\d{1,2}:\d{2}\b/);
        const time = timeMatch ? timeMatch[0] : 'EN VIVO';

        // Categorías reales de Tarjeta Roja
        let sport = 'FÚTBOL';
        const upper = rawText.toUpperCase();
        if (upper.includes('BALONCESTO') || upper.includes('BASKET') || upper.includes('NBA')) sport = 'BALONCESTO';
        else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
        else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
        else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
        else if (upper.includes('UFC') || upper.includes('BOXEO')) sport = 'UFC';
        else if (upper.includes('MOTOR') || upper.includes('F1') || upper.includes('GP')) sport = 'MOTOR';

        // Título del evento
        let eventTitle = lines.find(l => l.includes('VS') || l.includes('vs') || l.includes('-')) || lines[0] || `Partido ${index + 1}`;
        eventTitle = eventTitle.replace(/Canales|Ver en Vivo|CANALES Y ENLACES|LOCAL|•/gi, '').trim();

        // Enlaces a canales
        const aTags = Array.from(row.querySelectorAll('a'));
        let options = [];
        aTags.forEach((a, i) => {
          let href = a.getAttribute('href') || a.href || '';
          if (href && href !== '#' && !href.startsWith('javascript:')) {
            try { href = new URL(href, 'https://tarjetarojadirect.live/').href; } catch(e){}
            let name = (a.innerText || a.textContent || '').trim();
            name = name.replace(/Canales\s*▼?/gi, '').trim();
            if (!name || name.toLowerCase() === 'ver en vivo') name = `Canal ${options.length + 1}`;
            
            if (!options.some(o => o.url === href)) {
              options.push({ name, url: href });
            }
          }
        });

        if (options.length > 0 && !items.some(it => it.strEvent.toLowerCase() === eventTitle.toLowerCase())) {
          items.push({
            idEvent: 'tr_' + index,
            strEvent: eventTitle,
            strLeague: sport,
            strTime: time,
            sport: sport,
            options: options
          });
        }
      });

      // Fallback de seguridad: si la estructura HTML cambia, extraer todos los hipervínculos válidos de la portada
      if (items.length === 0) {
        const links = Array.from(document.querySelectorAll('a'));
        links.forEach((a, idx) => {
          const txt = (a.innerText || a.textContent || '').trim();
          let href = a.getAttribute('href') || '';
          if (href && href !== '#' && !href.startsWith('javascript:') && (txt.includes('vs') || txt.includes('-') || /\b\d{2}:\d{2}\b/.test(txt))) {
            try { href = new URL(href, 'https://tarjetarojadirect.live/').href; } catch(e){}
            items.push({
              idEvent: 'fb_' + idx,
              strEvent: txt.replace(/\b\d{2}:\d{2}\b/g, '').trim() || `Evento Deportivo ${idx + 1}`,
              strLeague: 'FÚTBOL',
              strTime: (txt.match(/\b\d{2}:\d{2}\b/) || ['EN VIVO'])[0],
              sport: 'FÚTBOL',
              options: [{ name: 'Ver Transmisión', url: href }]
            });
          }
        });
      }

      return items;
    });

    await browser.close();

    // Ordenamiento por hora española (CET)
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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