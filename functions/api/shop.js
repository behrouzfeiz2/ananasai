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

async function handle({ request }) {
  if (request.method === "OPTIONS") return response({ success: true });
  if (!["GET", "POST"].includes(request.method)) return response({ success: false, error: "Method not allowed" }, 405);
  const u = new URL(request.url);
  let p = {
    action: (u.searchParams.get("action") || "search").toLowerCase(),
    q: u.searchParams.get("q") || u.searchParams.get("query") || "",
    limit: Math.min(CONFIG.MAX_LIMIT, Math.max(1, Number(u.searchParams.get("limit")) || CONFIG.DEFAULT_LIMIT)),
    refresh: ["1", "true", "yes"].includes((u.searchParams.get("refresh") || "").toLowerCase())
  };
  if (request.method === "POST") {
    try {
      const b = await request.json();
      p = { ...p, action: String(b.action || p.action).toLowerCase(), q: b.q || b.query || p.q,
        limit: Math.min(CONFIG.MAX_LIMIT, Math.max(1, Number(b.limit) || p.limit)), refresh: Boolean(b.refresh || p.refresh) };
    } catch {}
  }
  if (p.action === "sources") return response({ success: true, sources: CONFIG.SOURCES });
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
