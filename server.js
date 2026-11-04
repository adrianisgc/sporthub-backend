const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

// Reutilizar instancia de navegador para optimizar memoria RAM en Render
let globalBrowser = null;
async function getBrowser() {
  if (!globalBrowser || !globalBrowser.isConnected()) {
    globalBrowser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
      ]
    });
  }
  return globalBrowser;
}

// Agenda de partidos
app.get('/api/agenda', async (req, res) => {
  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // Bloquear recursos innecesarios para ahorrar RAM
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 30000 });

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

    await page.close();
    res.json({ success: true, count: events.length, events });
  } catch (error) {
    if (page) await page.close().catch(() => {});
    res.status(500).json({ success: false, error: error.message, events: [] });
  }
});

// Proxy extractor de red
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  let page = null;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    let streamFoundUrl = null;

    // Interceptación de peticiones de red para capturar el reproductor o stream real
    await page.setRequestInterception(true);
    page.on('request', (interceptedReq) => {
      const url = interceptedReq.url();
      if (url.includes('.m3u8') || url.includes('embed') || url.includes('player')) {
        if (!streamFoundUrl && !url.includes('google') && !url.includes('analytics')) {
          streamFoundUrl = url;
        }
      }
      if (['image', 'font', 'stylesheet'].includes(interceptedReq.resourceType())) {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Esperar a que los scripts dinámicos inserten el reproductor
    await new Promise(r => setTimeout(r, 2500));

    // Si no capturó por red, buscar iframe en el DOM evaluado
    if (!streamFoundUrl) {
      streamFoundUrl = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll('iframe'));
        const valid = iframes.find(i => i.src && !i.src.includes('google') && !i.src.includes('facebook'));
        return valid ? valid.src : null;
      });
    }

    await page.close();

    const finalUrl = streamFoundUrl || targetUrl;

    // Si es un flujo HLS directo, devolver JSON para que HLS.js lo reproduzca nativo
    if (finalUrl.includes('.m3u8')) {
      return res.json({ type: 'hls', url: finalUrl });
    }

    // Si es un iframe embebible, servir plantilla HTML limpia sin bloqueos ni cabeceras restrictivas
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
        <iframe src="${finalUrl}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>
      </body>
      </html>
    `);

  } catch (e) {
    if (page) await page.close().catch(() => {});
    return res.status(500).send(`
      <style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;">
        <h3>Signal Timeout</h3>
        <p style="font-size:12px;color:#888;">No se pudo extraer la señal automáticamente. Intenta con otro canal de la lista.</p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor optimizado activo en puerto ${PORT}`);
});