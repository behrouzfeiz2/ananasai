const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// ======================================================
// ANANAS AI - FINAL BACKEND
// Gemini + Market Data + RSS News + Torob Shop + Groq
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
  SHOP_ENDPOINT: "/api/shop",

  ENABLE_MARKET_DATA: true,
  ENABLE_RSS_NEWS: true,
  ENABLE_SHOP_SEARCH: true,
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

  // علاوه بر درخواست صریح خبر، پرسش درباره نتیجه رویدادهای جاری
  // مانند انتخابات، جنگ، مسابقات و تصمیم‌های سیاسی را نیز شناسایی می‌کند.
  const newsPattern =
    /اخبار|خبرهای|خبر جدید|آخرین خبر|خبر روز|چه خبر|خبرگزاری|گزارش خبری|اتفاقات امروز|اخبار امروز|تحولات|رویدادهای|نتیجه انتخابات|نتایج انتخابات|انتخابات|انتخاباتی|میان.?دوره|کدام حزب|چه حزبی|برنده شد|برنده انتخابات|نتیجه رای|نتایج رای|شمارش آرا|کنگره آمریکا|مجلس سنا|سنای آمریکا|مجلس نمایندگان|جنگ|آتش.?بس|حمله|حملات|زلزله|طوفان|فوتبال امروز|نتیجه بازی|نتایج بازی|قهرمان شد|election|midterm|midterms|election results|who won|winning party|congressional|senate|house of representatives|latest news|breaking news|current events|ceasefire|war update|earthquake|storm|match result/i;

  // جست‌وجوی کالا فقط با نشانه‌های روشن قصد خرید یا پیدا کردن محصول فعال می‌شود.
  const shopPattern =
    /(?:^|\s)ترب(?:\s|$|\.com)|محصولات مرتبط|محصول مرتبط|جستجوی محصول|جست‌وجوی محصول|جستجو کن|جست‌وجو کن|بگرد|پیدا کن|پیدا می.?کنی|لینک خرید|لینک محصول|فروشگاه اینترنتی|می.?خوام بخرم|می.?خواهم بخرم|قصد خرید|برای خرید|خرید گوشی|خرید لپ.?تاپ|خرید موبایل|خرید تلویزیون|خرید هدفون|خرید ساعت|خرید تبلت|خرید دوربین|خرید کنسول|خرید پرینتر|می.?خوام.{0,25}(گوشی|موبایل|لپ.?تاپ|تلویزیون|هدفون|ساعت|تبلت|دوربین|کنسول|پرینتر)|دنبال.{0,20}(گوشی|موبایل|لپ.?تاپ|تلویزیون|هدفون|ساعت|تبلت|دوربین|کنسول|پرینتر)|buy|find products|search products|product search/i;

  const isShop = shopPattern.test(q);
  const isMarket = marketPattern.test(q) && !isShop;
  const isNews = newsPattern.test(q);

  return {
    market: isMarket,
    news: !isMarket && !isShop && isNews,
    shop: isShop
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
  const endpoint = new URL(CONFIG.NEWS_ENDPOINT, origin);

  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("limit", "5");

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

    if (!result || result.success !== true) {
      throw new Error(result?.error || "News service returned an invalid response");
    }

    // نسخه جدید news.js آرایه‌ای از خبرها برمی‌گرداند.
    // برای سازگاری با نسخه قدیمی، خروجی تک‌خبره نیز پشتیبانی می‌شود.
    const newsItems = Array.isArray(result.news)
      ? result.news
      : result.news
        ? [result.news]
        : [];

    const found = result.found === false
      ? false
      : newsItems.length > 0;

    return {
      success: true,
      found,
      query: result.query || query,
      mode: result.mode || "search",
      total: Number(result.total ?? newsItems.length) || 0,
      message: result.message || "",
      news: newsItems.slice(0, 5)
    };

  } catch (error) {
    console.error("ANANAS_NEWS_ERROR", error.message);

    return {
      success: false,
      found: false,
      error: error.message,
      news: []
    };
  }
}

