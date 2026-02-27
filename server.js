const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3099;

const AED_USD_PEG = 3.6725;

const PAIRS = [
  { key: 'USD', path: '/currencies/usdbrl/idc-lite' },
  { key: 'EUR', path: '/currencies/eurbrl/idc-lite' },
  { key: 'GBP', path: '/currencies/gbpbrl/idc-lite' },
];

const FALLBACK = {
  USD: { buy: 5.12, sell: 5.14, spot: 5.13, variation: -0.17, high: 5.17, low: 5.12 },
  EUR: { buy: 5.58, sell: 5.60, spot: 5.59, variation: 0, high: 5.62, low: 5.55 },
  AED: { buy: 1.394, sell: 1.399, spot: 1.396, variation: 0, high: 1.407, low: 1.391 },
  GBP: { buy: 6.50, sell: 6.53, spot: 6.51, variation: 0, high: 6.55, low: 6.48 },
};

let cache = { rates: null, updatedAt: null };
let logs = [];
let browser = null;

function log(msg) {
  console.log(msg);
  logs.push(`${new Date().toISOString().slice(11,19)} ${msg}`);
  if (logs.length > 50) logs.shift();
}

async function launchBrowser() {
  if (browser) { try { await browser.close(); } catch(e) {} browser = null; }
  log('Iniciando Chrome...');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run',
      // removido --single-process que causava crashes
    ],
  });
  log('Chrome pronto');
  return browser;
}

async function fetchPair(key, path) {
  // Nova página por par para evitar frame detached
  const b = browser && browser.isConnected() ? browser : await launchBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    const resp = await page.goto(`https://m.netdania.com${path}`, { waitUntil: 'networkidle2', timeout: 25000 });
    const status = resp.status();

    try { await page.waitForFunction(() => /\d+\.\d+/.test(document.body.innerText), { timeout: 5000 }); } catch(e) {}

    const { text, numbers } = await page.evaluate(() => {
      const t = document.body.innerText;
      return { text: t.substring(0, 600), numbers: (t.match(/\d+\.\d+/g) || []).slice(0, 10) };
    });

    log(`${key} HTTP=${status} nums=${numbers.length}`);

    const bidAskMatch = text.match(/(\d+\.\d+)\/(\d+)/);
    if (!bidAskMatch) throw new Error(`${key}: padrão bid/ask não encontrado`);

    const bidStr = bidAskMatch[1];
    const askSuffix = bidAskMatch[2];
    const bid = parseFloat(bidStr);
    const bidDec = bidStr.split('.')[1];
    const ask = parseFloat(bidStr.split('.')[0] + '.' + bidDec.slice(0, bidDec.length - askSuffix.length) + askSuffix);

    const rangeMatch = text.match(/(\d+\.\d+)\s*-\s*(\d+\.\d+)/);
    const low  = rangeMatch ? parseFloat(rangeMatch[1]) : bid;
    const high = rangeMatch ? parseFloat(rangeMatch[2]) : ask;
    const varMatch = text.match(/([-+]?\d+\.\d+)%/);
    const variation = varMatch ? parseFloat(varMatch[1]) : 0;
    const spot = parseFloat(((bid + ask) / 2).toFixed(5));

    return { buy: parseFloat(bid.toFixed(5)), sell: parseFloat(ask.toFixed(5)), spot, variation, high, low };
  } finally {
    await page.close().catch(() => {});
  }
}

async function refresh() {
  log(`[${new Date().toISOString()}] fetch...`);
  const rates = {};

  // Se browser morreu, reinicia
  if (!browser || !browser.isConnected()) {
    await launchBrowser();
  }

  for (const { key, path } of PAIRS) {
    try {
      rates[key] = await fetchPair(key, path);
      log(`✅ ${key}: ${rates[key].spot}`);
    } catch (err) {
      log(`❌ ${key}: ${err.message}`);
      // Se frame detached, reinicia browser para próximo par
      if (err.message.includes('detached') || err.message.includes('detach') || err.message.includes('Navigating')) {
        log('Reiniciando browser...');
        await launchBrowser();
      }
      rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
    }
  }

  // AED via peg fixo USD
  const usd = rates.USD;
  rates.AED = {
    buy: parseFloat((usd.buy / AED_USD_PEG).toFixed(5)),
    sell: parseFloat((usd.sell / AED_USD_PEG).toFixed(5)),
    spot: parseFloat((usd.spot / AED_USD_PEG).toFixed(5)),
    variation: usd.variation,
    high: parseFloat((usd.high / AED_USD_PEG).toFixed(5)),
    low: parseFloat((usd.low / AED_USD_PEG).toFixed(5)),
    source: 'peg',
  };
  log(`✅ AED: ${rates.AED.spot} (peg)`);

  cache = { rates, updatedAt: new Date().toISOString() };
  log('Fetch concluído');
}

app.get('/rates', (req, res) => res.json(cache.rates || FALLBACK));

app.get('/health', (req, res) => res.json({
  status: cache.rates ? 'ok' : 'loading',
  updatedAt: cache.updatedAt,
  browserAlive: !!(browser && browser.isConnected()),
  rates: cache.rates || FALLBACK,
  logs,
}));

app.listen(PORT, async () => {
  log(`Proxy na porta ${PORT}`);
  await launchBrowser();
  setTimeout(() => { refresh(); setInterval(refresh, 60 * 1000); }, 2000);
});
