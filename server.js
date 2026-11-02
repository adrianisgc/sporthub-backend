const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/api/agenda', async (req, res) => {
  let browser;
  try {
    console.log('🚀 Abriendo navegador virtual (esto tarda unos segundos)...');
    
    // Inicia un Chrome invisible
    browser = await puppeteer.launch({ 
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    console.log('🔄 Esperando a que la web cargue los partidos con su JavaScript...');
    
    // Entra a la web y ESPERA a que la red se calme (asegura que todo cargó)
    await page.goto('https://futbolvivo.tv/', { waitUntil: 'networkidle2', timeout: 30000 });

    // Extrae el texto tal cual se ve en la pantalla, ignorando el código HTML lioso
    const matches = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      
      document.querySelectorAll('a').forEach(a => {
        const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
        const href = a.href;
        
        if (/(vs\.?|v\.|contra|-)/i.test(text) && text.length > 5 && text.length < 150) {
          const timeMatch = text.match(/\b\d{1,2}:\d{2}\b/);
          const time = timeMatch ? timeMatch[0] : 'En Vivo';
          
          let cleanText = text
            .replace(/\b\d{1,2}:\d{2}\b/g, '')
            .replace(/^(EN VIVO|LIVE|VIVO|\d+\s*min|Mañana[^\:]*)/i, '')
            .replace(/^[\s:>–\-⚽🏆🏀🏎️⚾🏈🎾]+|[\s:>–\-]+$/g, '')
            .trim();
          
          if (cleanText.length > 3) {
            let league = 'Fútbol en Vivo';
            let event = cleanText;
            
            if (cleanText.includes(':')) {
              const parts = cleanText.split(':');
              league = parts[0].trim();
              event = parts.slice(1).join(':').trim();
            }
            
            const key = `${time}-${event.toLowerCase()}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push({
                idEvent: `match_${results.length + 1}`,
                strTime: time,
                strLeague: league,
                strEvent: event,
                streamUrl: href
              });
            }
          }
        }
      });
      return results;
    });

    await browser.close();
    console.log(`✅ ¡Por fin! Se han extraído ${matches.length} partidos reales de la pantalla.`);
    res.json({ events: matches });

  } catch (error) {
    console.error('❌ Error en el navegador virtual:', error.message);
    if (browser) await browser.close();
    res.status(500).json({ error: error.message, events: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor en la nube activo en el puerto ${PORT}`);
});