function formatNewsData(data) {
  if (!data?.success) return "";

  if (!data.found || !Array.isArray(data.news) || data.news.length === 0) {
    return `
جست‌وجوی خبر در منابع RSS متصل به آناناس انجام شد، اما خبر مرتبطی پیدا نشد.

عبارت جست‌وجو: ${data.query || "نامشخص"}
نتیجه سرویس: ${data.message || "هیچ خبر مرتبطی در فیدهای بررسی‌شده پیدا نشد."}

قوانین:
- این نتیجه فقط به معنی پیدا نشدن خبر در منابع RSS متصل به آناناس است؛ نه اینکه در کل اینترنت خبری وجود ندارد.
- به کاربر پاسخ کلی «به اخبار روز دسترسی ندارم» نده.
- نتیجه انتخابات، آمار، نام برندگان یا جزئیات رویداد را حدس نزن.
- شفاف بگو در منابع خبری متصل‌شده، خبر مرتبطی پیدا نشد.
- اگر بخشی از سؤال با دانش عمومی قابل توضیح است، آن را از اطلاعات تأییدنشده درباره نتیجه رویداد جدا کن.
`;
  }

  const newsText = data.news.map((item, index) => {
    const title = item.title || "عنوان نامشخص";
    const description = item.description || "توضیحی در فید موجود نیست";
    const source = item.source || "منبع نامشخص";
    const publishedAt = item.publishedAt || item.pubDate || "نامشخص";
    const link = item.link || "لینک موجود نیست";
    const score = Number.isFinite(Number(item.relevanceScore))
      ? item.relevanceScore
      : "نامشخص";

    return `
خبر شماره ${index + 1}:
عنوان: ${title}
خلاصه: ${description}
منبع: ${source}
تاریخ انتشار: ${publishedAt}
لینک: ${link}
امتیاز ارتباط در جست‌وجو: ${score}
`;
  }).join("\n");

  return `
اطلاعات خبری دریافت‌شده از سرویس RSS آناناس:

عبارت جست‌وجو: ${data.query || "نامشخص"}
تعداد خبرهای دریافت‌شده: ${data.news.length}

${newsText}

قوانین استفاده از اخبار:
- پاسخ را بر اساس همین خبرهای دریافتی تنظیم کن.
- خبرها را با توجه به عنوان، خلاصه، تاریخ انتشار و منبع بررسی کن.
- اگر چند خبر به یک موضوع اشاره دارند، اطلاعات مشترک آن‌ها را با دقت ترکیب کن.
- اگر منابع درباره یک موضوع اطلاعات متفاوت یا متناقض دارند، اختلاف را شفاف بیان کن.
- عنوان منبع، تاریخ انتشار و لینک خبرهای استفاده‌شده را در پاسخ بیاور.
- لینک‌ها را دقیقاً همان‌طور که دریافت شده‌اند درج کن؛ لینک نساز و تغییر نده.
- وجود یک خبر در RSS به‌تنهایی به معنی تأیید مستقل تمام جزئیات آن نیست.
- اگر خبر فقط خلاصه دارد، ادعا نکن متن کامل مقاله را خوانده‌ای.
- اطلاعاتی را که در خبرها وجود ندارد، به‌عنوان واقعیت روز مطرح نکن.
- اگر خبرها پاسخ دقیق سؤال را نمی‌دهند، صریحاً بگو که اطلاعات موجود برای تعیین پاسخ قطعی کافی نیست.
- وقتی این داده‌ها در اختیار تو قرار گرفته‌اند، به‌جای پاسخ کلی درباره نداشتن دسترسی به اخبار روز، از همین داده‌ها استفاده کن.
`;
}

// ======================================================
// SHOP SEARCH - TOROB
// ======================================================

