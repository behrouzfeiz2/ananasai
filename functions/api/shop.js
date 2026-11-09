// ======================================================
// ANANAS AI - TOROB PRODUCT API
// Cloudflare Pages Function: /api/shop
//
// Compatible with existing gemini.js
//
// SEARCH:
// GET  /api/shop?q=گوشی سامسونگ
// POST /api/shop { "query": "گوشی سامسونگ" }
//
// SUGGESTIONS:
// GET /api/shop?action=suggest&q=سامسونگ
//
// PRODUCT DETAILS:
// GET /api/shop?action=details&id=PRODUCT_ID
//
// SELLERS:
// GET /api/shop?action=sellers&id=PRODUCT_ID
//
// PRICE CHART:
// GET /api/shop?action=price-chart&id=PRODUCT_ID
//
// SPECIAL OFFERS:
// GET /api/shop?action=offers
//
// ======================================================

const TOROB_API = "https://api.torob.com";
const TOROB_SITE = "https://torob.com";

const CONFIG = {
  SEARCH_LIMIT: 10,
  MAX_SEARCH_LIMIT: 30,
  MAX_QUERY_LENGTH: 120,

  TIMEOUT: 15000,

  CACHE: {
    search: 180,
    suggest: 300,
    details: 300,
    sellers: 180,
    chart: 900,
    offers: 300
  }
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

// ======================================================
// 1. RESPONSE HELPERS
// ======================================================

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}

function normalizeQuery(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .trim()
    .slice(0, CONFIG.MAX_QUERY_LENGTH);
}

function cleanText(value, maxLength = 500) {
  if (typeof value !== "string") return null;

  const text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text ? text.slice(0, maxLength) : null;
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return null;

    return url.toString();
  } catch {
    return null;
  }
}

function safeNumber(value) {
  const number = Number(value);

  return Number.isFinite(number) && number > 0
    ? Math.round(number)
    : null;
}

function getProductUrl(id) {
  return `${TOROB_SITE}/p/${encodeURIComponent(id)}/`;
}

function getProductId(url) {
  return (
    url.searchParams.get("id") ||
    url.searchParams.get("prk") ||
    ""
  ).trim();
}

// ======================================================
// 2. FETCH WITH TIMEOUT
// ======================================================

