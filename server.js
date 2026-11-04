const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const PUPPETEER_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu'
];

// 1. Endpoint Agenda (Protegido contra caídas de Render)
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Bloquear elementos pesados para ahorrar memoria
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(r.resourceType())) {
        r.abort();
      } else {
        r.continue();
      }
    });

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

    await browser.close();
    return res.json({ success: true, count: events.length, events });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.json({ 
      success: false, 
      count: 0, 
      events: [],
      message: 'Error temporal de carga' 
    });
  }
});

// 2. Proxy Anti-Bloqueos Ligero
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

    let html = await response.text();
    const parsedUrl = new URL(targetUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

    const injectedHead = `
      <head>
        <base href="${baseUrl}">
        <meta name="referrer" content="no-referrer">
        <script>
          window.open = function() { return null; };
          window.alert = function() {};
          try {
            Object.defineProperty(window, 'top', { get: function() { return window.self; } });
            Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
          } catch(e) {}
        </script>
    `;

    html = html.replace(/<head>/i, injectedHead);

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send(`
      <style>body{background:#060913;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;">
        <h3>No se pudo cargar la señal</h3>
        <p style="font-size:12px;color:#888;">Intenta seleccionar otro evento de la lista.</p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor SportHub Pro activo en puerto ${PORT}`);
});