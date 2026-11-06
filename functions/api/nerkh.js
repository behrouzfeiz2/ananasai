export async function onRequestGet(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    // دریافت اطلاعات از سایت نرخرخ یا منابع مشابه
    const response = await fetch("https://nerkhara.com/", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnanasAI-Bot/1.0"
      }
    });

    if (!response.ok) {
      throw new Error("خطا در دریافت اطلاعات از منبع نرخ‌ارز.");
    }

    const html = await response.text();

    // استخراج نرخ‌ها با استفاده از تحلیل ساختار HTML (یا بازگرداندن داده‌های ساختاریافته)
    // در اینجا یک نمونه ساختار تستی یا استخراج هوشمند بر اساس المان‌های صفحه قرار می‌دهیم:
    
    // به عنوان مثال، فرض کنید نرخ‌ها را به صورت نمونه استخراج می‌کنیم:
    // (می‌توانید بر اساس کلاس‌ها یا تگ‌های خاص سایت nerkhara.com ریجکس بنویسید)
    
    let marketData = {
      source: "nerkhara.com",
      updated_at: new Date().toLocaleTimeString("fa-IR"),
      items: [
        { title: "دلار آزاد", price: "بررسی بر اساس ساختار سایت", change: "زنده" },
        { title: "نفت برنت", price: "به‌روزرسانی خودکار", change: "زنده" }
      ]
    };

    // اگر خواستید کل متن یا بخش‌های کلیدی را برای پردازش به فرانت‌اند بفرستید:
    return new Response(JSON.stringify({ success: true, data: marketData, raw_html_snippet: html.slice(0, 500) }), {
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
