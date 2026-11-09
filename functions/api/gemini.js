
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// ======================================================
// ANANAS AI - FINAL BACKEND
// Gemini + Market Data + RSS News + Groq
// Cloudflare Pages Functions
// ======================================================

const CONFIG = {
  FREE_LIMIT: 10,
  PRO_LIMIT: 100,

  DEFAULT_MODEL: "gemini-3.8-flash",

  FALLBACK_MODELS: [
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite"
  ],

  GROQ_MODEL: "llama-3.1-8b-instant",

  GEMINI_TIMEOUT: 35000,
  GROQ_TIMEOUT: 25000,
  DATA_TIMEOUT: 12000,

  // مسیر سرویس‌های داخلی آناناس
  MARKET_ENDPOINT: "/api/nerkh",
  NEWS_ENDPOINT: "/api/news",

  ENABLE_MARKET_DATA: true,
  ENABLE_RSS_NEWS: true,
  ENABLE_GROQ: true
};

// ======================================================
// 1. HELPERS
// ======================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
}

function getTodayTehran() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran"
  }).format(new Date());
}

function getDateInfo() {
  const now = new Date();

  return {
    persian: now.toLocaleDateString("fa-IR", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }),
    gregorian: now.toLocaleDateString("en-US", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    })
  };
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/\s+/g, " ")
    .trim();
}

function getLastUserMessage(contents) {
  const lastUser = [...(contents || [])]
    .reverse()
    .find(item => item.role === "user");

  return (lastUser?.parts || [])
    .map(part => part.text || "")
    .join("\n")
    .trim();
}

function hasAttachments(contents) {
  return (contents || []).some(item =>
    (item.parts || []).some(part =>
      Boolean(part.inlineData || part.fileData)
    )
  );
}

function unique(array) {
  return [...new Set(array.filter(Boolean))];
}

// ======================================================
// 2. USER AUTHENTICATION AND QUOTA
// ======================================================

async function getUserStatusAndQuota(request, env) {
  const userToken = (
    request.headers.get("X-User-Token") || ""
  ).trim();

  const deviceUUID = (
    request.headers.get("X-Device-UUID") || "unknown_device"
  ).trim();

  let isPro = false;
  let limitText = CONFIG.FREE_LIMIT;

  if (userToken) {
    if (!env.ANANAS_KV) {
      return {
        error: "سیستم احراز هویت در دسترس نیست.",
        status: 503
      };
    }

    const tokenData = await env.ANANAS_KV.get(userToken);

    if (!tokenData) {
      return {
        error: "کد فعال‌سازی نامعتبر یا منقضی شده است.",
        status: 401
      };
    }

    isPro = true;
    limitText = CONFIG.PRO_LIMIT;
  }

  const today = getTodayTehran();

  const storageKey =
    `usage_${isPro ? "pro_" : "device_"}${isPro ? userToken : deviceUUID}_${today}`;

  let usedText = 0;

  if (env.ANANAS_KV) {
    try {
      const raw = await env.ANANAS_KV.get(storageKey);

      if (raw) {
        const parsed = JSON.parse(raw);
        usedText = Math.max(0, Number(parsed.text) || 0);
      }
    } catch (error) {
      console.error("QUOTA_READ_ERROR", error.message);
    }
  }

  return {
    isPro,
    limitText,
    usedText,
    storageKey
  };
}

async function saveQuota(context, env, quota) {
  quota.usedText++;

  if (!env.ANANAS_KV) return;

  const operation = env.ANANAS_KV.put(
    quota.storageKey,
    JSON.stringify({
      text: quota.usedText
    }),
    {
      expirationTtl: 86400
    }
  );

  if (context.waitUntil) {
    context.waitUntil(operation);
  } else {
    await operation;
  }
}

function getQuotaInfo(quota) {
  return {
    isPro: quota.isPro,
    used: quota.usedText,
    limit: quota.limitText
  };
}

// ======================================================
// 3. DETECT QUESTION CATEGORY
// ======================================================

function detectQuestionType(text) {
  const q = normalizeText(text);

  const marketPattern =
    /قیمت|نرخ|ارزش|چند شده|چنده|چند است|چقدر است|چقدر شده|بازار ارز|بازار طلا|دلار|یورو|پوند|لیر|سکه|طلای|طلا|نفت|برنت|مربع|انس جهانی|اونس|مظنه|بورس|شاخص کل|مبور|مربان|murban|brent|gold price|oil price|bitcoin price|btc price|ethereum price|exchange rate/i;

  const newsPattern =
    /اخبار|خبرهای|خبر جدید|آخرین خبر|خبر روز|چه خبر|خبرگزاری|گزارش خبری|اتفاقات امروز|اخبار امروز|تحولات|رویدادهای|iran news|latest news|breaking news/i;

  const isMarket = marketPattern.test(q);
  const isNews = newsPattern.test(q);

  return {
    market: isMarket,
    news: !isMarket && isNews
  };
}

