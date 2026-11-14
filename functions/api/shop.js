/**
 * Ananas AI - RSS Shopping & Product Discovery
 * Cloudflare Pages Function: functions/api/shop.js
 * Compatible: GET /api/shop?q=iphone&limit=10
 * Diagnostics: GET /api/shop?action=sources | /api/shop?action=health
 *
 * RSS entries are discovery/editorial data, NOT guaranteed live offers.
 * Prices are extracted only when explicitly written in feed text.
 */

const CONFIG = {
  CACHE_TTL_SECONDS: 900,
  FEED_TIMEOUT_MS: 10000,
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 30,
  MAX_ITEMS_PER_FEED: 80,
  USER_AGENT: "AnanasAI-ShopFeed/1.0 (+https://ananasai.ir)",
  SOURCES: [
    {
      id: "mobo", name: "موبونیوز", type: "mobile_review", enabled: true,
      feeds: ["https://mobo.news/feed/", "https://mobo.news/feed"],
      topics: ["mobile", "smartphone", "review", "buying-guide"], trust: "editorial"
    },
    {
      id: "technolife", name: "تکنولایف", type: "store_blog", enabled: true,
      feeds: ["https://www.technolife.com/blog/feed/", "https://www.technolife.com/blog/feed"],
      topics: ["mobile", "laptop", "digital-goods", "buying-guide"], trust: "retailer-editorial"
    },
    {
      id: "binoshop", name: "بینوشاپ", type: "store_feed", enabled: true,
      feeds: ["https://shop.binosha.com/feed/", "https://shop.binosha.com/feed"],
      topics: ["digital-goods", "mobile", "accessories"], trust: "retailer"
    },
    {
      id: "zoomit", name: "زومیت", type: "technology_media", enabled: true,
      feeds: ["https://www.zoomit.ir/feed/", "https://www.zoomit.ir/feed"],
      topics: ["mobile", "laptop", "technology", "buying-guide"], trust: "editorial"
    }
  ]
};

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", zwnj: "\u200c" };

function decodeEntities(v = "") {
  return String(v)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16); return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&#([0-9]+);/g, (_, d) => {
      const n = parseInt(d, 10); return Number.isFinite(n) ? String.fromCodePoint(n) : _;
    })
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function tag(block, names) {
  for (const name of names) {
    const re = new RegExp(`<(?:(?:[\\w.-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[\\w.-]+):)?${name}\\s*>`, "i");
    const m = block.match(re);
    if (m) return decodeEntities(m[1]);
  }
  return "";
}

function attr(block, tags, attrs) {
  for (const name of tags) {
    const m = block.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, "i"));
    if (!m) continue;
    for (const a of attrs) {
      const found = m[1].match(new RegExp(`(?:^|\\s)${a}\\s*=\\s*["']([^"']+)["']`, "i"));
      if (found) return decodeEntities(found[1]);
    }
  }
  return "";
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function safeUrl(value) {
  if (!value) return null;
  try { const u = new URL(value); return ["http:", "https:"].includes(u.protocol) ? u.toString() : null; }
  catch { return null; }
}

