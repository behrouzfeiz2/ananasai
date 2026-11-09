const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// ======================================================
// ANANAS AI - FINAL BACKEND
// Gemini + Market Data + RSS News + RSS Shop + Groq
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

  // قیمت‌های بازار مالی و کالاهای پایه به nerkh.js ارجاع می‌شوند.
  // عبارت عمومی «قیمت» عمداً در این الگو نیست تا «قیمت گوشی» خرید تشخیص داده شود.
  const marketPattern =
    /بازار ارز|نرخ ارز|دلار|یورو|پوند|لیر|درهم|سکه|طلای|طلا|نفت|برنت|مربع|انس جهانی|اونس|مظنه|بورس|شاخص کل|murban|brent|gold price|oil price|bitcoin price|btc price|ethereum price|exchange rate|forex|stock market|gold rate/i;

  // پرسش‌هایی که صریحاً درباره خبر یا رویداد جاری هستند، در اولویت news می‌مانند.
  const newsPattern =
    /اخبار|خبرهای|خبر جدید|آخرین خبر|خبر روز|چه خبر|خبرگزاری|گزارش خبری|اتفاقات امروز|اخبار امروز|تحولات|رویدادهای|نتیجه انتخابات|نتایج انتخابات|انتخابات|انتخاباتی|میان.?دوره|کدام حزب|چه حزبی|برنده شد|برنده انتخابات|نتیجه رای|نتایج رای|شمارش آرا|کنگره آمریکا|مجلس سنا|سنای آمریکا|مجلس نمایندگان|جنگ|آتش.?بس|حمله|حملات|زلزله|طوفان|فوتبال امروز|نتیجه بازی|نتایج بازی|قهرمان شد|election|midterm|midterms|election results|who won|winning party|congressional|senate|house of representatives|latest news|breaking news|current events|ceasefire|war update|earthquake|storm|match result/i;

  // قصد خرید صریح
  const shopIntentPattern =
    /ترب|محصولات مرتبط|محصول مرتبط|جستجوی محصول|جست‌وجوی محصول|جستجو کن|جست‌وجو کن|بگرد|پیدا کن|پیدا می.?کنی|لینک خرید|لینک محصول|فروشگاه اینترنتی|می.?خوام بخرم|می.?خواهم بخرم|قصد خرید|برای خرید|قیمت خرید|قیمت روز گوشی|buy|find products|search products|product search/i;

  // نام دسته‌های کالایی و برندها؛ بنابراین نوشتن صرف نام یک کالا/برند نیز جست‌وجو می‌کند.
  const productPattern =
    /گوشی|موبایل|اسمارت.?فون|تلفن همراه|آیفون|iphone|ipad|macbook|مک.?بوک|سامسونگ|samsung|galaxy|شیائومی|xiaomi|ردمی|redmi|پوکو|poco|هواوی|huawei|آنر|honor|نوکیا|nokia|اپل|apple|وان.?پلاس|oneplus|realme|ریلمی|لپ.?تاپ|کامپیوتر|مانیتور|تلویزیون|tv|تبلت|هدفون|ایرباد|هندزفری|ساعت هوشمند|ساعت|کنسول|پلی.?استیشن|ایکس.?باکس|دوربین|پرینتر|مودم|روتر|کیبورد|ماوس|موس|اسپیکر|پاوربانک|شارژر|کارت گرافیک|پردازنده|cpu|gpu|ssd|هارد|رم|قطعات کامپیوتر|لوازم خانگی|یخچال|ماشین لباسشویی|جاروبرقی|قهوه.?ساز|کولر|کفش|کتانی|لباس|کتاب|خودرو|ماشین/i;

  const isNews = newsPattern.test(q);
  const isShop = !isNews && (
    shopIntentPattern.test(q) ||
    productPattern.test(q)
  );
  const isMarket = !isNews && !isShop && marketPattern.test(q);

  return {
    market: isMarket,
    news: isNews && !isShop,
    shop: isShop
  };
}

