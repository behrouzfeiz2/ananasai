const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=60, s-maxage=300"
};

const ASSETS = {
  dollar: { symbol: "price_dollar_rl", title: "دلار آزاد" },
  gold: { symbol: "geram24", title: "طلای ۲۴ عیار" },
  gold18: { symbol: "geram18", title: "طلای ۱۸ عیار" },
  gold24: { symbol: "geram24", title: "طلای ۲۴ عیار" },
  pound: { symbol: "price_gbp", title: "پوند انگلیس" },
  euro: { symbol: "price_eur", title: "یورو" },
  yuan: { symbol: "price_cny", title: "یوان چین" },
  dirham: { symbol: "price_aed", title: "درهم امارات" },
  lira: { symbol: "price_try", title: "لیر ترکیه" },
  ruble: { symbol: "price_rub", title: "روبل روسیه" },
  swissFranc: { symbol: "price_chf", title: "فرانک سوئیس" }
};

function cleanText(value) {
  return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}
function numeric(value) {
  const text = cleanText(value).replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, d => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[^0-9.-]/g, "");
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
function dateValue(value) {
  const text = cleanText(value);
  const match = text.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  return match ? match[1] + "-" + match[2].padStart(2,"0") + "-" + match[3].padStart(2,"0") : "";
}
async function fetchWithTimeout(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnanasAI/1.0)",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Origin": "https://www.tgju.org",
        "Referer": "https://www.tgju.org/"
      },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}
export async function onRequestGet({ request }) {
  const requestUrl = new URL(request.url);
  const assetKey = requestUrl.searchParams.get("asset") || "dollar";
  const asset = ASSETS[assetKey];
  if (!asset) {
    return new Response(JSON.stringify({ success: false, error: "دارایی درخواستی پشتیبانی نمی‌شود." }), { status: 400, headers: corsHeaders });
  }
  const { symbol, title } = asset;
  let history = [];
  let historyError = null;
  let currentPrice = null;
  let updatedAt = new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });

  // History and live quote are independent: a missing history table must not
  // prevent returning a valid current quote from the live market board.
  try {
    const url = new URL("https://api.tgju.org/v1/market/indicator/summary-table-data/" + symbol);
    const params = new URLSearchParams();
    params.set("lang", "fa");
    params.set("order_dir", "asc");
    params.set("draw", "2");
    params.set("start", "0");
    params.set("length", "5000");
    params.set("search", "");
    params.set("order_col", "");
    params.set("convert_to_ad", "1");
    for (let i=0; i<8; i++) {
      params.set("columns["+i+"][data]", String(i));
      params.set("columns["+i+"][name]", "");
      params.set("columns["+i+"][searchable]", "true");
      params.set("columns["+i+"][orderable]", "true");
      params.set("columns["+i+"][search][value]", "");
      params.set("columns["+i+"][search][regex]", "false");
    }
    url.search = params.toString();
    const response = await fetchWithTimeout(url.toString());
    if (!response.ok) throw new Error("TGJU history HTTP " + response.status);
    const payload = await response.json();
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const points = rows.map(row => {
      if (!Array.isArray(row)) return null;
      const date = dateValue(row[6]);
      const closeRial = numeric(row[3]);
      if (!date || closeRial === null || closeRial <= 0) return null;
      return { date, jalaliDate: cleanText(row[7]), price: Math.round(closeRial / 10) };
    }).filter(Boolean);
    const unique = new Map();
    for (const point of points) unique.set(point.date, point);
    history = Array.from(unique.values()).sort((a,b) => a.date.localeCompare(b.date)).slice(-370);
  } catch (error) {
    historyError = error.message || String(error);
    console.error("MARKET_HISTORY_SOURCE_ERROR", symbol, historyError);
  }

  try {
    const liveResponse = await fetchWithTimeout("https://call1.tgju.org/ajax.json", 9000);
    if (liveResponse.ok) {
      const live = await liveResponse.json();
      const raw = numeric(live?.current?.[symbol]?.p);
      if (raw && raw > 0) currentPrice = Math.round(raw / 10);
    }
  } catch (error) {
    console.error("MARKET_LIVE_QUOTE_ERROR", symbol, error.message);
  }

  if (!currentPrice && history.length) currentPrice = history[history.length-1].price;
  if (!currentPrice || currentPrice <= 0) {
    return new Response(JSON.stringify({ success: false, error: "دریافت قیمت زنده و تاریخچه این دارایی از منبع بازار ناموفق بود.", detail: historyError }), { status: 503, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
  }
  const historyAvailable = history.length > 1;
  const points = history.length ? history : [{ date: new Date().toISOString().slice(0,10), jalaliDate: updatedAt, price: currentPrice }];
  return new Response(JSON.stringify({ success: true, asset: assetKey, symbol, title, currency: "تومان", currentPrice, updatedAt, points, historyAvailable, historyError }), { status: 200, headers: corsHeaders });
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
