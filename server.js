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
    console.log('🔄 Cargando agenda de partidos...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.match-item, .event-item, tr, li', { timeout: 10000 }).catch(() => {});

    const events = await page.evaluate(() => {
      const items = document.querySelectorAll('a');
      let results = [];
      
      items.forEach((el, index) => {
        const text = el.innerText || '';
        const href = el.href || '';
        
        if (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-')) {
          let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          
          let time = lines.find(l => /^\d{2}:\d{2}$/.test(l)) || 'En Vivo';
          let eventName = lines.find(l => l.toLowerCase().includes('vs')) || lines[0] || 'Partido sin nombre';
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

// 🛡️ PROXY ANTI-BLOQUEOS: Salta X-Frame-Options y limpia publicidad
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta URL');

  try {
    const response = await axios.get(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': targetUrl
      },
      responseType: 'text',
      timeout: 10000
    });

    // 1. Eliminar cabeceras que provocan el rechazo de conexión
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');

    let html = response.data;
    
    // 2. Inyectar desinfección anti pop-ups
    html = html.replace('<head>', '<head><script>window.open = function(){}; window.alert = function(){};</script>');

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (e) {
    res.send(`<style>body{background:#060913;color:#fff;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}</style><div><h2>Cargando señal...</h2><script>setTimeout(()=>location.reload(), 3000);</script></div>`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor Proxy activo en el puerto ${PORT}`);
});