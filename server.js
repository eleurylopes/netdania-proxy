const express = require('express');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3099;

const AED_USD_PEG = 3.6725;

const PAIRS = [
  { key: 'USD', path: '/currencies/usdbrl/idc-lite' },
  { key: 'EUR', path: '/currencies/eurbrl/idc-lite' },
  { key: 'GBP', path: '/currencies/gbpbrl/idc-lite' },
];

const FALLBACK = {
  USD: { buy: 5.1277, sell: 5.1346, spot: 5.1311, variation: -0.17, high: 5.1698, low: 5.1203 },
  EUR: { buy: 5.7800, sell: 5.7900, spot: 5.7850, variation: 0, high: 5.8100, low: 5.7500 },
  AED: { buy: 1.3960, sell: 1.3980, spot: 1.3970, variation: 0, high: 1.4080, low: 1.3940 },
  GBP: { buy: 6.5200, sell: 6.5400, spot: 6.5300, variation: 0, high: 6.5600, low: 6.5000 },
};

let cache = { rates: null, updatedAt: null };
let logs = [];

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`${ts} ${msg}`);
  logs.push(`${ts} ${msg}`);
  if (logs.length > 50) logs.shift();
}

// ─── FETCH HTML via https (sem Puppeteer) ───────────────────
function fetchPage(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'm.netdania.com',
      path,
      method: 'GET',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    };
    const req = https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ─── PARSE HTML ─────────────────────────────────────────────
function parsePair(key, html) {
  // Bid/Ask: "5.12776/3456" ou "6.92/93" → formatos variados de precisão
  const bidAskMatch = html.match(/(\d+\.\d{2,6})\/([\d]+)/);
  if (!bidAskMatch) throw new Error(`${key}: padrão bid/ask não encontrado`);

  const bidStr = bidAskMatch[1];
  const askSuffix = bidAskMatch[2];
  const bid = parseFloat(bidStr);

  // Reconstruir ask: pegar os primeiros dígitos decimais do bid + suffix
  const bidDec = bidStr.split('.')[1];
  const askDec = bidDec.slice(0, bidDec.length - askSuffix.length) + askSuffix;
  const ask = parseFloat(bidStr.split('.')[0] + '.' + askDec);

  // Range: "5.12030 - 5.16980" ou "6.89 - 6.96"
  const rangeMatch = html.match(/(\d+\.\d{2,6})\s*-\s*(\d+\.\d{2,6})/);
  const low = rangeMatch ? parseFloat(rangeMatch[1]) : bid;
  const high = rangeMatch ? parseFloat(rangeMatch[2]) : ask;

  // Variation: "-0.17%" ou "-0.08%"
  const varMatch = html.match(/([-+]?\d+\.\d+)%/);
  const variation = varMatch ? parseFloat(varMatch[1]) : 0;

  const spot = parseFloat(((bid + ask) / 2).toFixed(5));

  return { buy: bid, sell: ask, spot, variation, high, low };
}

// ─── REFRESH ────────────────────────────────────────────────
async function refresh() {
  log('fetch...');
  const rates = {};

  for (const { key, path } of PAIRS) {
    try {
      const html = await fetchPage(path);
      rates[key] = parsePair(key, html);
      log(`✅ ${key}: ${rates[key].buy}/${rates[key].sell} spot=${rates[key].spot}`);
    } catch (err) {
      log(`❌ ${key}: ${err.message}`);
      rates[key] = (cache.rates && cache.rates[key]) || FALLBACK[key];
    }
  }

  // AED via peg fixo USD/AED = 3.6725
  const usd = rates.USD;
  rates.AED = {
    buy:  parseFloat((usd.buy  / AED_USD_PEG).toFixed(5)),
    sell: parseFloat((usd.sell / AED_USD_PEG).toFixed(5)),
    spot: parseFloat((usd.spot / AED_USD_PEG).toFixed(5)),
    variation: usd.variation,
    high: parseFloat((usd.high / AED_USD_PEG).toFixed(5)),
    low:  parseFloat((usd.low  / AED_USD_PEG).toFixed(5)),
    source: 'peg',
  };
  log(`✅ AED: ${rates.AED.spot} (peg USD/AED)`);

  cache = { rates, updatedAt: new Date().toISOString() };
  log('Fetch concluído');
}

// ─── ROUTES ─────────────────────────────────────────────────
app.get('/rates', (req, res) => res.json(cache.rates || FALLBACK));

app.get('/health', (req, res) => res.json({
  status: cache.rates ? 'ok' : 'loading',
  updatedAt: cache.updatedAt,
  rates: cache.rates || FALLBACK,
  logs,
}));

// ─── START ──────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`Proxy na porta ${PORT}`);
  setTimeout(() => { refresh(); setInterval(refresh, 60 * 1000); }, 2000);
});
