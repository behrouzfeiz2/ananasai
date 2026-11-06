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

    if (userToken && userToken.trim() !== "") {
      const cleanToken = userToken.trim();
      const tokenData = await env.ANANAS_KV.get(`token_${cleanToken}`);
      
      if (tokenData) {
        isPro = true;
        limitText = 100;
        limitImage = 10;
      } else {
        return new Response(
          JSON.stringify({ error: { message: "کد فعال‌سازی نامعتبر یا منقضی شده است." } }),
          { status: 401, headers: corsHeaders }
        );
      }
    }

    const today = new Date().toISOString().split('T')[0];
    const storageKey = `usage_${isPro ? 'pro_' : 'free_'}${userToken || clientIP}_${today}`;
    
    let usage = JSON.parse(await env.ANANAS_KV.get(storageKey) || '{"text": 0, "image": 0}');

    if (isImageRequest) {
      if (usage.image >= limitImage) {
        return new Response(JSON.stringify({ error: { message: "سهمیه ساخت تصویر امروز شما به پایان رسیده است." } }), { status: 429, headers: corsHeaders });
      }
      usage.image += 1;
    } else {
      if (usage.text >= limitText) {
        return new Response(JSON.stringify({ error: { message: "سهمیه پیام‌های امروز شما به پایان رسیده است." } }), { status: 429, headers: corsHeaders });
      }
      usage.text += 1;
    }

    await env.ANANAS_KV.put(storageKey, JSON.stringify(usage), { expirationTtl: 86400 });

    // انتخاب مدل دقیق بر اساس نوع درخواست (تصویر یا گفتگو)
    const targetModel = model || (isImageRequest ? "gemini-3.1-flash-lite-image" : "gemini-3.5-flash-lite");
    const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(targetModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    
    const response = await fetch(googleApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const responseDataText = await response.text();
    return new Response(responseDataText, { status: response.status, headers: corsHeaders });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: `خطای سرور: ${err.message}` } }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-User-Token"
    }
  });
}
