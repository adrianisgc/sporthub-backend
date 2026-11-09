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

// 1. Scraping de la Agenda Completa de Tarjeta Roja Directa
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await page.goto('https://tarjetarojadirect.live/', { waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));

    const events = await page.evaluate(() => {
      let results = [];
      const allDivs = Array.from(document.querySelectorAll('div, li, tr, article, section'));
      
      // Filtrar contenedores que tengan "VS", "-" o patrón de hora
      const candidateDivs = allDivs.filter(el => {
        const txt = el.innerText || '';
        return (txt.includes('VS') || txt.includes('vs') || txt.includes('-')) && 
               /\b\d{2}:\d{2}\b/.test(txt) && 
               el.children.length > 0 && 
               el.children.length < 25;
      });

      const matchContainers = candidateDivs.filter(el => 
        !Array.from(el.children).some(child => candidateDivs.includes(child))
      );

      // Fallback por si la estructura cambia a enlaces directos
      if (matchContainers.length === 0) {
        const links = Array.from(document.querySelectorAll('a'));
        links.forEach((l, idx) => {
          const txt = (l.innerText || l.textContent || '').trim();
          let href = l.getAttribute('href') || '';
          if (href && (txt.toLowerCase().includes('vs') || txt.includes('-') || /\b\d{2}:\d{2}\b/.test(txt))) {
            try { href = new URL(href, 'https://tarjetarojadirect.live/').href; } catch(e){}
            results.push({
              idEvent: 'ev_' + idx,
              strEvent: txt.replace(/\b\d{2}:\d{2}\b/g, '').trim() || `Partido ${idx + 1}`,
              strLeague: 'FUTBOL',
              strTime: (txt.match(/\b\d{2}:\d{2}\b/) || ['EN VIVO'])[0],
              sport: 'FUTBOL',
              options: [{ name: 'Señal 1', url: href }]
            });
          }
        });
        return results;
      }

      matchContainers.forEach((container, index) => {
        const rawText = (container.innerText || '').replace(/\s+/g, ' ').trim();
        
        const timeMatch = rawText.match(/\b\d{2}:\d{2}\b/);
        const time = timeMatch ? timeMatch[0] : 'EN VIVO';
        
        let links = Array.from(container.querySelectorAll('a'));
        if (links.length === 0 && container.parentElement) {
          links = Array.from(container.parentElement.querySelectorAll('a'));
        }

        let channelOptions = [];
        links.forEach((l) => {
          let href = l.getAttribute('href') || l.href || '';
          if (!href || href === '#' || href.startsWith('javascript:')) return;
          try { href = new URL(href, 'https://tarjetarojadirect.live/').href; } catch(e) {}
          
          let name = (l.innerText || l.textContent || '').trim();
          if (!name || name === 'Ver en Vivo' || name.includes('Canales')) {
            name = `Canal ${channelOptions.length + 1}`;
          }
          if (!channelOptions.some(o => o.url === href)) {
            channelOptions.push({ name, url: href });
          }
        });

        // Clasificar deporte según la etiqueta de Tarjeta Roja
        let sport = 'FUTBOL';
        const lower = rawText.toLowerCase();
        if (lower.includes('baloncesto') || lower.includes('nba') || lower.includes('basket')) sport = 'BASKET';
        else if (lower.includes('hockey') || lower.includes('nhl')) sport = 'HOCKEY';
        else if (lower.includes('americano') || lower.includes('nfl')) sport = 'NFL';
        else if (lower.includes('béisbol') || lower.includes('mlb')) sport = 'MLB';
        else if (lower.includes('ufc') || lower.includes('boxeo')) sport = 'UFC';
        else if (lower.includes('f1') || lower.includes('motor') || lower.includes('gp') || lower.includes('nascar')) sport = 'MOTOR';

        let title = rawText
          .replace(/\b\d{2}:\d{2}\b/g, '')
          .replace(/Local\s*•?\s*\d+\/\d+/gi, '')
          .replace(/FÚTBOL|BALONCESTO|HOCKEY|AMERICANO|BÉISBOL|UFC|BOXEO|MOTOR/gi, '')
          .replace(/Canales\s*▼?|Ver en Vivo|CANALES Y ENLACES OFICIALES:?|EMISIÓN EN DIRECTO/gi, '')
          .replace(/\s+/g, ' ')
          .trim();

        if (title.length > 3 && channelOptions.length > 0) {
          if (!results.some(r => r.strEvent.toLowerCase() === title.toLowerCase())) {
            results.push({
              idEvent: 'ev_' + index,
              strEvent: title,
              strLeague: sport,
              strTime: time,
              sport: sport,
              options: channelOptions
            });
          }
        }
      });

      return results;
    });

    await browser.close();

    // Ordenar por hora de España (CET)
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

// 2. Proxy HTTP Anti-Anuncios
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
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