const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

let cache = { data: null, time: 0 };

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  // Caché de 2 minutos para no sobrecargar el servidor
  if (cache.data && (now - cache.time < 120000)) {
    return res.json(cache.data);
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
    });
    
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    await page.goto('https://tarjetarojadirect.live/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Esperar un poco para que Cloudflare resuelva
    await new Promise(r => setTimeout(r, 2000));

    const events = await page.evaluate(() => {
      let results = [];
      // Extraer todas las filas de la web
      const rows = Array.from(document.querySelectorAll('li, tr, article, .match, .row'));

      rows.forEach(row => {
        const text = row.innerText.replace(/\s+/g, ' ').trim();
        
        // FILTRO ESTRICTO: Debe tener una hora (ej. 15:30) y el texto "VS" o "-"
        const timeMatch = text.match(/\b\d{1,2}:\d{2}\b/);
        const isLive = text.toLowerCase().includes('en vivo');
        const hasVs = text.toLowerCase().includes('vs') || text.includes('-');
        
        // Ignorar textos basura del footer como "Aviso Legal" o "Tarjeta Roja TV"
        if (text.toLowerCase().includes('aviso legal') || text.toLowerCase().includes('pirlo tv')) return;

        if ((timeMatch || isLive) && hasVs) {
          const time = isLive ? 'EN VIVO' : timeMatch[0];
          
          // Extraer enlaces de este partido
          const links = Array.from(row.querySelectorAll('a'));
          let options = [];
          
          links.forEach(a => {
            if (a.href && !a.href.includes('javascript') && a.href !== '#') {
              let btnText = a.innerText.replace(/Canales\s*▼?/gi, '').trim();
              if (!btnText || btnText.toLowerCase() === 'ver en vivo') btnText = `Canal ${options.length + 1}`;
              
              // Evitar meter enlaces del footer
              if (!btnText.toLowerCase().includes('aviso legal')) {
                options.push({ name: btnText, url: a.href, lang: 'ES' });
              }
            }
          });

          // Limpiar el título
          let title = text.replace(/\b\d{1,2}:\d{2}\b/g, '').replace(/Ver en Vivo|Canales|▼/gi, '').trim();
          
          let sport = 'FÚTBOL';
          const upper = text.toUpperCase();
          if (upper.includes('BALONCESTO') || upper.includes('NBA')) sport = 'BALONCESTO';
          else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
          else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
          else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
          else if (upper.includes('MOTOR') || upper.includes('F1')) sport = 'MOTOR';

          if (title.length > 5 && options.length > 0) {
            // Evitar duplicados
            if (!results.some(r => r.strEvent === title)) {
              results.push({
                idEvent: 'tr_' + results.length,
                strEvent: title,
                strTime: time,
                sport: sport,
                options: options
              });
            }
          }
        }
      });
      return results;
    });

    await browser.close();

    if (events.length > 0) {
      const payload = { success: true, count: events.length, events };
      cache = { data: payload, time: now };
      return res.json(payload);
    } else {
      throw new Error("Cloudflare bloqueó la carga o cambió la estructura.");
    }

  } catch (error) {
    if (browser) await browser.close().catch(()=>({}));
    if (cache.data) return res.json(cache.data);
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

// Proxy de Reproducción Directa
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://tarjetarojadirect.live/'
      }
    });

    let html = await response.text();
    let parsedUrl = new URL(targetUrl);

    // Buscar iFrames de reproductores comunes
    const streamMatches = [
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*redirectus[^"'\s<>]*)/gi),
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*latin\/[^"'\s<>]*)/gi),
      ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    const candidateUrls = streamMatches.filter(src => src && !src.includes('google') && !src.includes('facebook'));
    let finalPlayerUrl = candidateUrls[0] || null;

    if (finalPlayerUrl) {
      if (finalPlayerUrl.startsWith('//')) finalPlayerUrl = 'https:' + finalPlayerUrl;
      else if (finalPlayerUrl.startsWith('/')) finalPlayerUrl = `${parsedUrl.protocol}//${parsedUrl.host}${finalPlayerUrl}`;
      
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`<!DOCTYPE html><html><head><meta name="referrer" content="no-referrer"><style>body{margin:0;overflow:hidden;background:#000;}iframe{width:100vw;height:100vh;border:0;}</style></head><body><iframe src="${finalPlayerUrl}" allowfullscreen></iframe></body></html>`);
    }

    const stealthCode = `<head><base href="${targetUrl}"><meta name="referrer" content="no-referrer"><style>header,footer,nav,.ads{display:none!important}html,body{background:#000!important;margin:0!important;overflow:hidden!important}iframe,video{width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important}</style></head>`;
    html = html.includes('<head>') ? html.replace(/<head>/i, stealthCode) : stealthCode + html;

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send('<body style="background:#000;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;">Error cargando señal.</body>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor activo en puerto ${PORT}`));