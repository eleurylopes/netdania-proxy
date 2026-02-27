const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3099;

// AED/USD é um peg fixo oficial desde 1997: 1 USD = 3.6725 AED
const AED_USD_PEG = 3.6725;

const PAIRS = [
  { key: 'USD', path: '/currencies/usdbrl/idc-lite' },
  { key: 'EUR', path: '/currencies/eurbrl/idc-lite' },
  { key: 'GBP', path: '/currencies/gbpbrl/idc-lite' },
];

const FALLBACK = {
  USD: { buy: 5.12, sell: 5.14, spot: 5.13, variation: -0.17, high: 5.17, low: 5.12 },
  EUR: { buy: 5.58, sell: 5.60, spot: 5.59, variation: 0,     high: 5.62, low: 5.55 },
  AED: { buy: 1.394, sell: 1.399, spot: 1.396, variation: 0,  high: 1.407, low: 1.391 },
  GBP: { buy: 6.50, sell: 6.53, spot: 6.51, variation: 0,     high: 6.55, low: 6.48 },
};

let cache = { rates: null, updatedAt: null };
let lastLogs = [];
let browser = null;

function log(msg) {
  console.log(msg);
  lastLogs.push(`${new Date().toISOString().slice(11,19)} ${msg}`);
  if (lastLogs.length > 30) lastLogs.shift();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  log('Iniciando Chrome headless...');
  browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-first-run', '--single-process',
    ],
  });
  log('Chrome iniciado');
  return browser;
}

async function fetchPair(page, key, path) {
  const url = `https://m.netdania.com${path}`;
  const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
  const status = resp.status();

  try {
    await page.waitForFunction(() => /\d+\.\d+/.test(document.body.innerText), { timeout: 5000 });
  } catch(e) {}

  const { text, numbers } = await page.evaluate(() => {
    const t = document.body.innerText;
    const nums = t.match(/\d+\.\d+/g) || [];
    return { text: t.substring(0, 600), numbers: nums.slice(0, 10) };
  });

  log(`${key} HTTP=${status} nums=[${numbers.join(',')}]`);

  if (numbers.length === 0) {
    const html = await page.evaluate(() => document.body.innerHTML.substring(0, 400));
    log(`${key} HTML: ${html}`);
    throw new Error(`${key}: sem números na página`);
  }

  const bidAskMatch = text.match(/(\d+\.\d+)\/(\d+)/);
  if (!bidAskMatch) throw new Error(`${key}: padrão bid/ask não encontrado`);

  const bidStr = bidAskMatch[1];
  const askSuffix = bidAskMatch[2];
  const bid = parseFloat(bidStr);
  const bidDecimals = bidStr.split('.')[1];
  const askDecimals = bidDecimals.slice(0, bidDecimals.length - askSuffix.length) + askSuffix;
  const ask = parseFloat(bidStr.split('.')[0] + '.' + askDecimals);

  const rangeMatch = text.match(/(\d+\.\d+)\s*-\s*(\d+\.\d+)/);
  const low  = rangeMatch ? parseFloat(rangeMatch[1]) : bid;
  const high = rangeMatch ? parseFloat(rangeMatch[2]) : ask;
  const varMatch = text.match(/([-+]?\d+\.\d+)%/);
  const variation = varMatch ? parseFloat(varMatch[1]) : 0;
  const spot = parseFloat(((bid + ask) / 2).toFixed(5));

  return { buy: parseFloat(bid.toFixed(5)), sell: parseFloat(ask.toFixed(5)), spot, variation, high, low };
}

function calcAED(usd) {
  // 1 AED = USD/peg
  const spot  = parseFloat((usd.spot  / AED_USD_PEG).toFixed(5));
  const buy   = parseFloat((usd.buy   / AED_USD_PEG).toFixed(5));
  const sell  = parseFloat((usd.sell  / AED_USD_PEG).toFixed(5));
  const high  = parseFloat((usd.high  / AED_USD_PEG).toFixed(5));
  const low   = parseFloat((usd.low   / AED_USD_PEG).toFixed(5));
  return { buy, sell, spot, variation: usd.variation, high, low, source: 'USD*peg' };
}

async function refresh() {
  log(`[${new Date().toISOString()}] Iniciando fetch...`);
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const rates = {};
    for (const { key, path } of PAIRS) {
      try {
        rates[key] = await fetchPair(page, key, path);
        log(`✅ ${key}: ${rates[key].spot}`);
      } catch (err) {
        log(`❌ ${err.message}`);
        rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
      }
    }

    // AED calculado via peg USD/AED (fixo desde 1997)
    rates.AED = calcAED(rates.USD);
    log(`✅ AED: ${rates.AED.spot} (via peg USD)`);

    cache = { rates, updatedAt: new Date().toISOString() };
    log('Fetch concluído');
  } catch (err) {
    log(`Erro geral: ${err.message}`);
    if (browser) { try { await browser.close(); } catch(e) {} browser = null; }
  } finally {
    if (page) try { await page.close(); } catch(e) {}
  }
}

app.get('/rates', (req, res) => {
  res.json(cache.rates || FALLBACK);
});

app.get('/health', (req, res) => {
  res.json({
    status: cache.rates ? 'ok' : 'loading',
    updatedAt: cache.updatedAt,
    browserAlive: browser ? browser.isConnected() : false,
    rates: cache.rates || FALLBACK,
    aedNote: `Calculado via peg fixo: 1 USD = ${AED_USD_PEG} AED (desde 1997)`,
    logs: lastLogs,
  });
});

app.listen(PORT, () => {
  log(`NetDania Proxy na porta ${PORT}`);
  setTimeout(() => { refresh(); setInterval(refresh, 60 * 1000); }, 5000);
});