function dateValue(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

function englishDigits(v) {
  const fa = "۰۱۲۳۴۵۶۷۸۹", ar = "٠١٢٣٤٥٦٧٨٩";
  return String(v).replace(/[۰-۹٠-٩]/g, d => {
    const i = fa.indexOf(d); return String(i >= 0 ? i : ar.indexOf(d));
  });
}

function priceFrom(text) {
  const s = englishDigits(text)
    .replace(/[٬,]/g, "")
    .replace(/٫/g, ".");

  // فقط قیمت‌هایی که واحد پول مشخص دارند
  const patterns = [
    /(\d{1,3}(?:\.\d+)?(?:\s*(?:هزار|میلیون|میلیارد))?)\s*(تومان|تومن|ریال)/i,
    /(?:قیمت|حدود قیمت|قیمت حدودی|به قیمت)[^\d]{0,30}(\d{1,3}(?:\.\d+)?(?:\s*(?:هزار|میلیون|میلیارد))?)\s*(تومان|تومن|ریال)/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;

    const raw = m[1];
    const unit = m[2];

    let value = Number(raw.replace(/[^\d.]/g, ""));

    if (!Number.isFinite(value)) continue;

    if (/میلیارد/.test(raw)) value *= 1000000000;
    else if (/میلیون/.test(raw)) value *= 1000000;
    else if (/هزار/.test(raw)) value *= 1000;

    return {
      value: Math.round(value),
      text: m[0].trim(),
      currency: /ریال/.test(unit) ? "IRR" : "IRT"
    };
  }

  return {
    value: null,
    text: null,
    currency: "IRT"
  };
}

function itemType(title, desc, price) {
  const t = `${title} ${desc}`;
  if (/(راهنمای خرید|بهترین گوشی|بهترین لپ.?تاپ|مقایسه|بررسی تخصصی)/i.test(t)) return "buying_guide";
  if (price !== null) return "price_mention";
  if (/(گوشی|موبایل|آیفون|سامسونگ|شیائومی|پوکو|لپ.?تاپ|تبلت|هدفون|ساعت هوشمند)/i.test(t)) return "product_article";
  return "article";
}

function parseFeed(xml, source) {
  const entries = xml.match(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)\s*>/gi) || [];
  return entries.slice(0, CONFIG.MAX_ITEMS_PER_FEED).map(block => {
    const title = tag(block, ["title"]);
    const description = tag(block, ["description", "summary", "content:encoded", "content"]);
    const link = tag(block, ["link"]) || attr(block, ["link"], ["href"]);
    const guid = tag(block, ["guid", "id"]);
    const image = attr(block, ["media:content", "media:thumbnail", "enclosure"], ["url"]);
    const published = tag(block, ["pubDate", "published", "updated", "date"]);
    const author = tag(block, ["creator", "author"]);
    const price = priceFrom(`${title} ${description}`);
    return {
      id: hash(`${source.id}|${guid || link || title}`),
      source: source.id, source_name: source.name, source_type: source.type,
      type: itemType(title, description, price.value),
      name: title || "مطلب بدون عنوان", title: title || "مطلب بدون عنوان",
      description: description.slice(0, 1800),
      price: price.value, price_text: price.text, currency: price.currency,
      price_is_current: false, image: safeUrl(image), url: safeUrl(link || guid),
      published_at: dateValue(published), author,
      topics: source.topics, trust: source.trust
    };
  }).filter(x => x.title && x.url);
}

function normalize(v) {
  return englishDigits(String(v || "")).replace(/[يى]/g, "ی").replace(/ك/g, "ک")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function score(item, query) {
  if (!query) return 1;
  const q = normalize(query);
  const hay = normalize(`${item.title} ${item.description}`);
  let n = hay.includes(q) ? 10 : 0;
  for (const word of q.split(/\s+/).filter(Boolean)) if (hay.includes(word)) n += word.length > 3 ? 3 : 1;
  if (item.type === "price_mention") n += 1;
  return n;
}

async function fetchTimed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.FEED_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*", "User-Agent": CONFIG.USER_AGENT },
      signal: controller.signal, redirect: "follow"
    });
  } finally { clearTimeout(timer); }
}

async function fetchSource(source) {
  const errors = [];
  for (const feed of source.feeds) {
    try {
      const res = await fetchTimed(feed);
      if (!res.ok) { errors.push(`${res.status}: ${feed}`); continue; }
      const xml = await res.text();
      if (!/<(?:rss|feed|rdf:RDF|item|entry)\b/i.test(xml.slice(0, 12000))) {
        errors.push(`پاسخ XML/RSS معتبر نبود: ${feed}`); continue;
      }
      const items = parseFeed(xml, source);
      return { source: source.id, ok: true, count: items.length, feed, items };
    } catch (e) {
      errors.push(`${feed}: ${e?.name === "AbortError" ? "timeout" : String(e?.message || e)}`);
    }
  }
  return { source: source.id, ok: false, count: 0, errors, items: [] };
}

