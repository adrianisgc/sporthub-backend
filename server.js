const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());

// Configuración avanzada de agente para evitar Cloudflare/403
const fetchConfig = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Cache-Control': 'max-age=0',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
  },
  agent: new https.Agent({ rejectUnauthorized: false })
};

let cache = { data: null, time: 0 };
const CACHE_TTL = 60000; // 60 segundos

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.time < CACHE_TTL)) {
    return res.json(cache.data);
  }

  try {
    const events = await scrapeAgenda('https://tarjetarojadirect.live/');
    
    if (events.length > 0) {
      const payload = { success: true, count: events.length, events };
      cache = { data: payload, time: now };
      return res.json(payload);
    } else {
      throw new Error("No se encontraron partidos o la web bloqueó la petición.");
    }
  } catch (error) {
    if (cache.data) return res.json(cache.data);
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

async function scrapeAgenda(url) {
  try {
    const response = await fetch(url, fetchConfig);
    const html = await response.text();
    let events = [];

    // Regex específica para encontrar los bloques de partido (<li> o <tr> o <div>)
    const matchBlocks = html.match(/<(li|tr|div)[^>]*>(.*?)<\/\1>/gis);
    
    if (!matchBlocks) return [];

    matchBlocks.forEach((block) => {
      // Filtrar contenido irrelevante
      if (!block.includes('href') || (!block.toLowerCase().includes('vs') && !/\b\d{1,2}:\d{2}\b/.test(block))) return;

      const timeMatch = block.match(/\b\d{1,2}:\d{2}\b/);
      const isLive = block.toLowerCase().includes('en vivo');
      const time = isLive ? 'EN VIVO' : (timeMatch ? timeMatch[0] : null);

      if (!time) return;

      // Extraer enlaces de canales
      const links = [...block.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)];
      if (links.length === 0) return;

      let title = "";
      let options = [];
      let sport = "FÚTBOL";

      links.forEach((linkObj, i) => {
          let href = linkObj[1];
          let text = linkObj[2].replace(/<[^>]+>/g, '').trim();

          if (href === '#' || href.startsWith('javascript')) return;
          try { href = new URL(href, url).href; } catch(e){}

          // Determinar si es el enlace del título principal (suele contener VS)
          if (text.toLowerCase().includes('vs') || i === 0 && !text.toLowerCase().includes('canal')) {
              title = text.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
          } else {
              // Es un enlace de canal
              let channelName = text.replace(/Canales\s*▼?/gi, '').trim();
              if(!channelName || channelName.toLowerCase() === 'ver en vivo') channelName = `Opción ${options.length + 1}`;
              options.push({ name: channelName, url: href, lang: 'Español' });
          }
      });

      // Intentar encontrar el título fuera del tag <a> si falló
      if (!title || title.length < 3) {
          const rawText = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const matchVS = rawText.match(/([a-zA-Z0-9\s]+)\s+VS\s+([a-zA-Z0-9\s]+)/i);
          if (matchVS) {
              title = matchVS[0];
          } else {
              title = rawText.replace(/\b\d{1,2}:\d{2}\b/g, '').replace(/Ver en Vivo|Canales|Español/gi, '').trim();
          }
      }

      if (!title || title.length < 4) return;

      // Asignar deporte
      const upperText = block.toUpperCase();
      if (upperText.includes('BALONCESTO') || upperText.includes('NBA')) sport = 'BALONCESTO';
      else if (upperText.includes('HOCKEY') || upperText.includes('NHL')) sport = 'HOCKEY';
      else if (upperText.includes('AMERICANO') || upperText.includes('NFL')) sport = 'AMERICANO';
      else if (upperText.includes('BÉISBOL') || upperText.includes('MLB')) sport = 'BÉISBOL';
      else if (upperText.includes('UFC') || upperText.includes('BOXEO')) sport = 'UFC';
      else if (upperText.includes('MOTOR') || upperText.includes('F1')) sport = 'MOTOR';

      // Evitar duplicados
      if (!events.find(e => e.strEvent === title)) {
          events.push({
              idEvent: 'ev_' + events.length,
              strEvent: title,
              strLeague: sport,
              strTime: time,
              sport: sport,
              options: options.length > 0 ? options : [{ name: 'Ver Emisión', url: links[0][1], lang: 'Español' }]
          });
      }
    });

    return events;
  } catch (err) {
    console.error("Error scraping:", err);
    return [];
  }
}

// Proxy Anti-Publicidad Robusto
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, fetchConfig);
    let html = await response.text();

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
      finalPlayerUrl = finalPlayerUrl.replace(/^http:\/\//i, 'https://');

      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(`
        <!DOCTYPE html>
        <html><head><meta name="referrer" content="no-referrer"><style>body{margin:0;overflow:hidden;background:#000;}iframe{width:100vw;height:100vh;border:0;}</style></head>
        <body><iframe src="${finalPlayerUrl}" allowfullscreen></iframe></body></html>
      `);
    }

    const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    const stealthCode = `<head><base href="${baseUrl}"><meta name="referrer" content="no-referrer"><style>header,footer,nav,.ads{display:none!important}html,body{background:#000!important;margin:0!important;overflow:hidden!important}iframe,video{width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important}</style></head>`;
    html = html.includes('<head>') ? html.replace(/<head>/i, stealthCode) : stealthCode + html;

    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (e) {
    return res.status(500).send('<body style="background:#000;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;">Error al cargar señal. El servidor original no responde.</body>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));