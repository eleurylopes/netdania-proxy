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

const FALLBACK = {
  USD: { buy: 5.12, sell: 5.14, spot: 5.13, variation: -0.17, high: 5.17, low: 5.12 },
  EUR: { buy: 5.58, sell: 5.60, spot: 5.59, variation: 0,     high: 5.62, low: 5.55 },
  AED: { buy: 1.39, sell: 1.40, spot: 1.40, variation: 0,     high: 1.41, low: 1.39 },
  GBP: { buy: 6.50, sell: 6.53, spot: 6.51, variation: 0,     high: 6.55, low: 6.48 },
};

let cache = { rates: null, updatedAt: null };
let lastPageText = '';
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
  const url = `https://m.netdania.com${path}`;
  const resp = await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
  const status = resp.status();
  console.log(`${key}: HTTP ${status} de ${url}`);

  // Aguarda até 5s por qualquer número com ponto
  try {
    await page.waitForFunction(
      () => /\d+\.\d+/.test(document.body.innerText),
      { timeout: 5000 }
    );
  } catch(e) {
    // continua mesmo sem encontrar
  }

  const { text, numbers } = await page.evaluate(() => {
    const t = document.body.innerText;
    const nums = t.match(/\d+\.\d+/g) || [];
    return { text: t.substring(0, 500), numbers: nums.slice(0, 10) };
  });

  // Salva para diagnóstico
  lastPageText = `[${key}] status=${status}\nTexto: ${text}\nNúmeros: ${numbers.join(', ')}`;
  console.log(lastPageText);

  // Bid/Ask: "5.12776/3456"
  const bidAskMatch = text.match(/(\d+\.\d+)\/(\d+)/);
  if (!bidAskMatch) {
    // Tenta pegar qualquer número razoável como spot
    const spot = numbers.find(n => {
      const v = parseFloat(n);
      return key === 'USD' ? v > 4 && v < 8 :
             key === 'EUR' ? v > 5 && v < 10 :
             key === 'AED' ? v > 1 && v < 3 :
             key === 'GBP' ? v > 5 && v < 10 : false;
    });
    if (spot) {
      const s = parseFloat(spot);
      console.log(`${key}: usando spot aproximado ${s}`);
      return { buy: parseFloat((s*0.999).toFixed(4)), sell: parseFloat((s*1.001).toFixed(4)),
               spot: s, variation: 0, high: parseFloat((s*1.005).toFixed(4)), low: parseFloat((s*0.995).toFixed(4)) };
    }
    throw new Error(`${key}: dados não encontrados. Números: ${numbers.join(', ')}`);
  }

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
  const spot = (bid + ask) / 2;

  return { buy: parseFloat(bid.toFixed(4)), sell: parseFloat(ask.toFixed(4)),
           spot: parseFloat(spot.toFixed(4)), variation, high, low };
}

async function refresh() {
  console.log(`[${new Date().toISOString()}] Iniciando fetch...`);
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const rates = {};
    for (const { key, path } of PAIRS) {
      rates[key] = await fetchPair(page, key, path);
      console.log(`  ✅ ${key}: ${rates[key].spot}`);
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

app.get('/rates', (req, res) => {
  if (!cache.rates) return res.json(FALLBACK);
  res.json({ ...cache.rates, updatedAt: cache.updatedAt });
});

app.get('/health', (req, res) => {
  res.json({
    status: cache.rates ? 'ok' : 'loading',
    updatedAt: cache.updatedAt,
    browserAlive: browser ? browser.isConnected() : false,
    rates: cache.rates || FALLBACK,
    lastPageText,
  });
});

app.listen(PORT, () => {
  console.log(`NetDania Proxy rodando na porta ${PORT}`);
  setTimeout(() => {
    refresh();
    setInterval(refresh, 60 * 1000);
  }, 5000);
});
