const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    console.log('🔄 Buscando partidos y extrayendo enlaces directos...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.match-item, .event-item, tr, li', { timeout: 10000 }).catch(() => {});

    // Extraer partidos y buscar flujos directos si es posible
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

    console.log(`✅ Agenda sincronizada: ${events.length} eventos encontrados.`);
    await browser.close();

    res.json({ success: true, count: events.length, events });

  } catch (error) {
    console.error('❌ Error en el servidor:', error);
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message, events: [] });
  }
});

// NUEVA RUTA: Extrae el flujo de vídeo limpio del enlace del partido para evitar bloqueos e iframes con anuncios
app.get('/api/resolve', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ success: false, error: 'Falta la URL' });

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    let videoSource = '';

    // Interceptar peticiones de red para cazar enlaces de vídeo HLS (.m3u8) o reproductores internos directos
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('.m3u8') || u.includes('.mp4') || u.includes('embed') || u.includes('player')) {
        if (!videoSource && !u.includes('ads')) {
          videoSource = u;
        }
      }
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Esperar un par de segundos a que el reproductor interno cargue su script
    await new Promise(r => setTimeout(r, 4000));

    // Si no capturó un .m3u8 por red, buscar iframes internos dentro de la página del partido
    if (!videoSource) {
      videoSource = await page.evaluate(() => {
        const iframe = document.querySelector('iframe');
        return iframe ? iframe.src : '';
      });
    }

    await browser.close();
    res.json({ success: true, stream: videoSource || targetUrl });

  } catch (e) {
    if (browser) await browser.close();
    res.json({ success: false, stream: targetUrl }); // Si falla, devuelve la original
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor inteligente activo en el puerto ${PORT}`);
});