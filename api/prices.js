export const config = { runtime: 'edge' };

const SYMBOLS = ['BLK', 'RKLB', 'VAS.AX', 'VESG.AX', 'NZDUSD=X', 'AUDNZD=X'];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function fetchQuote(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${symbol}: ${r.status}`);
  const data = await r.json();
  const meta = data.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`${symbol}: no data`);
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose;
  return {
    symbol,
    price,
    change: prev ? ((price - prev) / prev) * 100 : null,
    currency: meta.currency,
    marketState: meta.marketState ?? null,
  };
}

export default async function handler(req) {
  const results = await Promise.allSettled(SYMBOLS.map(fetchQuote));
  const out = {};
  results.forEach(r => { if (r.status === 'fulfilled') out[r.value.symbol] = r.value; });

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 's-maxage=60, stale-while-revalidate=300',
  };

  if (!Object.keys(out).length) {
    const errors = results.map(r => r.reason?.message).filter(Boolean).join('; ');
    return new Response(JSON.stringify({ error: errors || 'All fetches failed' }), { status: 500, headers });
  }

  return new Response(JSON.stringify(out), { status: 200, headers });
}
