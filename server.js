const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

// Agenda de partidos
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('a', { timeout: 10000 }).catch(() => {});

    const events = await page.evaluate(() => {
      const items = document.querySelectorAll('a');
      let results = [];
      
      items.forEach((el, index) => {
        const text = el.innerText || '';
        const href = el.href || '';
        
        if (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-')) {
          let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          
          let time = lines.find(l => /^\d{2}:\d{2}$/.test(l)) || 'En Vivo';
          let eventName = lines.find(l => l.toLowerCase().includes('vs')) || lines[0] || 'Partido en Directo';
          let league = lines.find(l => !l.includes('vs') && !/^\d{2}:\d{2}$/.test(l)) || 'Deportes';

          if (href && !results.some(r => r.streamUrl === href)) {
            results.push({
              idEvent: 'match_' + index,
              strEvent: eventName.replace(/\n/g, ' '),
              strLeague: league,
              strTime: time,
              streamUrl: href
            });
          }
        }
      });

      return results;
    });

    await browser.close();
    res.json({ success: true, count: events.length, events });

  } catch (error) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message, events: [] });
  }
});

// Proxy Extractor: Extrae solo el iframe del reproductor limpia sin menús de la web
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://futbolvivo.tv/'
      }
    });

    const html = await response.text();
    
    // Buscar el iframe real del reproductor dentro del código de la página
    const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    
    // Filtrar iframes de publicidad o contadores
    const validIframes = iframeMatches.filter(src => 
      !src.includes('googletagmanager') && 
      !src.includes('facebook') && 
      !src.includes('analytics') &&
      !src.includes('doubleclick')
    );

    let playerUrl = validIframes[0] || null;

    if (playerUrl) {
      // Ajustar URLs relativas si existen
      if (playerUrl.startsWith('/')) {
        const parsed = new URL(targetUrl);
        playerUrl = `${parsed.protocol}//${parsed.host}${playerUrl}`;
      } else if (!playerUrl.startsWith('http')) {
        const parsed = new URL(targetUrl);
        playerUrl = `${parsed.protocol}//${parsed.host}/${playerUrl}`;
      }

      // Entregar únicamente el reproductor ocupando el 100% de tu pantalla
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <meta charset="utf-8">
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
          <iframe src="${playerUrl}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>
        </body>
        </html>
      `);
    }

    // Si la web no usa iframe directo, devolvemos el HTML limpio de anuncios
    let cleanHtml = html.replace(/<head>/i, `<head><script>window.open=function(){};window.alert=function(){};</script>`);
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(cleanHtml);

  } catch (e) {
    return res.status(500).send(`
      <style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;">
        <h3>No se pudo obtener el reproductor.</h3>
        <p style="font-size:12px;color:#888;">Prueba con otro partido de la agenda.</p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});