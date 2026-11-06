export async function onRequestGet(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    const response = await fetch("https://call1.tgju.org/ajax.json", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.tgju.org/"
      }
    });

    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات از سرور TGJU.");
    }

    const json = await response.json();
    const data = json.current || {};

    function getItem(key) {
      if (data[key] && data[key].p) {
        return data[key].p;
      }
      return "نامشخص";
    }

    // استخراج و تمیزسازی قیمت‌ها (نمایش بر حسب ریال یا تومان بر اساس نیاز)
    const marketData = {
      source: "tgju.org",
      updated_at: new Date().toLocaleTimeString("fa-IR", { hour: '2-digit', minute: '2-digit' }),
      items: [
        { title: "دلار", price: getItem("price_dollar_rl"), unit: "ریال" },
        { title: "یورو", price: getItem("price_eur"), unit: "ریال" },
        { title: "پوند", price: getItem("price_gbp"), unit: "ریال" },
        { title: "طلا (۱۸ عیار)", price: getItem("geram18"), unit: "ریال" },
        { title: "سکه امامی", price: getItem("sekee"), unit: "ریال" },
        { title: "نفت برنت", price: getItem("oil_brent"), unit: "دلار" }
      ]
    };

    return new Response(JSON.stringify({ success: true, data: marketData }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