async function getShopData(request, query) {
  if (!CONFIG.ENABLE_SHOP_SEARCH) return null;

  const endpoint = new URL(
    CONFIG.SHOP_ENDPOINT,
    new URL(request.url).origin
  );

  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("limit", "10");

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
      const detail = await response.text();

      throw new Error(
        `Shop HTTP ${response.status}: ${detail.slice(0, 250)}`
      );
    }

    const result = await response.json();

    if (
      result?.success !== true ||
      !Array.isArray(result.products)
    ) {
      throw new Error(
        result?.error ||
        "Shop service returned an invalid response"
      );
    }

    return {
      success: true,
      query: result.query || query,
      total: Number(
        result.total ??
        result.count ??
        result.products.length
      ) || 0,
      products: result.products.slice(0, 10)
    };

  } catch (error) {
    console.error("ANANAS_SHOP_ERROR", error.message);

    return {
      success: false,
      error: error.message,
      query,
      products: []
    };
  }
}

function formatShopData(data) {
  if (!data?.success) return "";

  if (
    !Array.isArray(data.products) ||
    data.products.length === 0
  ) {
    return `
جست‌وجوی محصول در ترب انجام شد، اما محصولی برای عبارت جست‌وجو پیدا نشد.

عبارت جست‌وجو: ${data.query || "نامشخص"}

فقط اعلام کن در نتایج ترب محصولی پیدا نشد؛ محصول یا لینک جایگزین نساز.
`;
  }

  const productsText = data.products.map((item, index) => `
محصول ${index + 1}:
عنوان: ${item.name || "عنوان نامشخص"}
قیمت: ${item.price != null ? `${item.price} تومان` : "در ترب درج نشده"}
تصویر: ${item.image || "ندارد"}
لینک محصول در ترب: ${item.url || "ندارد"}
`).join("\n");

  return `
نتایج واقعی جست‌وجوی محصول در ترب:

عبارت جست‌وجو: ${data.query || "نامشخص"}
تعداد کل نتایج اعلام‌شده: ${data.total}
تعداد نتایج ارسالی: ${data.products.length}

${productsText}

قوانین:
- همه نتایج دریافتی را به صورت فهرست شماره‌دار نمایش بده؛ حداکثر ۱۰ محصول.
- عنوان و قیمت را دقیقاً از داده‌ها بردار. قیمت‌ها به تومان هستند.
- اگر قیمت یا لینک موجود نیست، نبود آن را اعلام کن؛ چیزی جعل نکن.
- لینک هر محصول را دقیقاً همان‌طور که دریافت شده درج کن.
- هیچ مقایسه قیمت، معرفی ارزان‌ترین فروشنده، رتبه‌بندی، پیشنهاد ویژه یا توصیه خرید ارائه نکن.
- درباره کیفیت یا مناسب بودن محصول ادعایی نکن.
- این‌ها صرفاً نتایج جست‌وجوی ترب هستند، نه پیشنهاد یا تأیید آناناس.
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
- اگر درباره اطلاعات جدید یا رویدادهای روز سؤال شد، ابتدا اطلاعات سرویس‌های داخلی آناناس را بررسی کن.
- اگر اطلاعات خبری یا بازاری از سرویس داخلی دریافت شده، از همان داده‌ها استفاده کن و محدودیت جست‌وجوی عمومی را بی‌جهت تکرار نکن.
- اگر نتایج جست‌وجوی محصول از ترب دریافت شده، آن‌ها را به صورت فهرست ساده نمایش بده.
- در جست‌وجوی محصول، هیچ مقایسه قیمت، پیشنهاد ویژه، رتبه‌بندی یا توصیه خرید انجام نده.
- هرگز ادعا نکن که در گوگل جست‌وجو کرده‌ای.
- هرگز منبع، لینک، خبر یا قیمت ساختگی تولید نکن.
- اگر داده‌ای در اختیار نداری، صریحاً بگو.
- از پاسخ‌های طولانی و غیرضروری خودداری کن.

محدودیت جست‌وجوی اینترنت:

آناناس در حال حاضر به جست‌وجوی زنده و عمومی گوگل متصل نیست؛ اما به برخی منابع داده داخلی مانند فیدهای RSS خبری و سرویس قیمت بازار متصل است.

قانون مهم:
- اگر داده خبری از RSS دریافت شده، بر اساس همان داده‌ها پاسخ بده و لینک منابع را درج کن.
- اگر داده محصولات از ترب دریافت شده، فقط همان محصولات را فهرست کن؛ مقایسه قیمت، رتبه‌بندی یا پیشنهاد ویژه انجام نده.
- اگر جست‌وجوی ترب نتیجه نداشت، فقط اعلام کن محصولی در نتایج پیدا نشد.
- اگر سرویس ترب خطای فنی داد یا دسترسی مسدود شد، مشکل را شفاف اعلام کن و وانمود نکن جست‌وجو موفق بوده است.
- اگر جست‌وجوی RSS با موفقیت انجام شده اما خبر مرتبطی پیدا نشده، فقط بگو در منابع RSS متصل‌شده خبر مرتبطی پیدا نشد؛ این موضوع را به عدم دسترسی کلی به اخبار تعبیر نکن.
- اگر سرویس RSS به دلیل خطای فنی در دسترس نبود، بگو دریافت خبر از منابع متصل‌شده موقتاً با مشکل مواجه شده است.
- فقط وقتی هیچ داده داخلی مرتبطی در اختیار نداری و پاسخ واقعاً به جست‌وجوی عمومی زنده نیاز دارد، محدودیت جست‌وجوی عمومی را توضیح بده.
- هرگز نتیجه انتخابات، آمار، برنده رویداد یا خبر تازه را از روی حدس یا صرفاً از دانش قدیمی خود اعلام نکن.

در صورت نیاز به توضیح محدودیت جست‌وجوی عمومی، می‌توانی بگویی:

«من در آناناس همراه شما هستم تا در مسیر یادگیری، پژوهش‌های علمی، برنامه‌نویسی و حل مسائل تخصصی کمک کنم. در حال حاضر به جست‌وجوی زنده و عمومی گوگل متصل نیستم؛ با این حال، می‌توانم از منابع خبری و اطلاعاتی که به آناناس متصل شده‌اند استفاده کنم. اگر موضوعی در این منابع پوشش داده نشده باشد، این محدودیت را شفاف اعلام می‌کنم.»

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
    let shopData = null;

    if (!attachmentExists && questionType.market) {
      marketData = await getMarketData(request);
    }

    if (!attachmentExists && questionType.news) {
      newsData = await getNewsData(request, lastMessage);
    }

    if (!attachmentExists && questionType.shop) {
      shopData = await getShopData(request, lastMessage);
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
سؤال کاربر درباره یک رویداد یا خبر روز است.
تلاش برای دریافت خبر از سرویس RSS آناناس انجام شد، اما سرویس به دلیل خطای فنی پاسخ معتبر نداد.
این وضعیت را با «خبر مرتبطی پیدا نشد» اشتباه نگیر.
هیچ خبر، نتیجه انتخابات، آمار یا تاریخ ساختگی تولید نکن.
به کاربر بگو دریافت خبر از منابع متصل‌شده موقتاً با مشکل مواجه شده است.
`;
      }
    }

    if (questionType.shop) {
      if (shopData?.success) {
        externalContext += formatShopData(shopData);
      } else {
        externalContext += `
کاربر درخواست جست‌وجوی محصول در ترب دارد، اما سرویس جست‌وجوی ترب به دلیل خطای فنی یا محدودیت دسترسی پاسخ نداده است.
هیچ محصول، قیمت یا لینکی جعل نکن.
به کاربر بگو جست‌وجوی ترب در حال حاضر با مشکل مواجه شده است و بعداً دوباره امتحان کند.
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
      newsServiceAvailable: Boolean(newsData?.success),
      newsAvailable: Boolean(newsData?.success && newsData?.found),
      newsFound: Boolean(newsData?.found),
      newsCount: Array.isArray(newsData?.news)
        ? newsData.news.length
        : 0,

      shopRequested: Boolean(questionType.shop),
      shopServiceAvailable: Boolean(shopData?.success),
      shopFound: Boolean(
        shopData?.success &&
        shopData?.products?.length
      ),
      shopCount: Array.isArray(shopData?.products)
        ? shopData.products.length
        : 0,

      googleSearch: false
    };

    if (marketData?.success) {
      responseJson.marketData = marketData;
    }

    if (newsData?.success) {
      responseJson.newsData = newsData;
    }

    if (shopData?.success) {
      responseJson.shopData = shopData;
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
