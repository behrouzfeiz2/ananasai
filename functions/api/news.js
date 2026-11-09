
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "public, max-age=120"
};


const RSS_FEEDS = [
  // خبرگزاری‌ها و رسانه‌های عمومی
  {
    name: "ایران اینترنشنال",
    url: "https://www.iranintl.com/feed"
  },
  {
    name: "ایسنا",
    url: "https://www.isna.ir/rss"
  },
  {
    name: "خبرگزاری مهر",
    url: "https://www.mehrnews.com/rss"
  },
  {
    name: "خبرآنلاین",
    url: "https://www.khabaronline.ir/rss"
  },
  {
    name: "باشگاه خبرنگاران جوان",
    url: "https://www.yjc.ir/fa/rss/allnews"
  },
  {
    name: "تابناک",
    url: "https://www.tabnak.ir/fa/rss/allnews"
  },
  {
    name: "تسنیم",
    url: "https://www.tasnimnews.com/fa/rss/feed/0/8/0/%D9%85%D9%87%D9%85%D8%AA%D8%B1%DB%8C%D9%86-%D8%A7%D8%AE%D8%A8%D8%A7%D8%B1-%D8%AA%D8%B3%D9%86%DB%8C%D9%85"
  },
  {
    name: "عصر ایران",
    url: "https://www.asriran.com/fa/rss/allnews"
  },

  // اخبار فناوری
  {
    name: "زومیت",
    url: "https://www.zoomit.ir/feed/"
  },
  {
    name: "۱آی‌تی‌نویس",
    url: "https://www.1itnevis.com/feeds/posts/default?alt=rss"
  }
];


const MAX_FEED_AGE_DAYS = 10;
const FEED_CACHE_SECONDS = 300;
const MAX_ITEMS_PER_FEED = 40;

// کلمات عمومی که ارزش جست‌وجویی کمی دارند
const STOP_WORDS = new Set([
  "چی", "چیه", "چطور", "چگونه", "چرا", "کی", "کجا",
  "شد", "شده", "است", "بود", "هست", "خواهد", "میشود",
  "می‌شود", "را", "از", "به", "در", "با", "برای", "که",
  "این", "آن", "یک", "هم", "یا", "اما", "اگر", "چه",
  "نتیجه", "آخرین", "جدیدترین", "خبر", "اخبار",
  "the", "is", "are", "was", "were", "what", "when",
  "where", "who", "how", "why", "of", "in", "on",
  "to", "for", "and", "or", "a", "an"
]);

// تبدیل ارقام فارسی و عربی به انگلیسی
function normalizeDigits(text) {
  return String(text)
    .replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
    .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d));
}

// یکسان‌سازی متن فارسی و انگلیسی
function normalizeText(text) {
  return normalizeDigits(String(text || ""))
    .toLowerCase()
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[ۀة]/g, "ه")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// استخراج کلمات مهم پرسش
function extractKeywords(query) {
  return normalizeText(query)
    .split(" ")
    .filter(word => word.length > 1 && !STOP_WORDS.has(word));
}

// گسترش برخی عبارت‌های پرکاربرد برای جست‌وجوی چندزبانه
function expandQuery(query) {
  const normalized = normalizeText(query);
  const terms = new Set(extractKeywords(query));

  const aliases = [
    {
      patterns: ["انتخابات میان دوره ای", "انتخابات میان دوره", "میان دوره ای آمریکا"],
      words: ["midterm", "midterms", "election", "elections", "congress", "congressional"]
    },
    {
      patterns: ["انتخابات آمریکا", "انتخابات ایالات متحده"],
      words: ["us", "usa", "united", "states", "american", "election", "elections"]
    },
    {
      patterns: ["مجلس سنا", "سنای آمریکا"],
      words: ["senate", "senators"]
    },
    {
      patterns: ["مجلس نمایندگان"],
      words: ["house", "representatives"]
    },
    {
      patterns: ["هوش مصنوعی"],
      words: ["artificial", "intelligence", "ai"]
    },
    {
      patterns: ["جنگ اوکراین"],
      words: ["ukraine", "ukrainian", "russia", "russian"]
    }
  ];

  for (const item of aliases) {
    if (item.patterns.some(p => normalized.includes(normalizeText(p)))) {
      item.words.forEach(word => terms.add(word));
    }
  }

  return [...terms];
}

