// ======================================================
// ANANAS AI - TOROB SIMPLE PRODUCT SEARCH
// Cloudflare Pages Function: /api/shop
//
// GET  /api/shop?q=گوشی+سامسونگ
// POST /api/shop  { "query": "گوشی سامسونگ" }
//
// Returns up to 10 Torob product search results.
// No price comparison, special-offer feed, or buying advice.
// ======================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

const TOROB_API = "https://api.torob.com/v4/base-product/search/";
const TOROB_SITE = "https://torob.com";
const MAX_QUERY_LENGTH = 120;
const RESULT_LIMIT = 10;
const CACHE_TTL = 300;
const REQUEST_TIMEOUT = 15000;

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
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

function safeHttpsUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(value, maxLength = 200) {
  if (typeof value !== "string") return null;

  const text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return text ? text.slice(0, maxLength) : null;
}

function mapProduct(item) {
  const id = cleanText(item.random_key || item.prk || "", 160);
  if (!id) return null;

  const numericPrice =
    typeof item.price === "number" &&
    Number.isFinite(item.price) &&
    item.price > 0
      ? Math.round(item.price)
      : null;

  const image = safeHttpsUrl(item.image_url);

  return {
    id,
    name: cleanText(item.name1, 200) || "محصول بدون عنوان",
    price: numericPrice,
    currency: numericPrice === null ? null : "تومان",
    image,
    url: `${TOROB_SITE}/p/${encodeURIComponent(id)}/`
  };
}

async function readQuery(request) {
  const url = new URL(request.url);

  if (request.method === "GET") {
    return normalizeQuery(
      url.searchParams.get("q") ||
      url.searchParams.get("query") ||
      ""
    );
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      return normalizeQuery(body.query || body.q || "");
    } catch {
      return "";
    }
  }

  return "";
}

async function fetchTorob(query, cacheKey) {
  // Cache API is available in Cloudflare Pages runtime.
  // If unavailable, the request still proceeds normally.
  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cached = await caches.default.match(cacheKey);

      if (cached) {
        const cachedBody = await cached.json();
        return { ...cachedBody, cached: true };
      }
    }
  } catch (error) {
    console.warn("TOROB_CACHE_READ_ERROR", error.message);
  }

  const apiUrl = new URL(TOROB_API);

  apiUrl.searchParams.set("q", query);
  apiUrl.searchParams.set("query", query);
  apiUrl.searchParams.set("page", "0");
  apiUrl.searchParams.set("size", String(RESULT_LIMIT));
  apiUrl.searchParams.set("source", "next_desktop");

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT
  );

  let response;

  try {
    response = await fetch(apiUrl.toString(), {
      method: "GET",

      headers: {
        "Accept": "application/json",
        "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
        "Origin": TOROB_SITE,
        "Referer": `${TOROB_SITE}/`,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site"
      },

      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 490) {
    const error = new Error(
      "ترب درخواست سرور را به دلیل محدودیت امنیتی یا کپچا نپذیرفت."
    );

    error.status = 503;
    error.code = "TOROB_BLOCKED";

    throw error;
  }

  if (response.status === 403 || response.status === 429) {
    const error = new Error(
      "دسترسی به جست‌وجوی ترب موقتاً محدود شده است."
    );

    error.status = 503;
    error.code = "TOROB_RATE_LIMIT";

    throw error;
  }

  if (!response.ok) {
    const error = new Error(
      `Torob returned HTTP ${response.status}`
    );

    error.status = 502;
    error.code = "TOROB_UPSTREAM_ERROR";

    throw error;
  }

  const contentType =
    response.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    const error = new Error(
      "پاسخ دریافتی از ترب JSON معتبر نیست."
    );

    error.status = 502;
    error.code = "TOROB_INVALID_RESPONSE";

    throw error;
  }

  const raw = await response.json();

  const rows = Array.isArray(raw.results)
    ? raw.results
    : [];

  const products = rows
    .map(mapProduct)
    .filter(Boolean)
    .slice(0, RESULT_LIMIT);

  const result = {
    success: true,
    query,
    total: Number.isFinite(Number(raw.count))
      ? Number(raw.count)
      : products.length,
    count: products.length,
    products,
    source: "Torob",
    cached: false
  };

  try {
    if (typeof caches !== "undefined" && caches.default) {
      const cacheResponse = new Response(
        JSON.stringify(result),
        {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": `public, max-age=${CACHE_TTL}`
          }
        }
      );

      await caches.default.put(cacheKey, cacheResponse);
    }
  } catch (error) {
    console.warn("TOROB_CACHE_WRITE_ERROR", error.message);
  }

  return result;
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

  const query = await readQuery(request);

  if (!query || query.length < 2) {
    return json({
      success: false,
      error: "عبارت جست‌وجو باید حداقل ۲ نویسه باشد."
    }, 400);
  }

  const cacheUrl = new URL(request.url);

  cacheUrl.search = "";
  cacheUrl.searchParams.set("q", query);
  cacheUrl.searchParams.set("limit", String(RESULT_LIMIT));

  const cacheKey = new Request(
    cacheUrl.toString(),
    { method: "GET" }
  );

  try {
    const result = await fetchTorob(query, cacheKey);

    return json(result, 200, {
      "Cache-Control": `public, max-age=${CACHE_TTL}`
    });

  } catch (error) {
    console.error("ANANAS_TOROB_SEARCH_ERROR", {
      message: error.message,
      code: error.code || "UNKNOWN"
    });

    return json({
      success: false,
      query,
      error: error.message || "خطا در ارتباط با ترب.",
      code: error.code || "TOROB_SEARCH_FAILED",
      products: []
    }, error.status || 502);
  }
}

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