async function loadFeeds(request, refresh = false) {
  const cache = caches.default;
  const key = new Request(new URL("/__ananas_shop_rss_cache_v1", request.url).toString());
  if (!refresh) {
    const hit = await cache.match(key);
    if (hit) {
      try { return { ...(await hit.json()), cached: true }; } catch {}
    }
  }
  const results = await Promise.all(CONFIG.SOURCES.filter(s => s.enabled).map(fetchSource));
  const data = {
    success: true, items: results.flatMap(r => r.items),
    source_status: results.map(({ source, ok, count, feed, errors }) => ({ source, ok, count, feed: feed || null, errors: errors || [] })),
    fetched_at: new Date().toISOString(), cached: false
  };
  await cache.put(key, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CONFIG.CACHE_TTL_SECONDS}` }
  }));
  return data;
}

function response(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  }});
}


const FASHION_CONFIG = {
  CACHE_TTL_SECONDS: 180,
  REQUEST_TIMEOUT_MS: 7000,
  DEFAULT_LIMIT: 9,
  MAX_LIMIT: 12,
  SOURCE_LIMIT: 8
};

const FASHION_SOURCES = [
  { id: "shopino", name: "شاپینو", type: "fashion_marketplace", enabled: true, official_api: false },
  { id: "banimode", name: "بانی‌مد", type: "fashion_retailer", enabled: true, official_api: false },
  { id: "basalam", name: "باسلام", type: "marketplace", enabled: true, official_api: false }
];

function fashionSafeHttps(value) {
  const url = safeUrl(value);
  return url && url.startsWith("https://") ? url : null;
}

function tomanFromRial(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 10) : null;
}

function firstImage(list) {
  if (!Array.isArray(list)) return null;
  for (const item of list) {
    const candidate = typeof item === "string"
      ? item
      : item?.url || item?.large || item?.original || item?.src || null;
    const safe = fashionSafeHttps(candidate);
    if (safe) return safe;
  }
  return null;
}

async function fetchFashionJson(url, origin, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FASHION_CONFIG.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.8",
        Origin: origin,
        Referer: referer,
        "User-Agent": "AnanasAI-FashionSearch/1.0 (+https://ananasai.ir)"
      },
      signal: controller.signal,
      redirect: "follow"
    });
    const raw = await res.text();
    if (!res.ok) {
      const error = new Error("HTTP " + res.status);
      error.status = res.status;
      throw error;
    }
    let data;
    try { data = JSON.parse(raw); }
    catch {
      const error = new Error("پاسخ منبع JSON معتبر نبود");
      error.status = res.status;
      throw error;
    }
    if (data && typeof data === "object" && data.status === "error") {
      throw new Error(String(data.message || "خطای منبع فروشگاه").slice(0, 160));
    }
    return data;
  } catch (error) {
    if (controller.signal.aborted) {
      const timeout = new Error("timeout");
      timeout.code = "TIMEOUT";
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fashionProductBase(item, source, fetchedAt) {
  return {
    id: String(item.id),
    source: source.id,
    source_name: source.name,
    title: String(item.title || "").trim().slice(0, 180),
    price: Number(item.price) > 0 ? Math.round(Number(item.price)) : null,
    original_price: Number(item.original_price) > 0 ? Math.round(Number(item.original_price)) : null,
    discount_pct: Number(item.discount_pct) > 0 ? Math.min(99, Math.round(Number(item.discount_pct))) : null,
    currency: "IRT",
    price_unit: "تومان",
    price_is_current: Number(item.price) > 0,
    in_stock: typeof item.in_stock === "boolean" ? item.in_stock : null,
    image: fashionSafeHttps(item.image),
    product_url: fashionSafeHttps(item.product_url),
    seller_url: fashionSafeHttps(item.seller_url),
    seller_name: String(item.seller_name || "").trim().slice(0, 100) || null,
    seller_rating: Number(item.seller_rating) > 0 ? Number(item.seller_rating) : null,
    seller_rating_count: Number(item.seller_rating_count) > 0 ? Number(item.seller_rating_count) : null,
    sizes: Array.isArray(item.sizes) ? item.sizes.filter(Boolean).map(x => String(x).slice(0, 24)).slice(0, 12) : [],
    color: item.color ? String(item.color).slice(0, 40) : null,
    fetched_at: fetchedAt
  };
}

async function searchShopinoFashion(query, fetchedAt, maxPrice) {
  const source = FASHION_SOURCES[0];
  const url = new URL("https://api-go.shopino.app/api/v1/app/products/search/" + encodeURIComponent(query) + "/");
  url.searchParams.set("page_size", String(FASHION_CONFIG.SOURCE_LIMIT));
  url.searchParams.set("in_stock", "true");
  if (maxPrice) url.searchParams.set("price_to", String(maxPrice));
  const body = await fetchFashionJson(url.toString(), "https://shopino.app", "https://shopino.app/");
  const rows = Array.isArray(body?.results) ? body.results : Array.isArray(body?.data?.results) ? body.data.results : [];
  const products = rows.map(p => {
    const shop = p.shop || {};
    const finalPrice = Number(p.discounted_price) > 0 ? Number(p.discounted_price) : Number(p.price);
    const oldPrice = Number(p.discounted_price) > 0 && Number(p.price) > Number(p.discounted_price) ? Number(p.price) : null;
    const media = (p.medias || []).find(m => m?.url && !m?.is_video);
    return fashionProductBase({
      id: p.id,
      title: p.title,
      price: finalPrice,
      original_price: oldPrice,
      discount_pct: oldPrice && finalPrice ? Math.round((1 - finalPrice / oldPrice) * 100) : null,
      in_stock: typeof p.in_stock === "boolean" ? p.in_stock : null,
      image: media?.url,
      product_url: "https://shopino.app/product/" + encodeURIComponent(p.id),
      seller_url: p.website_url,
      seller_name: shop.title,
      seller_rating: shop.rating,
      seller_rating_count: shop.surveys_count
    }, source, fetchedAt);
  }).filter(p => p.title && p.product_url && p.price && p.in_stock !== false);
  return { source: source.id, ok: true, count: products.length, products };
}

async function searchBanimodeFashion(query, fetchedAt, maxPrice) {
  const source = FASHION_SOURCES[1];
  const url = new URL("https://mobapi.banimode.com/api/v4/products/");
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", String(FASHION_CONFIG.SOURCE_LIMIT));
  url.searchParams.set("q", query);
  url.searchParams.set("filter[total_qty][gt]", "0");
  if (maxPrice) url.searchParams.set("filter[product_final_price][lte]", String(maxPrice * 10));
  const body = await fetchFashionJson(url.toString(), "https://www.banimode.com", "https://www.banimode.com/");
  const rows = body?.data?.data || body?.data?.products || body?.products || [];
  const products = (Array.isArray(rows) ? rows : []).map(p => {
    const finalPrice = tomanFromRial(p.product_final_price);
    const basePrice = tomanFromRial(p.product_base_price || p.product_price);
    const discount = basePrice && finalPrice && basePrice > finalPrice
      ? Math.round((1 - finalPrice / basePrice) * 100) : null;
    const sizes = Array.isArray(p.size) ? p.size.filter(s => s?.has_quantity).map(s => s.name) : [];
    const images = p.images?.large_default || p.images?.large || [];
    return fashionProductBase({
      id: p.id_product,
      title: p.product_name,
      price: finalPrice || basePrice,
      original_price: discount ? basePrice : null,
      discount_pct: discount,
      in_stock: Number(p.total_qty) > 0,
      image: firstImage(images),
      product_url: "https://www.banimode.com/BM-" + encodeURIComponent(p.id_product),
      seller_name: p.product_manufacturer_name || "بانی‌مد",
      sizes,
      color: p.color_name
    }, source, fetchedAt);
  }).filter(p => p.title && p.product_url && p.price && p.in_stock !== false);
  return { source: source.id, ok: true, count: products.length, products };
}

async function searchBasalamFashion(query, fetchedAt, maxPrice) {
  const source = FASHION_SOURCES[2];
  const url = new URL("https://services.basalam.com/web/v1/search/product/search");
  url.searchParams.set("q", query);
  url.searchParams.set("sort", "rank");
  url.searchParams.set("from", "0");
  url.searchParams.set("size", String(FASHION_CONFIG.SOURCE_LIMIT));
  if (maxPrice) url.searchParams.set("filters.maxPrice", String(maxPrice * 10));
  const body = await fetchFashionJson(url.toString(), "https://basalam.com", "https://basalam.com/");
  const rows = Array.isArray(body?.products) ? body.products : [];
  const products = rows.map(p => {
    const price = tomanFromRial(p.price);
    const oldPrice = p.primaryPrice && p.price && Number(p.primaryPrice) > Number(p.price)
      ? tomanFromRial(p.primaryPrice) : null;
    const photos = Array.isArray(p.photos) ? p.photos : [];
    return fashionProductBase({
      id: p.id,
      title: p.name,
      price,
      original_price: oldPrice,
      discount_pct: oldPrice && price ? Math.round((1 - price / oldPrice) * 100) : null,
      in_stock: typeof p.IsAvailable === "boolean" ? p.IsAvailable : (Number(p.stock) > 0 ? true : null),
      image: firstImage(photos),
      product_url: "https://basalam.com/p/" + encodeURIComponent(p.id),
      seller_name: p.vendor?.name,
      seller_rating: p.rating?.average,
      seller_rating_count: p.rating?.count,
      color: p.mainAttribute
    }, source, fetchedAt);
  }).filter(p => p.title && p.product_url && p.price && p.in_stock !== false);
  return { source: source.id, ok: true, count: products.length, products };
}

function fashionSearchLinks(query) {
  const q = encodeURIComponent(query);
  return [
    { id: "digikala", name: "جست‌وجو در دیجی‌کالا", url: "https://www.digikala.com/search/?q=" + q, type: "search" },
    { id: "basalam", name: "جست‌وجو در باسلام", url: "https://basalam.com/s?q=" + q, type: "search" },
    { id: "modiseh", name: "ورود به فروشگاه مودیسه", url: "https://www.modiseh.com/", type: "store" },
    { id: "banimode", name: "ورود به فروشگاه بانی‌مد", url: "https://www.banimode.com/", type: "store" }
  ];
}

function fashionErrorLabel(error) {
  if (error?.code === "TIMEOUT" || error?.name === "AbortError") return "پاسخ منبع در زمان مقرر دریافت نشد";
  if (error?.status === 403 || error?.status === 429) return "دسترسی منبع محدود شد (HTTP " + error.status + ")";
  if (error?.status >= 500) return "اختلال موقت منبع (HTTP " + error.status + ")";
  return "پاسخ معتبر از منبع دریافت نشد";
}

async function loadFashionProducts(request, query, limit, refresh = false, maxPrice = null) {
  const normalizedQuery = String(query || "").trim().slice(0, 120);
  if (normalizedQuery.length < 2) {
    return { success: false, query: normalizedQuery, products: [], count: 0, error: "عبارت جست‌وجو باید دست‌کم دو نویسه باشد." };
  }
  const cache = caches.default;
  const cacheUrl = new URL("/__ananas_fashion_search_v1", request.url);
  cacheUrl.searchParams.set("q", normalizedQuery);
  cacheUrl.searchParams.set("limit", String(limit));
  if (maxPrice) cacheUrl.searchParams.set("max_price", String(maxPrice));
  const cacheKey = new Request(cacheUrl.toString());
  if (!refresh) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      try { return { ...(await cached.json()), cached: true }; } catch {}
    }
  }

  const fetchedAt = new Date().toISOString();
  const adapters = [
    ["shopino", () => searchShopinoFashion(normalizedQuery, fetchedAt, maxPrice)],
    ["banimode", () => searchBanimodeFashion(normalizedQuery, fetchedAt, maxPrice)],
    ["basalam", () => searchBasalamFashion(normalizedQuery, fetchedAt, maxPrice)]
  ];
  const settled = await Promise.all(adapters.map(async ([id, run]) => {
    try { return await run(); }
    catch (error) { return { source: id, ok: false, count: 0, products: [], error: fashionErrorLabel(error) }; }
  }));
  const successful = settled.filter(x => x.ok);
  const lists = successful.map(x => (x.products || []).filter(p => !maxPrice || (Number(p.price) > 0 && Number(p.price) <= maxPrice)));
  const products = [];
  const seen = new Set();
  const maxRows = Math.max(...lists.map(x => x.length), 0);
  for (let i = 0; i < maxRows && products.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item || products.length >= limit) continue;
      const key = normalize(item.title + "|" + (item.seller_name || item.source_name));
      if (seen.has(key)) continue;
      seen.add(key);
      products.push(item);
    }
  }

  const data = {
    success: true,
    available: successful.length > 0,
    query: normalizedQuery,
    max_price: maxPrice || null,
    count: products.length,
    products,
    source_status: settled.map(({ source, ok, count, error }) => ({
      source, name: FASHION_SOURCES.find(s => s.id === source)?.name || source,
      ok, count, error: error || null
    })),
    store_links: fashionSearchLinks(normalizedQuery),
    fetched_at: fetchedAt,
    cached: false,
    note: "قیمت و موجودی بر اساس آخرین پاسخ منبع در زمان جست‌وجو هستند؛ پیش از خرید در صفحه فروشنده دوباره بررسی شوند."
  };

  await cache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=" + FASHION_CONFIG.CACHE_TTL_SECONDS }
  }));
  return data;
}

async function handle({ request }) {
  if (request.method === "OPTIONS") return response({ success: true });
  if (!["GET", "POST"].includes(request.method)) return response({ success: false, error: "Method not allowed" }, 405);
  const u = new URL(request.url);
  let p = {
    action: (u.searchParams.get("action") || "search").toLowerCase(),
    q: u.searchParams.get("q") || u.searchParams.get("query") || "",
    limit: Math.min(CONFIG.MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || CONFIG.DEFAULT_LIMIT)),
    refresh: ["1", "true", "yes"].includes((u.searchParams.get("refresh") || "").toLowerCase()),
    maxPrice: Number(u.searchParams.get("max_price")) > 0 ? Math.min(100000000, Number(u.searchParams.get("max_price"))) : null
  };
  if (request.method === "POST") {
    try {
      const b = await request.json();
      p = { ...p, action: String(b.action || p.action).toLowerCase(), q: b.q || b.query || p.q,
        limit: Math.min(CONFIG.MAX_LIMIT, Math.max(1, Number(b.limit) || p.limit)), refresh: Boolean(b.refresh || p.refresh), maxPrice: Number(b.max_price) > 0 ? Math.min(100000000, Number(b.max_price)) : p.maxPrice };
    } catch {}
  }
  if (p.action === "sources") return response({ success: true, sources: CONFIG.SOURCES, fashion_sources: FASHION_SOURCES });
  if (["product_search", "fashion_search", "products"].includes(p.action)) {
    const data = await loadFashionProducts(request, p.q, Math.min(FASHION_CONFIG.MAX_LIMIT, Math.max(1, p.limit || FASHION_CONFIG.DEFAULT_LIMIT)), p.refresh, p.maxPrice);
    return response(data, data.success ? 200 : 400);
  }
  const data = await loadFeeds(request, p.refresh);
  if (p.action === "health") return response({
    success: true, fetched_at: data.fetched_at, cached: data.cached,
    source_status: data.source_status, total_items: data.items.length
  });
  const products = data.items.map(x => ({ ...x, _score: score(x, p.q) }))
    .filter(x => !p.q || x._score > 0)
    .sort((a, b) => b._score - a._score || String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, p.limit).map(({ _score, ...x }) => x);
  return response({
    success: true, query: p.q, count: products.length, total: data.items.length,
    products, items: products, source_status: data.source_status,
    fetched_at: data.fetched_at, cached: data.cached,
    note: "RSS ممکن است به معرفی محصول یا قیمت اشاره کند؛ قیمت و موجودی زنده را تضمین نمی‌کند."
  });
}

export async function onRequestGet(context) {
  try { return await handle(context); }
  catch (e) { return response({ success: false, error: "خطا در دریافت فیدهای فروشگاهی", details: String(e?.message || e), products: [], items: [] }, 500); }
}
export async function onRequestPost(context) {
  try { return await handle(context); }
  catch (e) { return response({ success: false, error: "خطا در دریافت فیدهای فروشگاهی", details: String(e?.message || e), products: [], items: [] }, 500); }
}
export async function onRequestOptions() { return response({ success: true }); }
