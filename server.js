const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    console.log('🔄 Iniciando navegador fantasma para buscar partidos limpios...');
    
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

    // 🛑 FILTRO ANTI-ANUNCIOS POTENTE: Bloquea dominios de publicidad y pop-ups en la nube
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url().toLowerCase();
      const resourceType = request.resourceType();
      
      // Bloquear imágenes innecesarias para que vaya más rápido y dominios de anuncios típicos
      if (
        resourceType === 'image' || 
        resourceType === 'stylesheet' ||
        url.includes('ads') || 
        url.includes('banner') || 
        url.includes('popup') || 
        url.includes('tracker') || 
        url.includes('analytics') ||
        url.includes('doubleclick') ||
        url.includes('googlesyndication')
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Establecer un User-Agent de ordenador real para evitar bloqueos
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log('🌐 Navegando a futbolvivo.tv...');
    await page.goto('https://futbolvivo.tv/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Esperar a que carguen los partidos de la agenda
    await page.waitForSelector('.match-item, .event-item, tr, li', { timeout: 10000 }).catch(() => {});

    // Extraer los eventos de forma limpia
    const events = await page.evaluate(() => {
      const items = document.querySelectorAll('a'); // Cogemos los enlaces que suelen contener los partidos
      let results = [];
      
      items.forEach((el, index) => {
        const text = el.innerText || '';
        const href = el.href || '';
        
        // Filtrar elementos que parezcan partidos (contengan "vs" o nombres de equipos)
        if (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-')) {
          let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          
          let time = lines.find(l => /^\d{2}:\d{2}$/.test(l)) || 'En Vivo';
          let eventName = lines.find(l => l.toLowerCase().includes('vs')) || lines[0] || 'Partido sin nombre';
          let league = lines.find(l => !l.includes('vs') && !/^\d{2}:\d{2}$/.test(l)) || 'Fútbol / Deportes';

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

    console.log(`✅ ¡Éxito! Se han extraído ${events.length} partidos limpios.`);
    await browser.close();

    res.json({ success: true, count: events.length, events });

  } catch (error) {
    console.error('❌ Error al raspar la web:', error);
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: error.message, events: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor anti-anuncios activo en el puerto ${PORT}`);
});