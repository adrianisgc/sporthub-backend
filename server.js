const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache'
};

let cache = { data: null, time: 0 };
const CACHE_TTL = 30000;

app.get('/api/agenda', async (req, res) => {
  const now = Date.now();
  if (cache.data && (now - cache.time < CACHE_TTL)) {
    return res.json(cache.data);
  }

  try {
    let events = await fetchAgendaFromHTML('https://tarjetarojadirect.live/');
    
    // Si falla, probar con la estructura secundaria
    if (!events || events.length === 0) {
      events = await fetchAgendaFromHTML('https://futbolvivo.tv/');
    }

    const payload = { success: true, count: events.length, events };
    if (events.length > 0) cache = { data: payload, time: now };
    
    return res.json(payload);
  } catch (error) {
    if (cache.data) return res.json(cache.data);
    return res.json({ success: false, count: 0, events: [], error: error.message });
  }
});

async function fetchAgendaFromHTML(targetUrl) {
  try {
    const response = await fetch(targetUrl, { headers: HEADERS });
    if (!response.ok) return [];
    const html = await response.text();

    let events = [];
    
    // Extracción limpia usando regex para bloques de lista de partidos (li o tr)
    const rowRegex = /<li[^>]*>(.*?)<\/li>|<tr[^>]*>(.*?)<\/tr>|<div[^>]+class=["'][^"']*match[^"']*["'][^>]*>(.*?)<\/div>/gis;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const rowContent = rowMatch[1] || rowMatch[2] || rowMatch[3] || '';
      
      // Buscar la hora (ej: 15:30) o etiqueta En Vivo
      const timeMatch = rowContent.match(/\b\d{1,2}:\d{2}\b/);
      const isLive = rowContent.toLowerCase().includes('en vivo') || rowContent.toLowerCase().includes('live');
      
      if (!timeMatch && !isLive) continue;

      const time = isLive ? 'EN VIVO' : timeMatch[0];

      // Buscar todos los enlaces en este bloque
      const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
      let links = [];
      let linkMatch;
      while ((linkMatch = linkRegex.exec(rowContent)) !== null) {
        links.push({
          href: linkMatch[1],
          text: linkMatch[2].replace(/<[^>]+>/g, '').trim()
        });
      }

      if (links.length === 0) continue;

      // Encontrar el título principal del partido
      let titleLink = links.find(l => l.text.toLowerCase().includes('vs') || l.text.includes('-'));
      let rawTitle = titleLink ? titleLink.text : links[0].text;
      
      // Si el enlace principal no tiene el texto, buscarlo en el HTML plano
      if (!rawTitle.toLowerCase().includes('vs') && rowContent.toLowerCase().includes('vs')) {
        const textParts = rowContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(' ');
        const vsIndex = textParts.findIndex(p => p.toLowerCase() === 'vs');
        if (vsIndex !== -1) {
           let team1 = textParts.slice(Math.max(0, vsIndex - 4), vsIndex).join(' ');
           let team2 = textParts.slice(vsIndex + 1, Math.min(textParts.length, vsIndex + 5)).join(' ');
           rawTitle = `${team1} VS ${team2}`;
        }
      }

      let cleanTitle = rawTitle.replace(/\b\d{1,2}:\d{2}\b/g, '').replace(/Canales|Ver en Vivo/gi, '').replace(/\s+/g, ' ').trim();
      if (cleanTitle.length < 5) continue;

      // Categoría
      let sport = 'FÚTBOL';
      const upper = rowContent.toUpperCase();
      if (upper.includes('BALONCESTO') || upper.includes('BASKET') || upper.includes('NBA')) sport = 'BALONCESTO';
      else if (upper.includes('HOCKEY') || upper.includes('NHL')) sport = 'HOCKEY';
      else if (upper.includes('AMERICANO') || upper.includes('NFL')) sport = 'AMERICANO';
      else if (upper.includes('BÉISBOL') || upper.includes('MLB')) sport = 'BÉISBOL';
      else if (upper.includes('UFC') || upper.includes('BOXEO')) sport = 'UFC';
      else if (upper.includes('MOTOR') || upper.includes('F1') || upper.includes('GP')) sport = 'MOTOR';

      // Filtrar y agrupar opciones de canales
      let options = [];
      links.forEach((l) => {
        let h = l.href;
        if (!h || h === '#' || h.startsWith('javascript:')) return;
        try { h = new URL(h, targetUrl).href; } catch(e){}
        
        let label = l.text.replace(/Canales\s*▼?/gi, '').trim();
        if (label.toLowerCase() === 'ver en vivo' || label === '') label = `Opción ${options.length + 1}`;
        if (!options.some(o => o.url === h)) {
          options.push({ name: label, url: h, lang: 'Español' });
        }
      });

      if (options.length > 0) {
        events.push({
          idEvent: 'ev_' + events.length,
          strEvent: cleanTitle,
          strLeague: sport,
          strTime: time,
          sport: sport,
          options: options
        });
      }
    }
    
    // Backup por si la estructura HTML es diferente (ej. lista simple de enlaces)
    if (events.length === 0) {
       const allLinksRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
       let m;
       while ((m = allLinksRegex.exec(html)) !== null) {
          const href = m[1];
          const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (href && text.toLowerCase().includes('vs')) {
             let fullUrl = href;
             try { fullUrl = new URL(href, targetUrl).href; } catch(e){}
             const time = (text.match(/\b\d{1,2}:\d{2}\b/) || ['EN VIVO'])[0];
             let title = text.replace(/\b\d{1,2}:\d{2}\b/g, '').trim();
             
             let existing = events.find(e => e.strEvent === title);
             if (existing) {
               if (!existing.options.some(o => o.url === fullUrl)) existing.options.push({ name: `Canal ${existing.options.length + 1}`, url: fullUrl, lang: 'Español' });
             } else {
               events.push({
                 idEvent: 'fb_' + events.length,
                 strEvent: title,
                 strLeague: 'FÚTBOL',
                 strTime: time,
                 sport: 'FÚTBOL',
                 options: [{ name: 'Ver en Vivo', url: fullUrl, lang: 'Español' }]
               });
             }
          }
       }
    }

    return events;
  } catch (e) {
    return [];
  }
}

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Falta la URL');

  try {
    let parsedUrl = new URL(targetUrl);
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': HEADERS['User-Agent'],
        'Referer': 'https://tarjetarojadirect.live/',
        'Accept-Language': 'es-ES,es;q=0.9'
      }
    });

    let html = await response.text();

    const streamMatches = [
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*redirectus[^"'\s<>]*)/gi),
      ...html.matchAll(/(https?:\/\/[^"'\s<>]*latin\/[^"'\s<>]*)/gi),
      ...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)
    ].map(m => m[1]);

    const candidateUrls = streamMatches.filter(src => src && !src.includes('google') && !src.includes('facebook') && !src.includes('analytics'));
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
    return res.status(500).send('<body style="background:#000;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;">Error de emisión</body>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));