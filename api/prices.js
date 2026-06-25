export default async function handler(req, res) {
  try {
    const symbols = 'BLK,RKLB,VAS.AX,VESG.AX,NZDUSD=X,AUDNZD=X';
    const r = await fetch(
      `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
      }
    );
    if (!r.ok) throw new Error(`Yahoo returned ${r.status}`);
    const data = await r.json();
    const quotes = data.quoteResponse?.result || [];
    const out = {};
    quotes.forEach(q => {
      out[q.symbol] = {
        price: q.regularMarketPrice,
        change: q.regularMarketChangePercent,
        currency: q.currency,
        marketState: q.marketState,
      };
    });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
