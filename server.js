const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3099;

const AED_USD_PEG = 3.6725;

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

function log(level, msg) {
  const ts = new Date().toISOString();
  const entry = { ts, level, msg };
  console.log(`[${level}] ${msg}`);
  logs.unshift(entry);
  if (logs.length > 50) logs.pop();
}

// ─── LAUNCH BROWSER ─────────────────────────────────────────
async function launchBrowser() {
  if (browser) {
    try { await browser.close(); } catch (_) {}
  }
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--single-process',
      '--no-zygote',
    ],
  });
  log('info', 'Browser Puppeteer iniciado');
}

// ─── PARSE BID/ASK ──────────────────────────────────────────
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

// ─── EXTRACT DATA FROM PAGE ─────────────────────────────────
async function extractPair(key, url) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );

    // Block images/fonts/media for speed
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for streaming data to populate
    await page.waitForFunction(() => {
      // Check if recid spans have data
      const spans = document.querySelectorAll('span[id^="recid-"]');
      if (spans.length > 0) {
        for (const s of spans) {
          if (s.textContent && s.textContent.match(/\d+\.\d+/)) return true;
        }
      }
      // Fallback: check body text
      return document.body.innerText.match(/\d+\.\d{3,}\//);
    }, { timeout: 20000 });

    // Extract all data from the page
    const data = await page.evaluate(() => {
      const result = { spans: {}, bodyText: '' };
      document.querySelectorAll('span[id^="recid-"]').forEach(s => {
        result.spans[s.id] = s.textContent.trim();
      });
      result.bodyText = document.body.innerText.substring(0, 2000);
      return result;
    });

    log('info', `${key} spans: ${JSON.stringify(data.spans)}`);

    let bid = null, ask = null, variation = 0, high = null, low = null;

    // Parse from recid spans first
    for (const [id, val] of Object.entries(data.spans)) {
      if (id.match(/recid-\d+-f6/) && val.match(/\d+\.\d+\/\d+/)) {
        const parsed = parseBidAsk(val);
        if (parsed) { bid = parsed.bid; ask = parsed.ask; }
      }
      if (id.match(/recid-\d+-f15/) && val.match(/[-+]?\d+\.?\d*%/)) {
        const m = val.match(/([-+]?\d+\.?\d*)%/);
        if (m) variation = parseFloat(m[1]);
      }
      if (id.match(/recid-\d+-f2/) && val.match(/\d+\.\d+\s*-\s*\d+\.\d+/)) {
        const m = val.match(/(\d+\.\d+)\s*-\s*(\d+\.\d+)/);
        if (m) { low = parseFloat(m[1]); high = parseFloat(m[2]); }
      }
    }

    // Fallback: parse from body text
    if (bid === null) {
      const bodyText = data.bodyText;
      const bidAskMatch = bodyText.match(/(\d+\.\d{2,6})\/([\d]+)/);
      if (bidAskMatch) {
        const parsed = parseBidAsk(bidAskMatch[0]);
        if (parsed) { bid = parsed.bid; ask = parsed.ask; }
      }
      const varMatch = bodyText.match(/([-+]?\d+\.?\d*)%/);
      if (varMatch) variation = parseFloat(varMatch[1]);
      const rangeMatch = bodyText.match(/(\d+\.\d{2,6})\s*-\s*(\d+\.\d{2,6})/);
      if (rangeMatch) { low = parseFloat(rangeMatch[1]); high = parseFloat(rangeMatch[2]); }
    }

    if (bid === null) throw new Error(`${key}: nenhum dado encontrado`);

    if (!low) low = bid;
    if (!high) high = ask;
    const spot = parseFloat(((bid + ask) / 2).toFixed(5));

    return { buy: bid, sell: ask, spot, variation, high, low };
  } finally {
    await page.close();
  }
}

// ─── REFRESH ────────────────────────────────────────────────
async function refresh() {
  log('info', 'Iniciando refresh...');
  const rates = {};
  let success = 0;

  for (const { key, url } of PAIRS) {
    try {
      rates[key] = await extractPair(key, url);
      log('info', `OK ${key}: ${rates[key].buy}/${rates[key].sell}`);
      success++;
    } catch (err) {
      log('error', `FAIL ${key}: ${err.message}`);
      rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
    }
  }

  // AED via peg
  const usd = rates.USD;
  rates.AED = {
    buy:  parseFloat((usd.buy  / AED_USD_PEG).toFixed(5)),
    sell: parseFloat((usd.sell / AED_USD_PEG).toFixed(5)),
    spot: parseFloat((usd.spot / AED_USD_PEG).toFixed(5)),
    variation: usd.variation,
    high: parseFloat((usd.high / AED_USD_PEG).toFixed(5)),
    low:  parseFloat((usd.low  / AED_USD_PEG).toFixed(5)),
  };
  log('info', `OK AED: ${rates.AED.spot} (peg)`);

  cache = {
    rates,
    updatedAt: new Date().toISOString(),
    source: success > 0 ? 'netdania-live' : 'fallback',
  };
  log('info', `Refresh concluído (${success}/${PAIRS.length} OK)`);
}

// ─── SAFE REFRESH (restart browser on crash) ────────────────
async function safeRefresh() {
  try {
    if (!browser || !browser.isConnected()) {
      await launchBrowser();
    }
    await refresh();
  } catch (err) {
    log('error', `Refresh falhou: ${err.message}`);
    try {
      await launchBrowser();
      await refresh();
    } catch (err2) {
      log('error', `Retry falhou: ${err2.message}`);
    }
  }
}

// ─── ROUTES ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'netdania-proxy', version: '3.0.0' }));

app.get('/rates', (req, res) => {
  res.json(cache.rates || FALLBACK);
});

app.get('/health', (req, res) => {
  res.json({
    status: cache.rates ? 'ok' : 'loading',
    source: cache.source,
    updatedAt: cache.updatedAt,
    rates: cache.rates || FALLBACK,
    logs: logs.slice(0, 30),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

// ─── START ──────────────────────────────────────────────────
const REFRESH_INTERVAL = 60 * 1000; // 60s

app.listen(PORT, '0.0.0.0', async () => {
  log('info', `Proxy na porta ${PORT}`);
  await launchBrowser();
  await safeRefresh();
  setInterval(safeRefresh, REFRESH_INTERVAL);
});

// Cleanup
process.on('SIGTERM', async () => {
  log('info', 'SIGTERM recebido, fechando browser...');
  if (browser) await browser.close();
  process.exit(0);
});
