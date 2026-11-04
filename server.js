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

let browserInstance = null;
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
  }
  return browserInstance;
}

// 1. Scraping de la Agenda de Partidos
app.get('/api/agenda', async (req, res) => {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(r.resourceType())) {
        r.abort();
      } else {
        r.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForSelector('a', { timeout: 8000 }).catch(() => {});

    const events = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      let results = [];
      
      links.forEach((el, index) => {
        const text = (el.innerText || '').trim();
        const href = el.href || '';
        
        if (href && (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-'))) {
          let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          let time = lines.find(l => /^\d{2}:\d{2}$/.test(l)) || 'En Vivo';
          let eventName = lines.find(l => l.toLowerCase().includes('vs')) || lines[0] || 'Partido en Directo';
          let league = lines.find(l => !l.includes('vs') && !/^\d{2}:\d{2}$/.test(l)) || 'Deportes';

          if (!results.some(r => r.streamUrl === href)) {
            results.push({
              idEvent: 'ev_' + index,
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

    await page.close();
    return res.json({ success: true, count: events.length, events });

  } catch (error) {
    if (page) await page.close().catch(() => {});
    return res.json({ success: false, count: 0, events: [] });
  }
});

// 2. Proxy Extractor: Clica automáticamente la señal y extrae el reproductor real
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // Simular clic automático en los botones de "Opción 1" / "Señal 1" si existen en la web origen
    await page.evaluate(() => {
      const clickables = Array.from(document.querySelectorAll('button, a, .opcion, .senial, [class*="option"], [class*="btn"]'));
      const targetBtn = clickables.find(el => {
        const txt = (el.innerText || '').toLowerCase();
        return txt.includes('opcion') || txt.includes('opción') || txt.includes('señal') || txt.includes('senial') || txt.includes('stream');
      });
      if (targetBtn) targetBtn.click();
    }).catch(() => {});

    // Esperar a que el script de origen cree e inserte el iframe del reproductor
    await new Promise(r => setTimeout(r, 2000));

    // Buscar la URL del iframe activo del reproductor
    const realEmbedUrl = await page.evaluate(() => {
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const playerIframe = iframes.find(i => 
        i.src && 
        !i.src.includes('google') && 
        !i.src.includes('facebook') && 
        !i.src.includes('analytics') &&
        !i.src.includes('doubleclick')
      );
      return playerIframe ? playerIframe.src : null;
    });

    await page.close();

    const finalUrl = realEmbedUrl || targetUrl;

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
        <iframe src="${finalUrl}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>
      </body>
      </html>
    `);

  } catch (e) {
    if (page) await page.close().catch(() => {});
    return res.status(500).send(`
      <style>body{background:#060913;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;">
        <h3>No se pudo obtener la señal en directo</h3>
        <p style="font-size:12px;color:#888;">Intenta seleccionar otro evento de la lista.</p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));