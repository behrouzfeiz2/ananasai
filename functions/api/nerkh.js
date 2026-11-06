export async function onRequestGet(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    const response = await fetch("https://nerkhara.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات از سایت مرجع.");
    }

    const html = await response.text();

    // تابع کمکی برای استخراج قیمت‌ها از متن HTML سایت نرخ‌آرا
    function extractPrice(keyword) {
      try {
        // جستجوی کلمه کلیدی در متن و پیدا کردن اعداد یا قیمت بعد از آن
        const index = html.indexOf(keyword);
        if (index === -1) return "نامشخص";
        
        const snippet = html.slice(index, index + 300);
        // پیدا کردن الگوهای عددی قیمت
        const match = snippet.match(/([0-9,]{4,})/);
        return match ? match[1] : "به‌روز";
      } catch (e) {
        return "نامشخص";
      }
    }

    // استخراج نرخ‌های اصلی به صورت پویا از HTML
    const dollarPrice = extractPrice("دلار آزاد") !== "نامشخص" ? extractPrice("دلار آزاد") : extractPrice("دلار");
    const euroPrice = extractPrice("یورو");
    const goldPrice = extractPrice("طلا");
    const oilPrice = extractPrice("نفت");

    const marketData = {
      source: "nerkhara.com",
      updated_at: new Date().toLocaleTimeString("fa-IR", { hour: '2-digit', minute: '2-digit' }),
      items: [
        { title: "دلار آزاد", price: dollarPrice, change: "تومان" },
        { title: "یورو", price: euroPrice, change: "تومان" },
        { title: "طلا (۱۸ عیار)", price: goldPrice, change: "تومان" },
        { title: "نفت برنت", price: oilPrice, change: "خام" }
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
