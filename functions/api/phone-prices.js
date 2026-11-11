/**
 * AnanasAI - Digiato phone price lookup
 * GET /api/phone-prices?model=galaxy-a57
 *
 * Reads Digiato public product pages. Prices are never fabricated:
 * products without a listed price are returned with an explicit status.
 */
const SOURCE_ORIGIN = "https://digiato.com";
const CACHE_TTL_SECONDS = 300;
const FETCH_TIMEOUT_MS = 12000;

const TEST_MODELS = [
  {
    id: "galaxy-a57",
    name: "Samsung Galaxy A57",
    aliases: ["galaxy a57", "samsung galaxy a57", "سامسونگ گلکسی a57", "گلکسی a57"],
    path: "/products/mobile/Galaxy-A57"
  },
  {
    id: "redmi-note-14-4g",
    name: "Xiaomi Redmi Note 14 4G",
    aliases: ["redmi note 14", "redmi note 14 4g", "xiaomi redmi note 14", "ردمی نوت ۱۴", "شیائومی ردمی نوت ۱۴"],
    path: "/products/mobile/Xiaomi-Redmi-Note-14"
  },
  {
    id: "iphone-16",
    name: "Apple iPhone 16",
    aliases: ["iphone 16", "apple iphone 16", "آیفون ۱۶", "آیفون 16"],
    path: "/products/mobile/iphone-16"
  }
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS_HEADERS });
}

function normalizeDigits(value) {
  const fa = "۰۱۲۳۴۵۶۷۸۹";
  const ar = "٠١٢٣٤٥٦٧٨٩";
  return String(value || "").replace(/[۰-۹٠-٩]/g, d => {
    const i = fa.indexOf(d);
    return String(i >= 0 ? i : ar.indexOf(d));
  });
}

function normalizeText(value) {
  return normalizeDigits(value).toLowerCase()
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/[^\p{L}\p{N}\s.-]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; }
    });
}

function htmlToText(html) {
  return decodeHtml(String(html || "")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/td|\/hgroup)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "\n").replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
}

function parseMoney(value) {
  const amount = Number(normalizeDigits(value).replace(/[٬,.\s]/g, ""));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function getPurchaseLinks(html) {
  const links = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    if (!/خرید\s*محصول/i.test(htmlToText(match[2]))) continue;
    const hrefMatch = match[1].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    try {
      const url = new URL(decodeHtml(hrefMatch[1]), SOURCE_ORIGIN);
      if (url.protocol === "https:" && !links.includes(url.toString())) links.push(url.toString());
    } catch {}
  }
  return links;
}