// پاک‌سازی متن XML
function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); }
      catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); }
      catch { return ""; }
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// استخراج محتوای یک تگ از XML
function getTagContent(xml, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`,
    "i"
  );

  const match = xml.match(regex);
  return match ? decodeXml(match[1]) : "";
}

// تبدیل تاریخ خبر
function parseDate(dateString) {
  if (!dateString) return null;

  const timestamp = Date.parse(dateString);

  if (Number.isNaN(timestamp)) return null;

  return new Date(timestamp).toISOString();
}

// دریافت RSS با کش پنج‌دقیقه‌ای
async function fetchFeed(feed) {
  const cache = caches.default;
  const cacheKey = new Request(
    `https://ananas-news-cache.local/${encodeURIComponent(feed.url)}`,
    { method: "GET" }
  );

  try {
    const cached = await cache.match(cacheKey);

    if (cached) {
      return await cached.json();
    }
  } catch {
    // در صورت خطای کش، دریافت مستقیم انجام می‌شود
  }

  const response = await fetch(feed.url, {
    headers: {
      "User-Agent": "Mozilla/5.0 AnanasAI-News/2.0",
      "Accept": "application/rss+xml, application/xml, text/xml, */*"
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`RSS ${feed.name}: HTTP ${response.status}`);
  }

  const xml = await response.text();

  // پشتیبانی از RSS و Atom
  let rawItems = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) || [];

  if (rawItems.length === 0) {
    rawItems = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) || [];
  }

  const items = rawItems
    .slice(0, MAX_ITEMS_PER_FEED)
    .map(raw => {
      const title = getTagContent(raw, "title");
      const description =
        getTagContent(raw, "description") ||
        getTagContent(raw, "summary") ||
        getTagContent(raw, "content");

      let link = getTagContent(raw, "link");

      // لینک‌های Atom ممکن است به شکل attribute باشند
      if (!link) {
        const linkMatch = raw.match(
          /<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i
        );
        if (linkMatch) link = linkMatch[1];
      }

      const pubDate =
        getTagContent(raw, "pubDate") ||
        getTagContent(raw, "published") ||
        getTagContent(raw, "updated") ||
        getTagContent(raw, "dc:date");

      if (!title) return null;

      return {
        title,
        description: description.slice(0, 1200),
        link,
        publishedAt: parseDate(pubDate),
        source: feed.name
      };
    })
    .filter(Boolean);

  try {
    const cacheResponse = new Response(JSON.stringify(items), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${FEED_CACHE_SECONDS}`
      }
    });

    await cache.put(cacheKey, cacheResponse);
  } catch {
    // ذخیره نشدن کش نباید پاسخ API را مختل کند
  }

  return items;
}

// محاسبه میزان ارتباط خبر با پرسش
function calculateRelevance(item, keywords, query) {
  const title = normalizeText(item.title);
  const description = normalizeText(item.description);
  const fullText = `${title} ${description}`;
  const normalizedQuery = normalizeText(query);

  let score = 0;
  let matchedKeywords = [];

  for (const keyword of keywords) {
    if (title.includes(keyword)) {
      score += keyword.length >= 5 ? 5 : 3;
      matchedKeywords.push(keyword);
    } else if (description.includes(keyword)) {
      score += keyword.length >= 5 ? 2 : 1;
      matchedKeywords.push(keyword);
    }
  }

  // امتیاز بیشتر برای وجود عبارت کامل پرسش
  if (normalizedQuery.length >= 8 && title.includes(normalizedQuery)) {
    score += 12;
  } else if (normalizedQuery.length >= 8 && fullText.includes(normalizedQuery)) {
    score += 7;
  }

  // امتیاز تازگی خبر
  if (item.publishedAt) {
    const ageHours =
      (Date.now() - new Date(item.publishedAt).getTime()) / 3600000;

    if (ageHours >= 0 && ageHours <= 24) {
      score += 4;
    } else if (ageHours <= 72 && ageHours >= 0) {
      score += 2;
    } else if (ageHours > MAX_FEED_AGE_DAYS * 24) {
      score -= 5;
    }
  }

  return {
    score,
    matchedKeywords
  };
}

// مرتب‌سازی اخبار از جدیدترین به قدیمی‌ترین
function sortByDate(a, b) {
  const dateA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
  const dateB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
  return dateB - dateA;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS
  });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get("q") || "").trim();

  const requestedLimit = Number.parseInt(url.searchParams.get("limit") || "8", 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 12))
    : 8;

  try {
    // دریافت هم‌زمان اخبار از منابع مختلف
    const results = await Promise.allSettled(
      RSS_FEEDS.map(feed => fetchFeed(feed))
    );

    let allNews = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        allNews.push(...result.value);
      }
    }

    // حذف خبرهای تکراری با عنوان یکسان
    const uniqueNews = [
      ...new Map(
        allNews.map(item => [normalizeText(item.title), item])
      ).values()
    ];

    // حذف خبرهای قدیمی، در صورتی که تاریخ انتشار مشخص باشد
    const recentNews = uniqueNews.filter(item => {
      if (!item.publishedAt) return true;

      const age = Date.now() - new Date(item.publishedAt).getTime();

      return age <= MAX_FEED_AGE_DAYS * 24 * 60 * 60 * 1000;
    });

    // حالت نمایش اخبار روز
    if (!query) {
      const news = recentNews
        .sort(sortByDate)
        .slice(0, limit);

      return jsonResponse({
        success: true,
        mode: "latest",
        total: news.length,
        news
      });
    }

    // حالت جست‌وجوی خبر مرتبط
    const keywords = expandQuery(query);

    if (keywords.length === 0) {
      return jsonResponse({
        success: false,
        error: "عبارت جست‌وجو مشخص نیست.",
        news: []
      }, 400);
    }

    const matchedNews = recentNews
      .map(item => {
        const relevance = calculateRelevance(item, keywords, query);

        return {
          ...item,
          relevanceScore: relevance.score,
          matchedKeywords: relevance.matchedKeywords
        };
      })
      // حداقل امتیاز برای جلوگیری از نمایش خبرهای بی‌ربط
      .filter(item => item.relevanceScore >= 3)
      .sort((a, b) => {
        if (b.relevanceScore !== a.relevanceScore) {
          return b.relevanceScore - a.relevanceScore;
        }

        return sortByDate(a, b);
      })
      .slice(0, limit);

    return jsonResponse({
      success: true,
      mode: "search",
      query,
      total: matchedNews.length,
      found: matchedNews.length > 0,
      message: matchedNews.length
        ? "خبرهای مرتبط پیدا شدند."
        : "در منابع خبری موجود، خبر مرتبطی پیدا نشد.",
      news: matchedNews
    });

  } catch (error) {
    return jsonResponse({
      success: false,
      error: "دریافت اخبار با مشکل مواجه شد.",
      details: error.message,
      news: []
    }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}
