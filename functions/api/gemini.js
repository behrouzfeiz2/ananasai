const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token",
  "Content-Type": "application/json; charset=utf-8"
};

async function getUserStatusAndQuota(request, env) {
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  const userToken = (request.headers.get("X-User-Token") || "").trim();

  let isPro = false;
  let limitText = 10; // سهمیه روزانه اکانت رایگان: ۱۰ پیام

  if (userToken !== "") {
    if (env.ANANAS_KV) {
      const tokenData = await env.ANANAS_KV.get(`token_${userToken}`);
      if (tokenData) {
        isPro = true;
        limitText = 100; // سهمیه روزانه اکانت پرو: ۱۰۰ پیام
      } else {
        return { error: "کد فعال‌سازی نامعتبر یا منقضی شده است.", status: 401 };
      }
    }
  }

  const today = new Date().toISOString().split("T")[0];
  const storageKey = `usage_${isPro ? "pro_" : "free_"}${isPro ? userToken : clientIP}_${today}`;

  let usedText = 0;
  if (env.ANANAS_KV) {
    try {
      const rawUsage = await env.ANANAS_KV.get(storageKey);
      if (rawUsage) {
        const parsed = JSON.parse(rawUsage);
        usedText = Number(parsed.text || 0);
      }
    } catch (e) {}
  }

  return {
    isPro,
    limitText,
    usedText,
    storageKey
  };
}

// دریافت وضعیت اکانت و سهمیه مصرف‌شده هنگام باز شدن صفحه
export async function onRequestGet(context) {
  const { request, env } = context;
  try {
    const quota = await getUserStatusAndQuota(request, env);
    if (quota.error) {
      return new Response(
        JSON.stringify({ error: { message: quota.error } }),
        { status: quota.status, headers: corsHeaders }
      );
    }

    return new Response(
      JSON.stringify({
        quota: {
          isPro: quota.isPro,
          used: quota.usedText,
          limit: quota.limitText
        }
      }),
      { status: 200, headers: corsHeaders }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: `خطای سرور: ${err.message}` } }),
      { status: 500, headers: corsHeaders }
    );
  }
}

// ارسال پیام و بررسی محدودیت‌های اکانت رایگان و پرو
export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const body = await request.json();
    const { model, payload, mode } = body;

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "کلید GEMINI_API_KEY در تنظیمات کلودفلر تعریف نشده است." } }),
        { status: 500, headers: corsHeaders }
      );
    }

    const quota = await getUserStatusAndQuota(request, env);
    if (quota.error) {
      return new Response(
        JSON.stringify({ error: { message: quota.error } }),
        { status: quota.status, headers: corsHeaders }
      );
    }

    // بررسی وجود فایل ضمیمه در پیام ارسالی
    const hasAttachment = (payload?.contents || []).some(c =>
      (c.parts || []).some(p => p.inlineData)
    );

    // محدودیت امنیتی سمت سرور: ضمیمه فایل و بخش کدنویس فقط برای کاربران پرو
    if (!quota.isPro && (hasAttachment || mode === "coder")) {
      return new Response(
        JSON.stringify({
          error: { message: "امکان ضمیمه کردن فایل و استفاده از بخش تخصصی «کد نویس» ویژه کاربران پرو است." },
          quota: { isPro: quota.isPro, used: quota.usedText, limit: quota.limitText }
        }),
        { status: 403, headers: corsHeaders }
      );
    }

    // بررسی اتمام سهمیه پیام روزانه
    if (quota.usedText >= quota.limitText) {
      return new Response(
        JSON.stringify({
          error: {
            message: `سهمیه پیام‌های امروز شما (${quota.limitText} از ${quota.limitText}) به پایان رسیده است.${!quota.isPro ? " برای ارتقا به ۱۰۰ پیام روزانه، کد فعال‌سازی پرو تهیه کنید." : ""}`
          },
          quota: { isPro: quota.isPro, used: quota.usedText, limit: quota.limitText }
        }),
        { status: 429, headers: corsHeaders }
      );
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

    let responseJson = {};
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      return new Response(responseText, { status: response.status, headers: corsHeaders });
    }

    // اگر پاسخ گوگل موفقیت‌آمیز بود، ۱ واحد به مصرف روزانه اضافه کن
    if (response.ok) {
      quota.usedText += 1;
      if (env.ANANAS_KV) {
        context.waitUntil(
          env.ANANAS_KV.put(quota.storageKey, JSON.stringify({ text: quota.usedText }), { expirationTtl: 86400 })
        );
      }
    }

    // ارسال اطلاعات به‌روز سهمیه همراه با پاسخ گوگل به فرانت‌اند
    responseJson.quota = {
      isPro: quota.isPro,
      used: quota.usedText,
      limit: quota.limitText
    };

    return new Response(JSON.stringify(responseJson), { status: response.status, headers: corsHeaders });

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
    headers: corsHeaders
  });
}
