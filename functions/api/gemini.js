export async function onRequestPost(context) {
  const { request, env } = context;
  
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-User-Token",
    "Content-Type": "application/json; charset=utf-8"
  };

  try {
    const body = await request.json();
    const { model, payload, isImageRequest } = body;
    
    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const userToken = request.headers.get("X-User-Token");

    let apiKey = env.GEMINI_API_KEY;
    let isPro = false;
    let limitText = 20;
    let limitImage = 4;

    // ۱. بررسی اعتبار کد فعال‌سازی وارد شده توسط کاربر
    if (userToken && userToken.trim() !== "") {
      const cleanToken = userToken.trim();
      
      // بررسی وجود کد در کلودفلر KV
      const tokenData = await env.ANANAS_KV.get(`token_${cleanToken}`);
      
      if (tokenData) {
        isPro = true;
        limitText = 100;
        limitImage = 10;
      } else {
        return new Response(
          JSON.stringify({ 
            error: { 
              message: "کد فعال‌سازی نامعتبر است. برای خرید کد پرو به تلگرام @Branex_ir مراجعه کنید." 
            } 
          }),
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // ۲. سیستم محدودیت روزانه بر اساس IP یا کد پرو
    const today = new Date().toISOString().split('T')[0];
    const storageKey = `usage_${isPro ? 'pro_' : 'free_'}${userToken || clientIP}_${today}`;
    
    let usage = JSON.parse(await env.ANANAS_KV.get(storageKey) || '{"text": 0, "image": 0}');

    if (isImageRequest) {
      if (usage.image >= limitImage) {
        const errMsg = isPro 
          ? "سهمیه ساخت تصویر پرو امروز شما (۱۰ تصویر) به پایان رسیده است. فردا مجدداً تلاش کنید." 
          : "سهمیه رایگان ساخت تصویر امروز شما (۴ تصویر) تمام شد. برای دسترسی به ۱۰ تصویر روزانه، کد اشتراک پرو را از تلگرام @Branex_ir تهیه کنید.";
          
        return new Response(JSON.stringify({ error: { message: errMsg } }), { status: 429, headers: corsHeaders });
      }
      usage.image += 1;
    } else {
      if (usage.text >= limitText) {
        const errMsg = isPro 
          ? "سهمیه پیام‌های پرو امروز شما (۱۰۰ درخواست) به پایان رسیده است. فردا مجدداً تلاش کنید." 
          : "سهمیه رایگان پیام‌های امروز شما (۲۰ درخواست) تمام شد. برای ارتقا به حساب پرو (۱۰۰ درخواست و ۱۰ تصویر روزانه)، کد فعال‌سازی را از تلگرام @Branex_ir تهیه کنید.";
          
        return new Response(JSON.stringify({ error: { message: errMsg } }), { status: 429, headers: corsHeaders });
      }
      usage.text += 1;
    }

    // ذخیره مصرف در KV با انقضای ۲۴ ساعته
    await env.ANANAS_KV.put(storageKey, JSON.stringify(usage), { expirationTtl: 86400 });

    // ۳. ارسال درخواست به جمنای
    const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || "gemini-2.5-flash")}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(googleApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.text();
    return new Response(data, { status: response.status, headers: corsHeaders });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: `خطای سرور: ${err.message}` } }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async open onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-User-Token"
    }
  });
}