async function fetchTorob(url) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    CONFIG.TIMEOUT
  );

  try {
    const response = await fetch(url, {
      method: "GET",

      headers: {
        "Accept": "application/json",
        "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
        "User-Agent": "Mozilla/5.0"
      },

      signal: controller.signal
    });

    if (response.status === 490) {
      const error = new Error(
        "ترب درخواست را به دلیل محدودیت امنیتی نپذیرفت."
      );

      error.code = "TOROB_BLOCKED";
      error.status = 503;

      throw error;
    }

    if (response.status === 403 || response.status === 429) {
      const error = new Error(
        "دسترسی به سرویس ترب موقتاً محدود شده است."
      );

      error.code = "TOROB_RATE_LIMIT";
      error.status = 503;

      throw error;
    }

    if (!response.ok) {
      const error = new Error(
        `Torob HTTP ${response.status}`
      );

      error.code = "TOROB_UPSTREAM_ERROR";
      error.status = 502;

      throw error;
    }

    const contentType =
      response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
      const error = new Error(
        "پاسخ دریافتی از ترب JSON معتبر نیست."
      );

      error.code = "TOROB_INVALID_RESPONSE";
      error.status = 502;

      throw error;
    }

    return await response.json();

  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error(
        "زمان انتظار برای پاسخ ترب به پایان رسید."
      );

      timeoutError.code = "TOROB_TIMEOUT";
      timeoutError.status = 504;

      throw timeoutError;
    }

    if (!error.status) {
      error.status = 502;
      error.code = error.code || "TOROB_CONNECTION_ERROR";
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

// ======================================================
// 3. CACHE
// ======================================================

async function cachedFetch(url, cacheType) {
  const ttl = CONFIG.CACHE[cacheType] || 180;

  const cacheKey = new Request(
    url.toString(),
    { method: "GET" }
  );

  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cached = await caches.default.match(cacheKey);

      if (cached) {
        const data = await cached.json();

        return {
          data,
          cached: true
        };
      }
    }
  } catch (error) {
    console.warn("TOROB_CACHE_READ_ERROR", error.message);
  }

  const data = await fetchTorob(url);

  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cacheResponse = new Response(
        JSON.stringify(data),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${ttl}`
          }
        }
      );

      await caches.default.put(cacheKey, cacheResponse);
    }
  } catch (error) {
    console.warn("TOROB_CACHE_WRITE_ERROR", error.message);
  }

  return {
    data,
    cached: false
  };
}

// ======================================================
// 4. PRODUCT NORMALIZATION
// ======================================================

function mapProduct(item) {
  if (!item || typeof item !== "object") return null;

  const id = cleanText(
    item.random_key || item.prk || "",
    160
  );

  if (!id) return null;

  const price = safeNumber(item.price);

  return {
    id,

    name: cleanText(item.name1, 250) ||
      "محصول بدون عنوان",

    name_en: cleanText(item.name2, 250),

    price,

    currency: price !== null ? "تومان" : null,

    image: safeHttpsUrl(item.image_url),

    url: getProductUrl(id),

    stock_status: cleanText(item.stock_status, 100),

    availability:
      typeof item.availability === "boolean"
        ? item.availability
        : null,

    discount: item.discount_info || null,

    badges: Array.isArray(item.badges)
      ? item.badges
      : [],

    sponsored: item.is_adv === true
  };
}

// ======================================================
// 5. SEARCH PRODUCTS
// ======================================================

async function searchProducts(url) {
  const query = normalizeQuery(
    url.searchParams.get("q") ||
    url.searchParams.get("query") ||
    ""
  );

  if (query.length < 2) {
    return {
      success: false,
      error: "عبارت جست‌وجو باید حداقل ۲ نویسه باشد.",
      code: "INVALID_QUERY",
      products: []
    };
  }

  const page = Math.max(
    0,
    Math.min(
      100,
      parseInt(url.searchParams.get("page") || "0", 10) || 0
    )
  );

  const requestedLimit = parseInt(
    url.searchParams.get("limit") || CONFIG.SEARCH_LIMIT,
    10
  );

  const limit = Math.max(
    1,
    Math.min(
      CONFIG.MAX_SEARCH_LIMIT,
      Number.isFinite(requestedLimit)
        ? requestedLimit
        : CONFIG.SEARCH_LIMIT
    )
  );

  const apiUrl = new URL(
    `${TOROB_API}/v4/base-product/search/`
  );

  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("page", String(page));
  apiUrl.searchParams.set("size", String(limit));
  apiUrl.searchParams.set("source", "next_desktop");

  const result = await cachedFetch(apiUrl, "search");

  const raw = result.data;

  const rows = Array.isArray(raw.results)
    ? raw.results
    : [];

  const products = rows
    .map(mapProduct)
    .filter(Boolean)
    .slice(0, limit);

  return {
    success: true,

    query,

    page,

    total: Number.isFinite(Number(raw.count))
      ? Number(raw.count)
      : products.length,

    count: products.length,

    products,

    did_you_mean: cleanText(
      raw.spellcheck?.corrected_query,
      200
    ),

    source: "Torob",

    cached: result.cached
  };
}

// ======================================================
// 6. SEARCH SUGGESTIONS
// ======================================================

async function getSuggestions(url) {
  const query = normalizeQuery(
    url.searchParams.get("q") || ""
  );

  if (query.length < 1) {
    return {
      success: false,
      error: "عبارت جست‌وجو خالی است.",
      suggestions: []
    };
  }

  const apiUrl = new URL(
    `${TOROB_API}/suggestion2/`
  );

  apiUrl.searchParams.set("q", query);

  const result = await cachedFetch(apiUrl, "suggest");

  const rows = Array.isArray(result.data)
    ? result.data
    : [];

  const suggestions = rows.slice(0, 10).map(item => ({
    text: cleanText(item.text, 200),

    type: cleanText(item.suggestion_type, 50),

    group: cleanText(item.suggestion_group, 100),

    is_history: item.is_history === true,

    entity: item.entity
      ? {
          type: cleanText(item.entity.type, 50),
          name: cleanText(item.entity.name1, 200)
        }
      : null
  }));

  return {
    success: true,
    query,
    count: suggestions.length,
    suggestions,
    source: "Torob",
    cached: result.cached
  };
}

// ======================================================
// 7. PRODUCT DETAILS
// ======================================================

async function getProductDetails(url) {
  const id = getProductId(url);

  if (!id) {
    return {
      success: false,
      error: "شناسه محصول ارسال نشده است.",
      code: "MISSING_PRODUCT_ID"
    };
  }

  const apiUrl = new URL(
    `${TOROB_API}/v4/base-product/details/`
  );

  apiUrl.searchParams.set("prk", id);

  const result = await cachedFetch(apiUrl, "details");

  const raw = result.data;

  const price = safeNumber(raw.price);

  return {
    success: true,

    id: cleanText(raw.random_key || raw.prk || id, 160),

    name: cleanText(raw.name1, 250),

    name_en: cleanText(raw.name2, 250),

    price,

    currency: price !== null ? "تومان" : null,

    min_price: safeNumber(raw.min_price),

    max_price: safeNumber(raw.max_price),

    image: safeHttpsUrl(raw.image_url),

    url: getProductUrl(id),

    availability:
      typeof raw.availability === "boolean"
        ? raw.availability
        : null,

    stock_status: cleanText(raw.stock_status, 100),

    is_authentic:
      typeof raw.is_authentic === "boolean"
        ? raw.is_authentic
        : null,

    discount: raw.discount_info || null,

    badges: Array.isArray(raw.badges)
      ? raw.badges
      : [],

    breadcrumbs: Array.isArray(raw.breadcrumbs)
      ? raw.breadcrumbs
      : [],

    key_specs: Array.isArray(raw.key_specs)
      ? raw.key_specs
      : [],

    structural_specs: Array.isArray(raw.structural_specs)
      ? raw.structural_specs
      : [],

    variants: Array.isArray(raw.variants)
      ? raw.variants
      : [],

    contents: Array.isArray(raw.contents)
      ? raw.contents
      : [],

    category: raw.torob_category || null,

    source: "Torob",

    cached: result.cached
  };
}

// ======================================================
// 8. PRODUCT SELLERS
// ======================================================

function mapSeller(item, parentId) {
  if (!item || typeof item !== "object") return null;

  const price = safeNumber(item.price);

  return {
    id: cleanText(item.prk, 160),

    product_id: parentId,

    shop_name: cleanText(item.shop_name, 200),

    shop_city: cleanText(item.shop_name2, 100),

    price,

    currency: price !== null ? "تومان" : null,

    price_text: cleanText(item.price_text, 150),

    old_price_text: cleanText(
      item.price_text_striked,
      150
    ),

    availability:
      typeof item.availability === "boolean"
        ? item.availability
        : null,

    is_price_unreliable:
      item.is_price_unreliable === true,

    shop_score: item.shop_score ?? null,

    shop_votes_count:
      safeNumber(item.shop_votes_count),

    guarantee: cleanText(
      item.guarantee_info,
      300
    ),

    postage_fee: safeNumber(item.postage_fee),

    purchase_url: safeHttpsUrl(item.page_url),

    sponsored: item.is_adv === true
  };
}

async function getSellers(url) {
  const id = getProductId(url);

  if (!id) {
    return {
      success: false,
      error: "شناسه محصول ارسال نشده است.",
      code: "MISSING_PRODUCT_ID",
      sellers: []
    };
  }

  const page = Math.max(
    0,
    Math.min(
      100,
      parseInt(url.searchParams.get("page") || "0", 10) || 0
    )
  );

  const size = Math.max(
    1,
    Math.min(
      30,
      parseInt(url.searchParams.get("limit") || "20", 10) || 20
    )
  );

  const apiUrl = new URL(
    `${TOROB_API}/v4/base-product/sellers/`
  );

  apiUrl.searchParams.set("prk", id);
  apiUrl.searchParams.set("page", String(page));
  apiUrl.searchParams.set("size", String(size));

  const result = await cachedFetch(apiUrl, "sellers");

  const rows = Array.isArray(result.data.results)
    ? result.data.results
    : [];

  const sellers = rows
    .map(item => mapSeller(item, id))
    .filter(Boolean);

  return {
    success: true,

    product_id: id,

    total: Number(result.data.count) || sellers.length,

    page,

    count: sellers.length,

    sellers,

    source: "Torob",

    cached: result.cached
  };
}

// ======================================================
// 9. PRICE CHART
// ======================================================

async function getPriceChart(url) {
  const id = getProductId(url);

  if (!id) {
    return {
      success: false,
      error: "شناسه محصول ارسال نشده است.",
      code: "MISSING_PRODUCT_ID",
      chart: []
    };
  }

  const apiUrl = new URL(
    `${TOROB_API}/v4/base-product/price-chart/`
  );

  apiUrl.searchParams.set("prk", id);

  const result = await cachedFetch(apiUrl, "chart");

  const raw = result.data;

  const labels = Array.isArray(raw.labels)
    ? raw.labels
    : [];

  const dataSets = Array.isArray(raw.dataSets)
    ? raw.dataSets
    : [];

  const chart = dataSets.map(dataset => {
    const entries = Array.isArray(dataset.entries)
      ? dataset.entries
      : [];

    const points = entries
      .map(entry => {
        const index = Number(entry.i);
        const price = safeNumber(entry.val);

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= labels.length ||
          price === null
        ) {
          return null;
        }

        return {
          date: cleanText(String(labels[index]), 100),
          price
        };
      })
      .filter(Boolean);

    return {
      label: cleanText(dataset.label, 100),
      points
    };
  });

  return {
    success: true,

    product_id: id,

    chart,

    count: chart.reduce(
      (total, item) => total + item.points.length,
      0
    ),

    source: "Torob",

    cached: result.cached
  };
}

// ======================================================
// 10. SPECIAL OFFERS
// ======================================================

async function getSpecialOffers() {
  const apiUrl = new URL(
    `${TOROB_API}/v4/special-offers/`
  );

  const result = await cachedFetch(apiUrl, "offers");

  const raw = result.data;

  // ساختار این API ممکن است تغییر کند.
  // بنابراین چند ساختار رایج پاسخ بررسی می‌شود.

  let offers = [];

  if (Array.isArray(raw)) {
    offers = raw;

  } else if (Array.isArray(raw.results)) {
    offers = raw.results;

  } else if (Array.isArray(raw.offers)) {
    offers = raw.offers;

  } else if (Array.isArray(raw.products)) {
    offers = raw.products;
  }

  return {
    success: true,

    count: offers.length,

    offers: offers.slice(0, 30),

    source: "Torob",

    cached: result.cached
  };
}

// ======================================================
// 11. REQUEST HANDLER
// ======================================================

async function readRequest(request) {
  const url = new URL(request.url);

  let action = url.searchParams.get("action") || "";

  let query =
    url.searchParams.get("q") ||
    url.searchParams.get("query") ||
    "";

  if (request.method === "POST") {
    try {
      const body = await request.json();

      action = body.action || action;

      query =
        body.query ||
        body.q ||
        query;

      const id = body.id || body.prk;

      if (id && !url.searchParams.has("id")) {
        url.searchParams.set("id", String(id));
      }

      if (body.page != null) {
        url.searchParams.set("page", String(body.page));
      }

      if (body.limit != null) {
        url.searchParams.set("limit", String(body.limit));
      }

    } catch {
      return {
        error: "ساختار JSON درخواست معتبر نیست.",
        status: 400
      };
    }
  }

  if (query && !url.searchParams.has("q")) {
    url.searchParams.set("q", query);
  }

  return {
    url,
    action: String(action || "search").toLowerCase()
  };
}

async function handle(request) {
  if (
    request.method !== "GET" &&
    request.method !== "POST"
  ) {
    return json({
      success: false,
      error: "متد درخواست پشتیبانی نمی‌شود."
    }, 405);
  }

  const input = await readRequest(request);

  if (input.error) {
    return json({
      success: false,
      error: input.error
    }, input.status);
  }

  try {
    let result;

    switch (input.action) {

      case "search":
      case "products":
        result = await searchProducts(input.url);
        break;

      case "suggest":
      case "suggestions":
        result = await getSuggestions(input.url);
        break;

      case "details":
      case "detail":
        result = await getProductDetails(input.url);
        break;

      case "sellers":
      case "shops":
        result = await getSellers(input.url);
        break;

      case "price-chart":
      case "chart":
        result = await getPriceChart(input.url);
        break;

      case "offers":
      case "special-offers":
        result = await getSpecialOffers();
        break;

      default:
        return json({
          success: false,
          error: "عملیات درخواستی پشتیبانی نمی‌شود.",
          supported_actions: [
            "search",
            "suggest",
            "details",
            "sellers",
            "price-chart",
            "offers"
          ]
        }, 400);
    }

    const status = result.success ? 200 : 400;

    return json(result, status);

  } catch (error) {
    console.error("ANANAS_TOROB_ERROR", {
      message: error.message,
      code: error.code || "UNKNOWN"
    });

    return json({
      success: false,

      error: error.message ||
        "خطا در ارتباط با سرویس ترب.",

      code: error.code ||
        "TOROB_REQUEST_FAILED",

      products: [],
      sellers: [],
      chart: [],
      suggestions: [],
      offers: []

    }, error.status || 502);
  }
}

// ======================================================
// 12. CLOUDFLARE PAGES EXPORTS
// ======================================================

export async function onRequestGet({ request }) {
  return handle(request);
}

export async function onRequestPost({ request }) {
  return handle(request);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}
