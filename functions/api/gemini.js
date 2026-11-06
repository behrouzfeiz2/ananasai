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

    const chatModels = [
      model || "gemini-3.5-flash-lite",
      "gemini-3.5-flash-lite-preview"
    ];

    // تابع کمکی برای فراخوانی مدل متنی جمنای
    async function callGeminiText(reqPayload) {
      let lastErr = "پاسخی از سرور دریافت نشد.";
      let lastSt = 500;

      for (const m of [...new Set(chatModels)]) {
        const cleanName = m.replace(/^models\//, "");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const controller = new AbortController();
        const tid = setTimeout(() => controller.abort(), 25000);

        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(reqPayload),
            signal: controller.signal
          });
          clearTimeout(tid);
          const txt = await res.text();

          if (res.ok) {
            return { ok: true, status: 200, text: txt };
          }
          lastSt = res.status;
          try {
            const j = JSON.parse(txt);
            lastErr = j?.error?.message || txt;
          } catch {
            lastErr = txt;
          }
        } catch (e) {
          clearTimeout(tid);
          lastErr = e.name === "AbortError" ? "Timeout" : e.message;
        }
      }
      return { ok: false, status: lastSt, error: lastErr };
    }

    // اگر درخواست ساخت تصویر است:
    if (isImageRequest) {
      // ۱. تبدیل پرامپت فارسی کاربر به پرامپت انگلیسی حرفه‌ای با جمنای
      const geminiPromptRes = await callGeminiText(payload);
      let englishPrompt = "A high quality digital art masterpiece, cinematic lighting, 8k";

      if (geminiPromptRes.ok) {
        try {
          const parsed = JSON.parse(geminiPromptRes.text);
          const extracted = parsed?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
          if (extracted) englishPrompt = extracted;
        } catch {}
      }

      // ۲. دریافت تصویر در سمت سرور (مخفی ماندن کامل آدرس از دید کاربر)
      const seed = Math.floor(Math.random() * 1000000);
      const imageApiUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;

      const imgController = new AbortController();
      const imgTimeout = setTimeout(() => imgController.abort(), 55000);

      try {
        const imgResponse = await fetch(imageApiUrl, {
          headers: { "User-Agent": "AnanasAI-Server/1.0" },
          signal: imgController.signal
        });
        clearTimeout(imgTimeout);

        if (!imgResponse.ok) {
          throw new Error("خطا در رندر تصویر از موتور گرافیکی.");
        }

        const arrayBuffer = await imgResponse.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64Image = btoa(binary);
        const mimeType = imgResponse.headers.get("content-type") || "image/jpeg";

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    { inlineData: { mimeType, data: base64Image } }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: corsHeaders }
        );
      } catch (imgErr) {
        clearTimeout(imgTimeout);
        return new Response(
          JSON.stringify({ error: { message: "زمان طراحی تصویر بیش از حد مجاز طول کشید، لطفاً دوباره امتحان کنید." } }),
          { status: 504, headers: corsHeaders }
        );
      }
    }

    // اگر درخواست چت معمولی است:
    const chatRes = await callGeminiText(payload);
    if (chatRes.ok) {
      return new Response(chatRes.text, { status: 200, headers: corsHeaders });
    }

    return new Response(
      JSON.stringify({ error: { message: chatRes.error } }),
      { status: chatRes.status, headers: corsHeaders }
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
