const express = require('express');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3099;
const AED_USD_PEG = 3.6725;
const REFRESH_INTERVAL = 90 * 1000; // 90s

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
let refreshing = false;

function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${level}] ${msg}`);
  logs.unshift({ ts, level, msg });
  if (logs.length > 40) logs.pop();
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

// ─── REFRESH: open browser, scrape all 3, close browser ─────
async function refresh() {
  if (refreshing) { log('info', 'Skip (already refreshing)'); return; }
  refreshing = true;

  const execPath = findChromium();
  if (!execPath) { log('error', 'Chromium not found'); refreshing = false; return; }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: execPath,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-gpu', '--single-process', '--no-zygote',
        '--js-flags=--max-old-space-size=128',
        '--disable-extensions', '--disable-background-networking',
        '--disable-default-apps', '--disable-sync', '--disable-translate',
        '--mute-audio', '--no-first-run',
      ],
    });
    log('info', 'Browser aberto');

    const rates = {};
    let success = 0;
    const page = await browser.newPage();

    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(t)) req.abort();
      else req.continue();
    });

    for (const { key, url } of PAIRS) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 3000));

        const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
        const parsed = parseFromText(key, text);

        if (parsed) {
          rates[key] = parsed;
          log('info', `OK ${key}: ${parsed.buy}/${parsed.sell} var=${parsed.variation}%`);
          success++;
        } else {
          log('error', `FAIL ${key}: parse failed. Text: ${text.substring(0, 150)}`);
          rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
        }
      } catch (err) {
        log('error', `FAIL ${key}: ${err.message}`);
        rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
      }
    }

    await page.close();

    // AED via peg
    const usd = rates.USD;
    const fix5 = v => parseFloat(v.toFixed(5));
    rates.AED = {
      buy: fix5(usd.buy / AED_USD_PEG), sell: fix5(usd.sell / AED_USD_PEG),
      spot: fix5(usd.spot / AED_USD_PEG), variation: usd.variation,
      high: fix5(usd.high / AED_USD_PEG), low: fix5(usd.low / AED_USD_PEG),
    };
    log('info', `OK AED: ${rates.AED.spot} (peg)`);

    cache = { rates, updatedAt: new Date().toISOString(), source: success > 0 ? 'netdania-live' : 'fallback' };
    log('info', `Refresh OK (${success}/${PAIRS.length}). Mem: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
  } catch (err) {
    log('error', `Refresh error: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
      log('info', 'Browser fechado');
    }
    refreshing = false;
  }
}

// ─── CORS + ROUTES ──────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/', (req, res) => res.json({ status: 'ok', service: 'netdania-proxy', version: '3.1.0' }));
app.get('/rates', (req, res) => res.json(cache.rates || FALLBACK));
app.get('/health', (req, res) => res.json({
  status: cache.rates ? 'ok' : 'loading', source: cache.source,
  updatedAt: cache.updatedAt, rates: cache.rates || FALLBACK,
  logs: logs.slice(0, 30), uptime: process.uptime(), memory: process.memoryUsage(),
}));

// ─── START ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log('info', `Proxy v3.1 na porta ${PORT}`);
  setTimeout(() => refresh().then(() => setInterval(refresh, REFRESH_INTERVAL)), 1000);
});

process.on('SIGTERM', () => { log('info', 'SIGTERM'); process.exit(0); });