// ======================================================
// 4. FETCH WITH TIMEOUT
// ======================================================

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeout
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// 5. MARKET DATA - NERKH.JS
// ======================================================

async function getMarketData(request) {
  if (!CONFIG.ENABLE_MARKET_DATA) return null;

  const origin = new URL(request.url).origin;
  const endpoint = origin + CONFIG.MARKET_ENDPOINT;

  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      },
      CONFIG.DATA_TIMEOUT
    );

    if (!response.ok) {
      throw new Error(`Market HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.data) {
      throw new Error(result.error || "Market data unavailable");
    }

    const items = result.data.items || [];

    if (!items.length) {
      throw new Error("Market data is empty");
    }

    return {
      success: true,
      source: result.data.source || "TGJU",
      updated_at: result.data.updated_at || "نامشخص",
      items
    };

  } catch (error) {
    console.error("ANANAS_MARKET_ERROR", error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

function formatMarketData(data) {
  if (!data?.success) return "";

  const lines = data.items.map(item =>
    `- ${item.title}: ${item.price} ${item.unit}`
  );

  return `
اطلاعات دریافتی از سرویس قیمت آناناس:

منبع: ${data.source}
زمان دریافت: ${data.updated_at}

${lines.join("\n")}

قوانین استفاده:
- فقط از اعداد بالا برای پاسخ به سؤال بازار استفاده کن.
- واحد پول را دقیقاً همان‌طور که دریافت شده اعلام کن.
- قیمت‌های نامشخص را حدس نزن.
- زمان دریافت را به کاربر اعلام کن.
- این داده‌ها را قیمت لحظه‌ای قطعی تلقی نکن؛ زمان به‌روزرسانی را ملاک قرار بده.
`;
}

// ======================================================
// 6. NEWS DATA - RSS SERVICE
// ======================================================

async function getNewsData(request, query) {
  if (!CONFIG.ENABLE_RSS_NEWS) return null;

  const origin = new URL(request.url).origin;

  const endpoint = new URL(
    CONFIG.NEWS_ENDPOINT,
    origin
  );

  endpoint.searchParams.set("q", query);

  try {
    const response = await fetchWithTimeout(
      endpoint.toString(),
      {
        method: "GET",
        headers: {
          "Accept": "application/json"
        }
      },
      CONFIG.DATA_TIMEOUT
    );

    if (!response.ok) {
      throw new Error(`News HTTP ${response.status}`);
    }

    const result = await response.json();

    if (!result.success || !result.news) {
      throw new Error(result.error || "No matching news");
    }

    return {
      success: true,
      query: result.query || query,
      news: result.news
    };

  } catch (error) {
    console.error("ANANAS_NEWS_ERROR", error.message);

    return {
      success: false,
      error: error.message
    };
  }
}

function formatNewsData(data) {
  if (!data?.success || !data.news) return "";

  const item = data.news;

  return `
اطلاعات خبری دریافت‌شده از منابع RSS آناناس:

عنوان: ${item.title || "نامشخص"}
توضیحات: ${item.description || "توضیحی موجود نیست"}
تاریخ انتشار: ${item.pubDate || "نامشخص"}
لینک خبر: ${item.link || "نامشخص"}

قوانین:
- این اطلاعات از فید خبری دریافت شده‌اند.
- خبر را به‌عنوان خبر تأییدشده و مستقل معرفی نکن.
- اگر متن خبر ناقص است، این موضوع را بیان کن.
- لینک خبر را در پاسخ درج کن.
- تاریخ انتشار را در صورت وجود اعلام کن.
- از ساختن جزئیات و اطلاعاتی که در داده وجود ندارند خودداری کن.
`;
}

// ======================================================
// 7. SYSTEM PROMPT
// ======================================================

function createSystemPrompt(mode, externalContext = "") {
  const date = getDateInfo();

  let prompt = `
نام تو «آناناس» (AnanasAI) است.

تو یک دستیار هوش مصنوعی فارسی‌زبان، صمیمی، دقیق و حرفه‌ای هستی.

هویت:
- همیشه نام خود را دقیقاً «آناناس» بنویس.
- از ترکیب حروف فارسی و انگلیسی در نام خودداری کن.
- هرگز نام یا نسخه ساختگی برای مدل خود اعلام نکن.

تاریخ امروز به وقت تهران:
${date.persian}

معادل میلادی:
${date.gregorian}

قوانین پاسخ‌گویی:
- به زبان فارسی روان پاسخ بده.
- از Markdown برای ساختاردهی استفاده کن.
- پاسخ‌ها دقیق، کاربردی و متناسب با سؤال باشند.
- فقط در صورت سؤال مستقیم درباره تاریخ، تاریخ امروز را اعلام کن.
- در موضوعات علمی، آموزشی، فنی و برنامه‌نویسی با دانش خود کمک کن.
- اگر درباره اطلاعات جدید یا رویدادهای روز سؤال شد، محدودیت دسترسی به جست‌وجوی عمومی اینترنت را صادقانه بیان کن.
- هرگز ادعا نکن که در گوگل جست‌وجو کرده‌ای.
- هرگز منبع، لینک، خبر یا قیمت ساختگی تولید نکن.
- اگر داده‌ای در اختیار نداری، صریحاً بگو.
- از پاسخ‌های طولانی و غیرضروری خودداری کن.

محدودیت جست‌وجوی اینترنت:

آناناس در حال حاضر به جست‌وجوی زنده و عمومی گوگل متصل نیست.
دلیل این محدودیت، عدم فعال بودن سرویس جست‌وجوی عمومی در زیرساخت فعلی و محدودیت دسترسی به این قابلیت است.

اگر کاربر درباره موضوعات روز، آخرین اخبار یا اطلاعاتی سؤال کرد که نیازمند جست‌وجوی عمومی است، محترمانه توضیح بده که امکان تأیید زنده آن اطلاعات را نداری.

از این توضیح پیشنهادی استفاده کن:

«من در آناناس همراه شما هستم تا در مسیر یادگیری، پژوهش‌های علمی، برنامه‌نویسی و حل مسائل تخصصی کمک کنم. در حال حاضر به جست‌وجوی زنده و عمومی گوگل متصل نیستم؛ بنابراین ممکن است درباره تازه‌ترین رویدادها و اطلاعات منتشرشده پس از آخرین به‌روزرسانی دانشم اطلاعات دقیقی نداشته باشم. با این حال، در موضوعات علمی و تخصصی می‌توانم با دانش موجود و اطلاعات متصل به آناناس به شما کمک کنم.»

نکته:
اگر اطلاعات بازار یا خبر از سرویس‌های داخلی آناناس در اختیار تو قرار گرفت، از آن اطلاعات استفاده کن و محدودیت جست‌وجوی عمومی را بی‌جهت تکرار نکن.

اطلاعات اختصاصی سرویس‌های داخلی:

${externalContext || "در این درخواست اطلاعات اضافی از سرویس‌های داخلی دریافت نشده است."}

`;

  if (mode === "coder") {
    prompt += `
نقش تخصصی:
تو یک مهندس ارشد نرم‌افزار و برنامه‌نویس حرفه‌ای هستی.

حوزه‌ها:
JavaScript، TypeScript، Python، Rust، HTML، CSS،
API، Backend، دیتابیس، امنیت، دیباگ و معماری نرم‌افزار.

قوانین:
- کد تمیز و قابل توسعه ارائه بده.
- قابلیت‌های قبلی کد را حفظ کن.
- هنگام اصلاح فایل، بخش‌های غیرمرتبط را حذف نکن.
- در صورت درخواست، کد کامل و یکپارچه ارائه بده.
- برای اطلاعات فنی متغیر، محدودیت دانش خود را اعلام کن.
`;
  }

  return prompt;
}

// ======================================================
// 8. GEMINI GENERATE CONTENT
// ======================================================

async function callGemini(
  model,
  apiKey,
  originalPayload,
  systemPrompt
) {
  const cleanModel = model.replace(/^models\//, "");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;

  const payload = structuredClone(originalPayload);

  const oldSystem = (
    payload.systemInstruction?.parts || []
  )
    .map(part => part.text || "")
    .filter(Boolean)
    .join("\n");

  payload.systemInstruction = {
    ...(payload.systemInstruction || {}),
    parts: [{
      text: systemPrompt +
        (oldSystem ? "\n\n" + oldSystem : "")
    }]
  };

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    CONFIG.GEMINI_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },

      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseText = await response.text();

    console.log("ANANAS_GEMINI_RESULT", {
      model: cleanModel,
      status: response.status,
      response: response.ok
        ? "SUCCESS"
        : responseText.slice(0, 1500)
    });

    return {
      ok: response.ok,
      status: response.status,
      responseText,
      model: cleanModel
    };

  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// 9. GROQ FALLBACK
// ======================================================

async function callGroq(apiKey, contents, systemPrompt) {
  const messages = [{
    role: "system",
    content: systemPrompt
  }];

  for (const item of contents) {
    const text = (item.parts || [])
      .map(part => part.text || "")
      .filter(Boolean)
      .join("\n");

    if (!text.trim()) continue;

    messages.push({
      role: item.role === "user" ? "user" : "assistant",
      content: text
    });
  }

  const response = await fetchWithTimeout(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },

      body: JSON.stringify({
        model: CONFIG.GROQ_MODEL,
        messages,
        temperature: 0.7
      })
    },
    CONFIG.GROQ_TIMEOUT
  );

  const responseText = await response.text();

  if (!response.ok) {
    console.error("ANANAS_GROQ_ERROR", {
      status: response.status,
      response: responseText.slice(0, 1500)
    });

    return null;
  }

  const result = JSON.parse(responseText);

  const answer =
    result.choices?.[0]?.message?.content || "";

  if (!answer.trim()) return null;

  return {
    candidates: [{
      content: {
        role: "model",
        parts: [{
          text: answer
        }]
      }
    }],

    provider: {
      name: "Groq",
      model: CONFIG.GROQ_MODEL
    }
  };
}

// ======================================================
// 10. GET REQUEST - QUOTA
// ======================================================

export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const quota = await getUserStatusAndQuota(
      request,
      env
    );

    if (quota.error) {
      return jsonResponse({
        error: {
          message: quota.error
        }
      }, quota.status);
    }

    return jsonResponse({
      quota: getQuotaInfo(quota)
    });

  } catch (error) {
    console.error("ANANAS_GET_ERROR", error);

    return jsonResponse({
      error: {
        message: "خطا در بررسی سهمیه کاربر."
      }
    }, 500);
  }
}

// ======================================================
// 11. MAIN POST REQUEST
// ======================================================

export async function onRequestPost(context) {
  const { request, env } = context;

  try {

    // دریافت درخواست
    const body = await request.json();

    const {
      model,
      payload: originalPayload,
      mode
    } = body;

    if (
      !originalPayload ||
      !Array.isArray(originalPayload.contents) ||
      !originalPayload.contents.length
    ) {
      return jsonResponse({
        error: {
          message: "ساختار درخواست معتبر نیست."
        }
      }, 400);
    }

    // بررسی کلید گوگل
    const geminiKey = env.GEMINI_API_KEY;

    if (!geminiKey) {
      return jsonResponse({
        error: {
          message: "کلید GEMINI_API_KEY تعریف نشده است."
        }
      }, 500);
    }

    // احراز هویت و سهمیه
    const quota = await getUserStatusAndQuota(
      request,
      env
    );

    if (quota.error) {
      return jsonResponse({
        error: {
          message: quota.error
        }
      }, quota.status);
    }

    if (quota.usedText >= quota.limitText) {
      return jsonResponse({
        error: {
          message:
            `سهمیه امروز شما (${quota.limitText} پیام) به پایان رسیده است.` +
            (!quota.isPro
              ? " برای دریافت ۱۰۰ پیام روزانه، کد فعال‌سازی پرو تهیه کنید."
              : "")
        },
        quota: getQuotaInfo(quota)
      }, 429);
    }

    const payload = structuredClone(originalPayload);
    const contents = payload.contents;

    const attachmentExists = hasAttachments(contents);

    // محدودیت حساب رایگان
    if (!quota.isPro && (attachmentExists || mode === "coder")) {
      return jsonResponse({
        error: {
          message:
            "امکان ضمیمه کردن فایل و استفاده از بخش تخصصی کدنویس ویژه کاربران پرو است."
        },
        quota: getQuotaInfo(quota)
      }, 403);
    }

    // تشخیص موضوع سؤال
    const lastMessage = getLastUserMessage(contents);
    const questionType = detectQuestionType(lastMessage);

    // دریافت اطلاعات تکمیلی فقط در صورت نیاز
    let marketData = null;
    let newsData = null;

    if (!attachmentExists && questionType.market) {
      marketData = await getMarketData(request);
    }

    if (!attachmentExists && questionType.news) {
      newsData = await getNewsData(request, lastMessage);
    }

    // ساخت Context اختصاصی
    let externalContext = "";

    if (questionType.market) {
      if (marketData?.success) {
        externalContext += formatMarketData(marketData);
      } else {
        externalContext += `
سؤال کاربر درباره قیمت یا اطلاعات بازار است.
سرویس دریافت قیمت آناناس در حال حاضر پاسخ نداده است.
هیچ قیمت یا نرخ ساختگی ارائه نکن.
به کاربر اطلاع بده که دریافت اطلاعات بازار موقتاً امکان‌پذیر نیست.
`;
      }
    }

    if (questionType.news) {
      if (newsData?.success) {
        externalContext += formatNewsData(newsData);
      } else {
        externalContext += `
سؤال کاربر درباره اخبار روز است.
سرویس RSS آناناس در حال حاضر خبر مرتبطی ارائه نکرده است.
هیچ خبر جدید یا تاریخ ساختگی تولید نکن.
به کاربر اطلاع بده که دریافت خبر در حال حاضر امکان‌پذیر نیست.
`;
      }
    }

    const systemPrompt = createSystemPrompt(
      mode,
      externalContext
    );

    // ==================================================
    // 12. GEMINI MODEL CHAIN
    // ==================================================

    let responseJson = null;
    let geminiSuccess = false;
    let lastError = null;

    const models = unique([
      model || CONFIG.DEFAULT_MODEL,
      ...CONFIG.FALLBACK_MODELS
    ]);

    for (const targetModel of models) {
      try {
        const result = await callGemini(
          targetModel,
          geminiKey,
          payload,
          systemPrompt
        );

        if (!result.ok) {
          lastError = {
            status: result.status,
            response: result.responseText
          };

          // خطای سهمیه پروژه با تغییر مدل حل نمی‌شود.
          if (result.status === 429) {
            break;
          }

          // خطای احراز هویت یا کلید نامعتبر
          if (result.status === 401 || result.status === 403) {
            break;
          }

          continue;
        }

        responseJson = JSON.parse(result.responseText);

        geminiSuccess = true;

        responseJson.provider = {
          name: "Gemini",
          model: result.model
        };

        break;

      } catch (error) {
        lastError = {
          message: error.message
        };

        console.error(
          "ANANAS_MODEL_EXCEPTION",
          targetModel,
          error.message
        );
      }
    }

    // ==================================================
    // 13. GROQ FALLBACK
    // ==================================================

    if (!geminiSuccess && CONFIG.ENABLE_GROQ) {
      const groqKey = env.GROQ_API_KEY;

      // Groq نمی‌تواند فایل‌های ضمیمه را در این ساختار پردازش کند.
      if (groqKey && !attachmentExists) {
        try {
          responseJson = await callGroq(
            groqKey,
            contents,
            systemPrompt
          );
        } catch (error) {
          console.error(
            "ANANAS_GROQ_EXCEPTION",
            error.message
          );
        }
      }
    }

    // ==================================================
    // 14. FINAL FAILURE
    // ==================================================

    if (!responseJson) {
      console.error("ANANAS_ALL_MODELS_FAILED", lastError);

      return jsonResponse({
        error: {
          message:
            "در حال حاضر موتور هوش مصنوعی آناناس در دسترس نیست. لطفاً کمی بعد دوباره تلاش کنید."
        },
        quota: getQuotaInfo(quota)
      }, 503);
    }

    // ==================================================
    // 15. SAVE QUOTA
    // ==================================================

    await saveQuota(
      context,
      env,
      quota
    );

    // ==================================================
    // 16. ADD METADATA
    // ==================================================

    responseJson.quota = getQuotaInfo(quota);

    responseJson.dataStatus = {
      marketRequested: questionType.market,
      marketAvailable: Boolean(marketData?.success),
      newsRequested: questionType.news,
      newsAvailable: Boolean(newsData?.success),
      googleSearch: false
    };

    if (marketData?.success) {
      responseJson.marketData = marketData;
    }

    if (newsData?.success) {
      responseJson.newsData = newsData;
    }

    return jsonResponse(responseJson, 200);

  } catch (error) {
    console.error("ANANAS_INTERNAL_ERROR", error);

    return jsonResponse({
      error: {
        message:
          "خطای داخلی سرور. لطفاً چند لحظه دیگر دوباره تلاش کنید."
      }
    }, 500);
  }
}

// ======================================================
// 17. OPTIONS
// ======================================================

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}
