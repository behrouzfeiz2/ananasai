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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnanasAI-Bot/1.0"
      }
    });

    if (!response.ok) {
      throw new Error("خطا در ارتباط با منبع نرخ‌ارز.");
    }

    const html = await response.text();

    // ساختار نمونه داده‌های بازار برای نمایش به کاربر
    const marketData = {
      source: "nerkhara.com",
      updated_at: new Date().toLocaleTimeString("fa-IR", { hour: '2-digit', minute: '2-digit' }),
      items: [
        { title: "دلار آزاد", price: "در حال استعلام زنده", change: "بازار آزاد" },
        { title: "یورو", price: "به‌روزرسانی خودکار", change: "ارز اروپا" },
        { title: "پوند", price: "به‌روزرسانی خودکار", change: "ارز انگلستان" },
        { title: "طلا (۱۸ عیار)", price: "به‌روزرسانی خودکار", change: "گرمی" },
        { title: "نفت برنت", price: "به‌روزرسانی خودکار", change: "خام" }
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
