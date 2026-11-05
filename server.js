const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const PUPPETEER_FLAGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process'
];

// 1. Agenda Completa (Fútbol, Básquet, Motor/F1) en hora española
app.get('/api/agenda', async (req, res) => {
  let browser = null;
  try {
    browser = await puppeteer.launch({ headless: true, args: PUPPETEER_FLAGS });
    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
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
        
        if (href && (text.toLowerCase().includes('vs') || text.toLowerCase().includes('-') || text.toLowerCase().includes('grand prix') || text.toLowerCase().includes('f1'))) {
          let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          
          let timeMatch = lines.find(l => /^\d{2}:\d{2}$/.test(l));
          let time = timeMatch || 'En Vivo';
          
          let eventName = lines.find(l => l.toLowerCase().includes('vs') || l.toLowerCase().includes('f1') || l.toLowerCase().includes('gp')) || lines[0] || 'Evento Deportivo';
          let league = lines.find(l => !l.includes('vs') && !/^\d{2}:\d{2}$/.test(l)) || 'General';

          // Detectar deporte
          let sport = 'FUTBOL';
          const fullStr = (eventName + ' ' + league).toLowerCase();
          if (fullStr.includes('f1') || fullStr.includes('formula') || fullStr.includes('moto') || fullStr.includes('nascar') || fullStr.includes('rally')) {
            sport = 'MOTOR';
          } else if (fullStr.includes('basket') || fullStr.includes('nba') || fullStr.includes('acb') || fullStr.includes('euroleague')) {
            sport = 'BASKET';
          }

          let existing = results.find(r => r.strEvent.toLowerCase() === eventName.toLowerCase());
          if (existing) {
            if (!existing.options.some(o => o.url === href)) {
              existing.options.push({ name: `Canal ${existing.options.length + 1}`, url: href });
            }
          } else {
            results.push({
              idEvent: 'ev_' + index,
              strEvent: eventName.replace(/\n/g, ' '),
              strLeague: league,
              strTime: time,
              sport: sport,
              options: [{ name: 'Canal 1', url: href }]
            });
          }
        }
      });
      return results;
    });

    await browser.close();

    // Ordenar por la hora más próxima al reloj actual de España (CET)
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    events.sort((a, b) => {
      if (a.strTime === 'En Vivo') return -1;
      if (b.strTime === 'En Vivo') return 1;
      
      const parseMin = (tStr) => {
        const parts = tStr.split(':');
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
      };

      let minA = parseMin(a.strTime);
      let minB = parseMin(b.strTime);

      let diffA