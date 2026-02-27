const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3099;

const PAIRS = [
  { key: 'USD', path: '/currencies/usdbrl/idc-lite' },
  { key: 'EUR', path: '/currencies/eurbrl/idc-lite' },
  { key: 'AED', path: '/currencies/aedbrl/idc-lite' },
  { key: 'GBP', path: '/currencies/gbpbrl/idc-lite' },
];

let cache = { rates: null, updatedAt: null };
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  console.log('Iniciando Chrome headless...');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--single-process',
    ],
  });
  console.log('Chrome iniciado');
  return browser;
}

async function fetchPair(page, key, path) {
  await page.goto(`https://m.netdania.com${path}`, {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });

  await page.waitForSelector('h1', { timeout: 10000 });

  const data = await page.evaluate(() => {
    const body = document.body.innerText;

    const bidAskMatch = body.match(/(\d+\.\d+)\/(\d+)/);
    if (!bidAskMatch) return null;

    const bidStr = bidAskMatch[1];
    const askSuffix = bidAskMatch[2];
    const bid = parseFloat(bidStr);
    const bidDecimals = bidStr.split('.')[1];
    const askDecimals = bidDecimals.slice(0, bidDecimals.length - askSuffix.length) + askSuffix;
    const ask = parseFloat(bidStr.split('.')[0] + '.' + askDecimals);

    const rangeMatch = body.match(/(\d+\.\d+)\s*-\s*(\d+\.\d+)/);
    const low  = rangeMatch ? parseFloat(rangeMatch[1]) : bid;
    const high = rangeMatch ? parseFloat(rangeMatch[2]) : ask;

    const varMatch = body.match(/([-+]?\d+\.\d+)%/);
    const variation = varMatch ? parseFloat(varMatch[1]) : 0;

    return { bid, ask, high, low, variation };
  });

  if (!data) throw new Error(`${key}: dados não encontrados`);

  const spot = (data.bid + data.ask) / 2;
  return {
    buy:  parseFloat(data.bid.toFixed(4)),
    sell: parseFloat(data.ask.toFixed(4)),
    spot: parseFloat(spot.toFixed(4)),
    variation: data.variation,
    high: data.high,
    low:  data.low,
  };
}

async function refresh() {
  console.log(`[${new Date().toISOString()}] Iniciando fetch...`);
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');

    const rates = {};
    for (const { key, path } of PAIRS) {
      rates[key] = await fetchPair(page, key, path);
      console.log(`  ${key}: ${rates[key].spot}`);
    }

    cache = { rates, updatedAt: new Date().toISOString() };
    console.log('Fetch concluído com sucesso');
  } catch (err) {
    console.error('Erro no fetch:', err.message);
    if (browser) {
      try { await browser.close(); } catch(e) {}
      browser = null;
    }
  } finally {
    if (page) try { await page.close(); } catch(e) {}
  }
}

// Endpoints
app.get('/rates', (req, res) => {
  if (!cache.rates) return res.status(503).json({ error: 'Cotações ainda não disponíveis' });
  res.json({ ...cache.rates, updatedAt: cache.updatedAt });
});

app.get('/health', (req, res) => {
  res.json({
    status: cache.rates ? 'ok' : 'loading',
    updatedAt: cache.updatedAt,
    browserAlive: browser ? browser.isConnected() : false,
    rates: cache.rates,
  });
});

app.listen(PORT, () => {
  console.log(`NetDania Proxy rodando na porta ${PORT}`);
  // Primeiro fetch após 5s, depois a cada 1 minuto
  setTimeout(() => {
    refresh();
    setInterval(refresh, 60 * 1000);
  }, 5000);
});
