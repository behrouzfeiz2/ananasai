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
    const { model, payload } = body;

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "کلید GEMINI_API_KEY در تنظیمات کلودفلر تعریف نشده است." } }),
        { status: 500, headers: corsHeaders }
      );
    }

    const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
    const userToken = request.headers.get("X-User-Token");

    let isPro = false;
    let limitText = 20;

    if (env.ANANAS_KV) {
      try {
        if (userToken && userToken.trim() !== "") {
          const cleanToken = userToken.trim();
          const tokenData = await env.ANANAS_KV.get(`token_${cleanToken}`);

          if (tokenData) {
            isPro = true;
            limitText = 100;
          } else {
            return new Response(
              JSON.stringify({ error: { message: "کد فعال‌سازی نامعتبر یا منقضی شده است." } }),
              { status: 401, headers: corsHeaders }
            );
          }
        }

        const today = new Date().toISOString().split('T')[0];
        const storageKey = `usage_${isPro ? 'pro_' : 'free_'}${userToken || clientIP}_${today}`;
        let usage = JSON.parse((await env.ANANAS_KV.get(storageKey)) || '{"text": 0}');

        if (usage.text >= limitText) {
          return new Response(
            JSON.stringify({ error: { message: "سهمیه پیام‌های امروز شما به پایان رسیده است." } }),
            { status: 429, headers: corsHeaders }
          );
        }
        usage.text += 1;

        context.waitUntil(
          env.ANANAS_KV.put(storageKey, JSON.stringify(usage), { expirationTtl: 86400 })
        );
      } catch (kvErr) {}
    }

    const targetModel = model || "gemini-3.5-flash-lite";
    const cleanName = targetModel.replace(/^models\//, "");
    const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(googleApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const responseText = await response.text();

    return new Response(responseText, { status: response.status, headers: corsHeaders });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: `خطای داخلی سرور: ${err.message}` } }),
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
