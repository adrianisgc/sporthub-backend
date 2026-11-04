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

// Ruta Proxy limpia (soluciona "Cannot GET /api/proxy")
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await new Promise(r => setTimeout(r, 2000));

    // Extraer iframe interno del reproductor
    const embedUrl = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return iframe ? iframe.src : null;
    });

    await browser.close();

    const finalUrl = embedUrl || targetUrl;

    res.setHeader('Content-Type', 'text/html');
    res.send(`
      <!DOCTYPE html>
      <html>
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
        <iframe src="${finalUrl}" allowfullscreen allow="autoplay; encrypted-media; picture-in-picture"></iframe>
      </body>
      </html>
    `);

  } catch (e) {
    if (browser) await browser.close();
    res.status(500).send('Error al cargar la señal');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en el puerto ${PORT}`);
});