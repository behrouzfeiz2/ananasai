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
    let limitImage = 4;

    if (env.ANANAS_KV) {
      try {
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
        let usage = JSON.parse((await env.ANANAS_KV.get(storageKey)) || '{"text": 0, "image": 0}');

        if (isImageRequest) {
          if (usage.image >= limitImage) {
            return new Response(
              JSON.stringify({ error: { message: "سهمیه ساخت تصویر امروز شما به پایان رسیده است." } }),
              { status: 429, headers: corsHeaders }
            );
          }
          usage.image += 1;
        } else {
          if (usage.text >= limitText) {
            return new Response(
              JSON.stringify({ error: { message: "سهمیه پیام‌های امروز شما به پایان رسیده است." } }),
              { status: 429, headers: corsHeaders }
            );
          }
          usage.text += 1;
        }

        context.waitUntil(
          env.ANANAS_KV.put(storageKey, JSON.stringify(usage), { expirationTtl: 86400 })
        );
      } catch (kvErr) {}
    }

    // فقط مدل‌های تاییدشده و موجود در اکانت شما
    let modelsToTry = isImageRequest
      ? [
          model || "gemini-3.1-flash-lite-image",
          "gemini-nano-banana-2.1",
          "gemini-3.1-flash-image",
          "gemini-2.5-flash-image"
        ]
      : [
          model || "gemini-3.5-flash-lite",
          "gemini-3.5-flash-lite-preview"
        ];

    modelsToTry = [...new Set(modelsToTry)];

    let errorsLog = [];
    let lastStatus = 500;

    for (const currentModel of modelsToTry) {
      const cleanModelName = currentModel.replace(/^models\//, "");
      const googleApiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      try {
        const response = await fetch(googleApiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        const responseText = await response.text();

        if (response.ok) {
          return new Response(responseText, { status: 200, headers: corsHeaders });
        }

        lastStatus = response.status;
        let errMsg = responseText;
        try {
          const errJson = JSON.parse(responseText);
          errMsg = errJson?.error?.message || responseText;
        } catch {}

        errorsLog.push(`[${cleanModelName}: ${errMsg}]`);

      } catch (fetchErr) {
        clearTimeout(timeoutId);
        const msg = fetchErr.name === "AbortError" ? "Timeout" : fetchErr.message;
        errorsLog.push(`[${cleanModelName}: ${msg}]`);
      }
    }

    return new Response(
      JSON.stringify({ error: { message: errorsLog.join(" | ") } }),
      { status: lastStatus, headers: corsHeaders }
    );

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
