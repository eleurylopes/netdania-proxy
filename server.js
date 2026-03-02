const express = require('express');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3099;
const AED_USD_PEG = 3.6725;
const READ_INTERVAL = 30 * 1000; // read DOM every 30s (NO HTTP requests!)

const PAIRS = [
  { key: 'USD', url: 'https://m.netdania.com/currencies/usdbrl/idc-lite' },
  { key: 'EUR', url: 'https://m.netdania.com/currencies/eurbrl/idc-lite' },
  { key: 'GBP', url: 'https://m.netdania.com/currencies/gbpbrl/idc-lite' },
];

const FALLBACK = {
  USD: { buy: 5.1277, sell: 5.1346, spot: 5.1311, variation: -0.17, high: 5.1698, low: 5.1203 },
  EUR: { buy: 5.7800, sell: 5.7900, spot: 5.7850, variation: 0, high: 5.8100, low: 5.7500 },
  AED: { buy: 1.3960, sell: 1.3980, spot: 1.3970, variation: 0, high: 1.4080, low: 1.3940 },
  GBP: { buy: 6.5200, sell: 6.5400, spot: 6.5300, variation: 0, high: 6.5600, low: 6.5000 },
};

let cache = { rates: null, updatedAt: null, source: 'loading' };
let logs = [];
let browser = null;
let pages = {}; // { USD: page, EUR: page, GBP: page }
let browserReady = false;

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${level}] ${msg}`);
  logs.unshift({ ts, level, msg });
  if (logs.length > 50) logs.pop();
}

function findChromium() {
  for (const p of [process.env.PUPPETEER_EXECUTABLE_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

function parseBidAsk(str) {
  const m = str.match(/(\d+\.\d{2,6})\/([\d]+)/);
  if (!m) return null;
  const bidStr = m[1];
  const askSuffix = m[2];
  const bid = parseFloat(bidStr);
  const bidDec = bidStr.split('.')[1];
  const askDec = bidDec.slice(0, bidDec.length - askSuffix.length) + askSuffix;
  const ask = parseFloat(bidStr.split('.')[0] + '.' + askDec);
  return { bid, ask };
}

function parseFromText(key, text) {
  let bid = null, ask = null, variation = 0, high = null, low = null;

  const bidAskMatch = text.match(/(\d+\.\d{2,6})\/([\d]+)/);
  if (bidAskMatch) {
    const parsed = parseBidAsk(bidAskMatch[0]);
    if (parsed) { bid = parsed.bid; ask = parsed.ask; }
  }

  const varMatch = text.match(/([-+]?\d+\.?\d*)%/);
  if (varMatch) variation = parseFloat(varMatch[1]);

  const rangeMatch = text.match(/(\d+\.\d{2,6})\s*-\s*(\d+\.\d{2,6})/);
  if (rangeMatch) { low = parseFloat(rangeMatch[1]); high = parseFloat(rangeMatch[2]); }

  if (bid === null) return null;
  if (!low) low = bid;
  if (!high) high = ask;
  const spot = parseFloat(((bid + ask) / 2).toFixed(5));
  return { buy: bid, sell: ask, spot, variation, high, low };
}

// ─── OPEN A SINGLE TAB ─────────────────────────────────────
async function openTab(key, url) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  );
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (['image', 'font', 'media'].includes(t)) req.abort();
    else req.continue();
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));
  return page;
}

// ─── LAUNCH BROWSER + OPEN TABS (once!) ─────────────────────
async function initBrowser() {
  const execPath = findChromium();
  if (!execPath) { log('error', 'Chromium not found'); return; }

  if (browser) { try { await browser.close(); } catch (_) {} }
  pages = {};
  browserReady = false;

  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: execPath,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-default-apps', '--disable-sync', '--disable-translate',
      '--mute-audio', '--no-first-run', '--no-zygote',
      '--js-flags=--max-old-space-size=192',
    ],
  });
  log('info', 'Browser iniciado');

  // Open one permanent tab per currency pair
  for (const { key, url } of PAIRS) {
    try {
      log('info', `${key}: abrindo aba...`);
      pages[key] = await openTab(key, url);
      log('info', `${key}: aba aberta OK`);
    } catch (err) {
      log('error', `${key}: erro ao abrir: ${err.message}`);
    }
  }

  browserReady = true;
  log('info', `Browser pronto com ${Object.keys(pages).length} abas permanentes`);
  await readAllPages();
}

// ─── READ DOM — zero HTTP requests! ─────────────────────────
async function readAllPages() {
  if (!browserReady || !browser || !browser.isConnected()) {
    log('error', 'Browser desconectado, reiniciando...');
    await initBrowser();
    return;
  }

  const rates = {};
  let success = 0;

  for (const { key } of PAIRS) {
    const page = pages[key];
    if (!page) {
      rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
      continue;
    }

    try {
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      const parsed = parseFromText(key, text);

      if (parsed) {
        rates[key] = parsed;
        log('info', `OK ${key}: ${parsed.buy}/${parsed.sell} var=${parsed.variation}%`);
        success++;
      } else {
        log('error', `FAIL ${key}: parse failed`);
        rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
      }
    } catch (err) {
      log('error', `FAIL ${key}: ${err.message}`);
      rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];

      // Tab crashed — reopen it (single HTTP request)
      if (err.message.includes('detached') || err.message.includes('closed') || err.message.includes('crashed')) {
        log('info', `${key}: aba crashou, reabrindo...`);
        try {
          const pair = PAIRS.find(p => p.key === key);
          pages[key] = await openTab(key, pair.url);
          log('info', `${key}: aba reaberta`);
        } catch (reopenErr) {
          log('error', `${key}: falha ao reabrir: ${reopenErr.message}`);
        }
      }
    }
  }

  // AED via USD peg
  const usd = rates.USD;
  const fix5 = v => parseFloat(v.toFixed(5));
  rates.AED = {
    buy: fix5(usd.buy / AED_USD_PEG), sell: fix5(usd.sell / AED_USD_PEG),
    spot: fix5(usd.spot / AED_USD_PEG), variation: usd.variation,
    high: fix5(usd.high / AED_USD_PEG), low: fix5(usd.low / AED_USD_PEG),
  };

  cache = { rates, updatedAt: new Date().toISOString(), source: success > 0 ? 'netdania-live' : 'fallback' };
  log('info', `Read (${success}/${PAIRS.length}). Mem: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
}

// ─── CORS + ROUTES ──────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'netdania-proxy', version: '4.0.0' }));
app.get('/rates', (req, res) => res.json(cache.rates || FALLBACK));
app.get('/health', (req, res) => res.json({
  status: cache.rates ? 'ok' : 'loading', source: cache.source,
  updatedAt: cache.updatedAt, rates: cache.rates || FALLBACK,
  openTabs: Object.keys(pages), browserConnected: browser ? browser.isConnected() : false,
  logs: logs.slice(0, 30), uptime: process.uptime(), memory: process.memoryUsage(),
}));

// ─── START ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log('info', `Proxy v4.0 na porta ${PORT}`);
  setTimeout(async () => {
    try {
      await initBrowser();
      setInterval(async () => {
        try { await readAllPages(); }
        catch (err) { log('error', `Read error: ${err.message}`); }
      }, READ_INTERVAL);
    } catch (err) {
      log('error', `Init failed: ${err.message}`);
    }
  }, 1000);
});

process.on('SIGTERM', async () => {
  log('info', 'SIGTERM');
  if (browser) try { await browser.close(); } catch (_) {}
  process.exit(0);
});
