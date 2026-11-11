
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

export async function onRequestGet(context) {
  try {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      10000
    );

    let response;

    try {
      response = await fetch(
        "https://call1.tgju.org/ajax.json",
        {
          headers: {
            "User-Agent": "Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.tgju.org/",
            "Accept": "application/json"
          },
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`TGJU HTTP ${response.status}`);
    }

    const json = await response.json();
    const data = json.current || {};

    function getPrice(key) {
      const value = data[key]?.p;

      if (value === undefined || value === null || value === "") {
        return "نامشخص";
      }

      return String(value);
    }

    const items = [
      { title: "دلار آزاد", price: getPrice("price_dollar_rl"), unit: "ریال" },
      { title: "یورو", price: getPrice("price_eur"), unit: "ریال" },
      { title: "پوند", price: getPrice("price_gbp"), unit: "ریال" },
      { title: "طلای ۱۸ عیار", price: getPrice("geram18"), unit: "ریال" },
      { title: "طلای ۲۴ عیار", price: getPrice("geram24"), unit: "ریال" },
      { title: "یوان چین", price: getPrice("price_cny"), unit: "ریال" },
      { title: "درهم امارات", price: getPrice("price_aed"), unit: "ریال" },
      { title: "لیر ترکیه", price: getPrice("price_try"), unit: "ریال" },
      { title: "روبل روسیه", price: getPrice("price_rub"), unit: "ریال" },
      { title: "فرانک سوئیس", price: getPrice("price_chf"), unit: "ریال" },
      { title: "سکه امامی", price: getPrice("sekee"), unit: "ریال" },
      { title: "نفت برنت", price: getPrice("oil_brent"), unit: "دلار" }
    ];

    const validItems = items.filter(
      item => item.price !== "نامشخص"
    );

    if (!validItems.length) {
      throw new Error("ساختار قیمت‌های TGJU تغییر کرده است.");
    }

    const marketData = {
      source: "tgju.org",
      updated_at: new Date().toLocaleString("fa-IR", {
        timeZone: "Asia/Tehran",
        hour: "2-digit",
        minute: "2-digit",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }),
      items
    };

    return new Response(
      JSON.stringify({
        success: true,
        data: marketData
      }),
      {
        status: 200,
        headers: corsHeaders
      }
    );

  } catch (error) {
    console.error("NERKH_ERROR", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: "دریافت اطلاعات بازار موقتاً امکان‌پذیر نیست."
      }),
      {
        status: 503,
        headers: corsHeaders
      }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}