function buildShopSearchQuery(text) {
  return String(text || "")
    .replace(/(?:لطفاً|لطفا|میشه|میشود|می.?تونی|می.?توانی|برام|برای من|لطفا برام)/gi, " ")
    .replace(/(?:جستجوی محصول|جست‌وجوی محصول|جستجو کن|جست‌وجو کن|پیدا کن|پیدا می.?کنی|بگرد|لینک خرید|لینک محصول|فروشگاه اینترنتی|قصد خرید|برای خرید|می.?خوام بخرم|می.?خواهم بخرم|می.?خوام|می.?خواهم|خرید|قیمت روز|قیمت|ارزان|ارزان.?ترین|بهترین|ترب)/gi, " ")
    .replace(/[؟?،,؛;!]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || String(text || "").trim().slice(0, 120);
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
// SHOP SEARCH - RSS SHOPPING & PRODUCT DISCOVERY
// ======================================================

async function getShopData(request, query) {
  if (!CONFIG.ENABLE_SHOP_SEARCH) return null;

  const searchQuery = buildShopSearchQuery(query);
  const endpoint = new URL(
    CONFIG.SHOP_ENDPOINT,
    new URL(request.url).origin
  );

  endpoint.searchParams.set("q", searchQuery);
  endpoint.searchParams.set("limit", "10");

  try {
    const response = await fetchWithTimeout(
      endpoint.toString(),
      {
        method: "GET",
        headers: { "Accept": "application/json" }
      },
      CONFIG.DATA_TIMEOUT
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Shop HTTP ${response.status}: ${detail.slice(0, 250)}`);
    }

    const result = await response.json();
    const products = Array.isArray(result?.products)
      ? result.products
      : Array.isArray(result?.items)
        ? result.items
        : null;

    if (result?.success !== true || !products) {
      throw new Error(result?.error || "Shop RSS service returned an invalid response");
    }

    return {
      success: true,
      query: result.query || searchQuery,
      originalQuery: query,
      total: Number(result.total ?? products.length) || 0,
      products: products.slice(0, 10),
      source_status: Array.isArray(result.source_status) ? result.source_status : [],
      fetched_at: result.fetched_at || null,
      cached: Boolean(result.cached),
      note: result.note || ""
    };

  } catch (error) {
    console.error("ANANAS_SHOP_ERROR", error.message);
    return {
      success: false,
      error: error.message,
      query: searchQuery,
      originalQuery: query,
      products: [],
      source_status: []
    };
  }
}

function formatShopData(data) {
  if (!data?.success) return "";

  const sourceStatusText = (data.source_status || []).map(source =>
    `- ${source.source}: ${source.ok ? "فعال" : "دارای خطا"}؛ تعداد مطالب: ${Number(source.count) || 0}`
  ).join("\n");

  if (!Array.isArray(data.products) || data.products.length === 0) {
    return `
جست‌وجو در فیدهای فروشگاهی و رسانه‌های فناوری آناناس با موفقیت انجام شد، اما مطلب مرتبطی پیدا نشد.

عبارت اصلی کاربر: ${data.originalQuery || "نامشخص"}
عبارت جست‌وجوی استفاده‌شده: ${data.query || "نامشخص"}

وضعیت منابع:
${sourceStatusText || "وضعیت منابع گزارش نشده است."}

قوانین:
- فقط بگو در منابع RSS متصل‌شده مطلب مرتبطی پیدا نشد.
- ادعا نکن در تمام فروشگاه‌ها یا کل اینترنت محصولی وجود ندارد.
- محصول، قیمت، فروشنده یا لینک جایگزین نساز.
`;
  }

  const productsText = data.products.map((item, index) => {
    const title = item.title || item.name || "عنوان نامشخص";
    const description = item.description || "خلاصه‌ای در فید موجود نیست";
    const source = item.source_name || item.source || "منبع نامشخص";
    const type = item.type || "محتوای عمومی";
    const published = item.published_at || item.publishedAt || "نامشخص";
    const url = item.url || item.link || "لینک موجود نیست";
    const image = item.image || "ندارد";
    const priceText = item.price_text || (item.price != null ? String(item.price) : null);
    const priceStatus = item.price_is_current === true
      ? "منبع آن را قیمت جاری اعلام کرده است؛ با این حال زمان و منبع را ذکر کن."
      : "قیمت لحظه‌ای یا تأییدشده نیست؛ فقط اشاره قیمتی داخل محتواست.";

    return `
مطلب شماره ${index + 1}:
عنوان: ${title}
خلاصه: ${description}
منبع: ${source}
نوع محتوا: ${type}
تاریخ انتشار: ${published}
قیمت ذکرشده در محتوا: ${priceText || "قیمتی درج نشده"}
وضعیت اعتبار قیمت: ${priceStatus}
واحد/کد ارز دریافتی: ${item.currency || "مشخص نشده"}
تصویر: ${image}
لینک منبع: ${url}
`;
  }).join("\n");

  return `
نتایج جست‌وجو از فیدهای RSS فروشگاهی و رسانه‌های فناوری آناناس:

عبارت اصلی کاربر: ${data.originalQuery || "نامشخص"}
عبارت جست‌وجوی استفاده‌شده: ${data.query || "نامشخص"}
تعداد کل مطالب موجود در فیدهای دریافت‌شده: ${data.total}
تعداد مطالب مرتبط ارسال‌شده: ${data.products.length}
زمان دریافت فیدها: ${data.fetched_at || "نامشخص"}
نتیجه از کش دریافت شده است: ${data.cached ? "بله" : "خیر"}

وضعیت منابع:
${sourceStatusText || "وضعیت منابع گزارش نشده است."}

${productsText}

قوانین مهم استفاده از نتایج:
- نتایج از RSS موبونیوز، تکنولایف، بینوشاپ و زومیت یا منابع فعال دیگری می‌آیند؛ نام منبع هر مطلب را دقیق اعلام کن.
- موبونیوز و زومیت عمدتاً منابع محتوایی، خبری، بررسی و راهنمای خرید هستند؛ آن‌ها را فروشنده مستقیم کالا معرفی نکن.
- بینوشاپ و تکنولایف نیز فقط بر اساس نوع محتوای واقعی هر نتیجه توصیف شوند؛ وجود مطلب در فید به‌تنهایی اثبات‌کننده موجودی فروشگاه نیست.
- عنوان، خلاصه، تاریخ و لینک را از داده‌های دریافتی بردار؛ لینک نساز و تغییر نده.
- اگر قیمت درج نشده، صریحاً بگو در مطلب قیمت مشخصی ارائه نشده است.
- اگر قیمت وجود دارد و price_is_current برابر false یا نامشخص است، آن را قیمت لحظه‌ای، قیمت امروز یا قیمت قابل خرید معرفی نکن؛ فقط بگو در محتوای منبع چنین قیمتی ذکر شده است.
- قیمت عددی را تبدیل، گرد یا با واحد دیگری بازنویسی نکن. در صورت وجود price_text، همان متن را مبنا قرار بده.
- تاریخ انتشار را کنار اطلاعات بیاور تا کاربر متوجه تازگی یا قدیمی بودن مطلب شود.
- از این داده‌ها نمی‌توان ارزان‌ترین فروشنده، موجودی فعلی، قیمت قطعی بازار یا رتبه‌بندی فروشندگان را نتیجه گرفت.
- اگر نتایج صرفاً مقاله یا بررسی هستند، آن‌ها را به‌عنوان مقاله و بررسی معرفی کن، نه فهرست کالاهای قابل خرید.
- ادعای کیفیت، اصالت، گارانتی، موجودی یا مناسب‌بودن محصول را بدون داده صریح مطرح نکن.
- نتایج RSS صرفاً محتوای منتشرشده منابع هستند و تأیید یا توصیه خرید آناناس محسوب نمی‌شوند.
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
- اگر نتایج جست‌وجوی محصول از فیدهای RSS دریافت شده‌اند، آن‌ها را با ذکر منبع، تاریخ و لینک معرفی کن.
- محتوای مقاله و بررسی را با محصول قابل خرید یا قیمت زنده اشتباه نگیر.
- هرگز ادعا نکن که در گوگل جست‌وجو کرده‌ای.
- هرگز منبع، لینک، خبر یا قیمت ساختگی تولید نکن.
- اگر داده‌ای در اختیار نداری، صریحاً بگو.
- از پاسخ‌های طولانی و غیرضروری خودداری کن.

محدودیت جست‌وجوی اینترنت:

آناناس در حال حاضر به جست‌وجوی زنده و عمومی گوگل متصل نیست؛ اما به برخی منابع داده داخلی مانند فیدهای RSS خبری و سرویس قیمت بازار متصل است.

قانون مهم:
- اگر داده خبری از RSS دریافت شده، بر اساس همان داده‌ها پاسخ بده و لینک منابع را درج کن.
- اگر داده محصولات از RSS دریافت شده، فقط مطالب و اطلاعات موجود در همان نتایج را گزارش کن و منبع هر مورد را مشخص کن.
- اگر جست‌وجوی RSS نتیجه نداشت، فقط اعلام کن در منابع متصل‌شده مطلب مرتبطی پیدا نشد؛ درباره کل بازار نتیجه‌گیری نکن.
- اگر سرویس RSS خطای فنی داد، مشکل دریافت اطلاعات از منابع متصل‌شده را شفاف اعلام کن و وانمود نکن جست‌وجو موفق بوده است.
- قیمت استخراج‌شده از RSS را قیمت زنده یا قابل خرید معرفی نکن، مگر خود داده صریحاً price_is_current را true اعلام کرده باشد.
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
کاربر درخواست جست‌وجوی محصول یا محتوای فروشگاهی دارد، اما سرویس RSS آناناس به دلیل خطای فنی پاسخ معتبر نداده است.
هیچ محصول، قیمت، منبع یا لینکی جعل نکن.
به کاربر بگو دریافت اطلاعات از منابع فروشگاهی و فناوری متصل‌شده موقتاً با مشکل مواجه شده است و بعداً دوباره امتحان کند.
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
      shopSourceCount: Array.isArray(shopData?.source_status)
        ? shopData.source_status.filter(source => source.ok).length
        : 0,
      shopSources: Array.isArray(shopData?.source_status)
        ? shopData.source_status.map(source => ({
            source: source.source,
            available: Boolean(source.ok),
            count: Number(source.count) || 0
          }))
        : [],

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
