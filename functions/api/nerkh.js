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

    // تابع کمکی برای خواندن قیمت و تغییرات از ساختار JSON سایت TGJU
    function getItem(key) {
      if (data[key] && data[key].p) {
        return {
          price: data[key].p, // قیمت
          change: data[key].diff || "۰" // میزان تغییرات
        };
      }
      return { price: "نامشخص", change: "" };
    }

    // استخراج اقلام مهم بازار (کلیدهای استاندارد در ساختار TGJU)
    const dolar = getItem("price_dollar_rl"); // دلار آزاد
    const euro = getItem("price_eur");       // یورو
    const pound = getItem("price_gbp");      // پوند
    const gold18 = getItem("geram18");       // طلا ۱۸ عیار
    const SekheImami = getItem("sekee");     // سکه امامی
    const oil = getItem("oil_brent");        // نفت برنت

    const marketData = {
      source: "tgju.org",
      updated_at: new Date().toLocaleTimeString("fa-IR", { hour: '2-digit', minute: '2-digit' }),
      items: [
        { title: "دلار آزاد", price: dolar.price, change: `تومان (${dolar.change})` },
        { title: "یورو", price: euro.price, change: `تومان (${euro.change})` },
        { title: "پوند", price: pound.price, change: `تومان (${pound.change})` },
        { title: "طلا (۱۸ عیار)", price: gold18.price, change: `تومان (${gold18.change})` },
        { title: "سکه امامی", price: SekheImami.price, change: `تومان (${SekheImami.change})` },
        { title: "نفت برنت", price: oil.price, change: `دلار (${oil.change})` }
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
