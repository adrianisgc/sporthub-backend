const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const axios = require('axios');

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

// Proxy desinfectante con bypass de Framebusting y dominio base
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://futbolvivo.tv/'
      },
      timeout: 15000
    });

    let html = response.data;
    const parsedUrl = new URL(targetUrl);
    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;

    // Inyección de scripts de camuflaje antes de cargar el reproductor
    const stealthHeader = `
      <head>
        <base href="${baseUrl}">
        <script>
          // Engañar a los detectores de iframe para que crean que es la pestaña principal
          try {
            Object.defineProperty(window, 'top', { get: function() { return window.self; } });
            Object.defineProperty(window, 'parent', { get: function() { return window.self; } });
          } catch(e) {}
          window.open = function() { return null; };
          window.alert = function() {};
        </script>
    `;

    html = html.replace(/<head>/i, stealthHeader);

    // Eliminar restricciones de seguridad en las cabeceras
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    
    return res.send(html);

  } catch (e) {
    return res.status(500).send(`
      <style>body{background:#000;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style>
      <div style="text-align:center;">
        <h3>Conectando con el servidor del partido...</h3>
        <p style="font-size:12px;color:#888;">Si tarda en responder, prueba seleccionar otro evento de la lista.</p>
      </div>
    `);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
});