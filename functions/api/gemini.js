const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

async function getUserStatusAndQuota(request, env) {
  const userToken = (request.headers.get("X-User-Token") || "").trim();
  const deviceUUID = (request.headers.get("X-Device-UUID") || "unknown_device").trim();

  let isPro = false;
  let limitText = 10; // سهمیه رایگان روزانه بر اساس دیوایس: ۱۰ پیام

  if (userToken !== "") {
    if (env.ANANAS_KV) {
      // بررسی مستقیم نام توکن در KV (بدون پیشوند اضافی جهت هماهنگی با پنل ادمین)
      const tokenData = await env.ANANAS_KV.get(userToken);
      if (tokenData) {
        isPro = true;
        limitText = 100; // سهمیه پرو روزانه: ۱۰۰ پیام
      } else {
        return { error: "کد فعال‌سازی نامعتبر یا منقضی شده است.", status: 401 };
      }
    }
  }

  // تنظیم تاریخ روز بر اساس منطقه زمانی ایران برای ریست دقیق سهمیه
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date());
  const storageKey = `usage_${isPro ? "pro_" : "device_"}${isPro ? userToken : deviceUUID}_${today}`;

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

    const hasAttachment = (payload?.contents || []).some(c =>
      (c.parts || []).some(p => p.inlineData)
    );

    if (!quota.isPro && (hasAttachment || mode === "coder")) {
      return new Response(
        JSON.stringify({
          error: { message: "امکان ضمیمه کردن فایل و استفاده از بخش تخصصی «کد نویس» ویژه کاربران پرو است." },
          quota: { isPro: quota.isPro, used: quota.usedText, limit: quota.limitText }
        }),
        { status: 403, headers: corsHeaders }
      );
    }

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

    const now = new Date();
    const todayStr = now.toLocaleDateString('fa-IR', { 
      timeZone: 'Asia/Tehran', 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    const gregorianStr = now.toLocaleDateString('en-US', {
      timeZone: 'Asia/Tehran',
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

let dynamicSystemPrompt = `نام تو «آناناس» (AnanasAI) است؛ یک دستیار هوش مصنوعی فارسی‌زبان، صمیمی، دقیق و حرفه‌ای که به موتور Google Gemini متصل است. (اطلاعات پس‌زمینه: امروز ${todayStr} مصادف با ${gregorianStr} به وقت تهران است). پاسخ‌هایت را به زبان فارسی روان، ساختاریافته و با فرمت Markdown ارائه بده. فقط در صورتی که کاربر به طور مستقیم درباره تاریخ، روز یا زمان سوال پرسید، تاریخ امروز را اعلام کن و در سایر گفتگوها از ذکر تاریخ خودداری کن.`;
    
    if (mode === 'coder') {
      dynamicSystemPrompt += ' شما در حال حاضر در نقش یک «کد نویس» و مهندس ارشد نرم‌افزار هستید. به سوالات برنامه‌نویسی، دیباگ، تحلیل فایل‌های کد، الگوریتم‌نویسی و توسعه وب به صورت تخصصی (از جمله Rust، پایتون، جاوااسکریپت و دیتابیس)، با کدهای تمیز و توضیحات دقیق پاسخ دهید.';
    }

    if (payload && payload.systemInstruction) {
      if (payload.systemInstruction.parts && payload.systemInstruction.parts[0]) {
        payload.systemInstruction.parts[0].text = dynamicSystemPrompt + " " + payload.systemInstruction.parts[0].text;
      }
    } else {
      payload.systemInstruction = {
        parts: [{ text: dynamicSystemPrompt }]
      };
    }

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

    if (response.ok) {
      quota.usedText += 1;
      if (env.ANANAS_KV) {
        context.waitUntil(
          env.ANANAS_KV.put(quota.storageKey, JSON.stringify({ text: quota.usedText }), { expirationTtl: 86400 })
        );
      }
    }

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