function extractOffers(text, html) {
  const sections = text.split(/فروشگاه آنلاین\s*/i).slice(1);
  const purchaseLinks = getPurchaseLinks(html);
  const offers = [];
  let linkIndex = 0;

  for (const section of sections) {
    const lines = section.split("\n").map(x => x.trim()).filter(Boolean);
    const sellerName = (lines[0] || "").replace(/[：:]$/, "").trim();
    if (!sellerName) continue;

    const boundary = section.search(/(?:فروشگاهی با این مشخصات یافت نشد|تغییرات قیمت|معرفی تخصصی)/i);
    const sellerText = boundary >= 0 ? section.slice(0, boundary) : section;
    const priceRe = /([\d۰-۹٠-٩][\d۰-۹٠-٩٬,]{3,})\s*تومان/g;
    let match;

    while ((match = priceRe.exec(sellerText)) !== null) {
      const price = parseMoney(match[1]);
      if (!price) continue;
      const before = sellerText.slice(0, match.index).split("\n").map(x => x.trim()).filter(Boolean);
      const context = before.slice(-4).filter(line =>
        !/^(فروشگاه|فروشگاه آنلاین|توضیحات|خرید محصول)$/i.test(line)
      );
      offers.push({
        seller: sellerName,
        variant: context.slice(-3).join(" ").slice(0, 240) || null,
        price,
        currency: "IRT",
        purchase_url: purchaseLinks[linkIndex] || null
      });
      linkIndex++;
    }
  }

  const seen = new Set();
  return offers.filter(offer => {
    const key = offer.seller + "|" + offer.price + "|" + (offer.variant || "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.price - b.price);
}

function extractProduct(html, model) {
  const text = htmlToText(html);
  const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch ? htmlToText(titleMatch[1]) : model.name;
  const startingMatch = text.match(/شروع قیمت از\s*([\d۰-۹٠-٩٬,.]+)\s*تومان/i);
  const startingPrice = startingMatch ? parseMoney(startingMatch[1]) : null;
  const offers = extractOffers(text, html);
  const lowestOffer = offers.length ? offers[0].price : null;
  const lowestPrice = lowestOffer || startingPrice;

  let status = "available";
  let message = "قیمت و پیشنهاد فروشندگان از صفحه محصول دیجیاتو استخراج شد.";
  if (!offers.length && !startingPrice) {
    status = "no_listed_price";
    message = "در صفحه دیجیاتو برای این محصول فروشنده یا قیمت فعالی ثبت نشده است.";
  } else if (!offers.length) {
    status = "starting_price_only";
    message = "قیمت شروع در صفحه محصول درج شده، اما پیشنهاد فروشنده‌ای برای استخراج در دسترس نبود.";
  } else if (!offers.some(offer => offer.purchase_url)) {
    message = "قیمت فروشندگان استخراج شد؛ لینک خرید مستقیم در خروجی صفحه قابل تشخیص نبود.";
  }

  return {
    id: model.id,
    name: title || model.name,
    status,
    message,
    starting_price: startingPrice,
    lowest_price: lowestPrice,
    currency: "IRT",
    offers,
    seller_count: new Set(offers.map(x => x.seller)).size,
    source: "Digiato",
    source_url: SOURCE_ORIGIN + model.path,
    checked_at: new Date().toISOString(),
    price_history_available: false
  };
}

function resolveModel(query) {
  const q = normalizeText(query);
  return TEST_MODELS.find(model =>
    model.id === q || normalizeText(model.name) === q ||
    model.aliases.some(alias => normalizeText(alias) === q)
  ) || null;
}

async function fetchProduct(model, request, refresh) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__ananas_digiato_price_v1/" + model.id, request.url).toString());

  if (!refresh) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return { ...(await cached.json()), cached: true };
    } catch {}
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(SOURCE_ORIGIN + model.path, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnanasAI-PriceLookup/1.0; +https://ananasai.ir/)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.7",
        "Referer": SOURCE_ORIGIN + "/products/search"
      },
      redirect: "follow",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error("Digiato returned HTTP " + response.status);
  const html = await response.text();
  if (!/<h1\b/i.test(html)) throw new Error("ساختار صفحه محصول دیجیاتو قابل شناسایی نیست.");

  const product = extractProduct(html, model);
  try {
    await cache.put(cacheKey, new Response(JSON.stringify(product), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + CACHE_TTL_SECONDS }
    }));
  } catch {}
  return { ...product, cached: false };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get("model") || url.searchParams.get("q") || "").trim();
  const refresh = ["1", "true", "yes"].includes((url.searchParams.get("refresh") || "").toLowerCase());

  if (!query || query.toLowerCase() === "models") {
    return json({
      success: true,
      source: "Digiato",
      models: TEST_MODELS.map(({ id, name, path }) => ({ id, name, source_url: SOURCE_ORIGIN + path })),
      usage: "/api/phone-prices?model=galaxy-a57"
    });
  }

  if (query.toLowerCase() === "all") {
    const results = await Promise.all(TEST_MODELS.map(async model => {
      try { return await fetchProduct(model, context.request, refresh); }
      catch (error) {
        return { id: model.id, name: model.name, status: "source_error", error: String(error.message || error) };
      }
    }));
    return json({ success: true, source: "Digiato", checked_at: new Date().toISOString(), products: results });
  }

  const model = resolveModel(query);
  if (!model) {
    return json({
      success: false,
      error: "این مدل در فهرست آزمایشی فعلی نیست.",
      available_models: TEST_MODELS.map(({ id, name }) => ({ id, name }))
    }, 404);
  }

  try {
    const product = await fetchProduct(model, context.request, refresh);
    return json({ success: true, product });
  } catch (error) {
    return json({
      success: false,
      source: "Digiato",
      model: model.name,
      error: "دریافت قیمت از دیجیاتو در حال حاضر ممکن نشد.",
      details: String(error?.message || error),
      source_url: SOURCE_ORIGIN + model.path
    }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
