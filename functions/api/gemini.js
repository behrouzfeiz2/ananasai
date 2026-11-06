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

    // اولویت‌بندی مدل‌های ساخت تصویر شامل gemini-nano-banana-2.1 و شناسه‌های جایگزین در API
    let modelsToTry = isImageRequest
      ? [
          model || "gemini-nano-banana-2.1",
          "gemini-nano-banana-2.1",
          "gemini-3.1-flash-image-preview",
          "gemini-3.1-flash-image",
          "gemini-2.5-flash-image",
          "gemini-2.0-flash-preview-image-generation"
        ]
      : [
          model || "gemini-3.5-flash-lite",
          "gemini-3.5-flash-lite-preview",
          "gemini-3.8-flash"
        ];

    // حذف موارد تکراری
    modelsToTry = [...new Set(modelsToTry)];

    let lastError = "پاسخی از سرور گوگل دریافت نشد.";
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
        try {
          const errJson = JSON.parse(responseText);
          lastError = errJson?.error?.message || responseText;
        } catch {
          lastError = responseText;
        }

        if (response.status === 404 || response.status === 400 || response.status === 503 || response.status === 429) {
          continue;
        } else {
          break;
        }
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        lastError = fetchErr.name === "AbortError"
          ? "زمان پاسخگویی سرور گوگل بیش از حد طولانی شد (Timeout)."
          : fetchErr.message;
      }
    }

    // اگر در حالت تصویر همه نام‌های بالا 404 دادند، خودکار از ListModels گوگل مدل تصویر فعال را پیدا کن
    if (isImageRequest && lastStatus === 404) {
      try {
        const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
        if (listRes.ok) {
          const listData = await listRes.json();
          const availableImageModels = (listData.models || [])
            .filter(m => m.name && (m.name.includes("image") || m.name.includes("banana")) && (m.supportedGenerationMethods || []).includes("generateContent"))
            .map(m => m.name.replace(/^models\//, ""));

          for (const autoModel of availableImageModels) {
            const autoUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(autoModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const autoRes = await fetch(autoUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            if (autoRes.ok) {
              const autoText = await autoRes.text();
              return new Response(autoText, { status: 200, headers: corsHeaders });
            }
          }

          if (availableImageModels.length > 0) {
            lastError += ` | مدل‌های تصویر یافت‌شده در اکانت شما: ${availableImageModels.join(", ")}`;
          }
        }
      } catch (e) {}
    }

    return new Response(
      JSON.stringify({ error: { message: lastError } }),
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
