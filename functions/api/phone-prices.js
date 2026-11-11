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


function normalizePhoneModel(value) {
  return normalizeText(value)
    .replace(/گالاکسی|گلکسی/g, "galaxy").replace(/سامسونگ/g, "samsung")
    .replace(/شیائومی/g, "xiaomi").replace(/ردمی/g, "redmi").replace(/پوکو/g, "poco")
    .replace(/آیفون|ایفون/g, "iphone").replace(/اولترا/g, "ultra")
    .replace(/پرو/g, "pro").replace(/مکس/g, "max").replace(/پلاس/g, "plus")
    .replace(/فولد/g, "fold").replace(/فلیپ/g, "flip").replace(/نوت/g, "note")
    .replace(/ایر/g, "air").replace(/اس/g, "s").replace(/ای/g, "a")
    .replace(/\s+/g, " ").trim();
}
function slugTitle(value) {
  return value.split(" ").filter(Boolean).map(part =>
    /^\d+[a-z]*$/i.test(part) ? part.toUpperCase() :
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join("-");
}
function buildPhoneModel(query) {
  const normalized = normalizePhoneModel(query);
  const tokens = normalized.split(" ").filter(Boolean);
  const brandIndex = tokens.findIndex(x => ["samsung","galaxy","xiaomi","redmi","poco","iphone"].includes(x));
  if (brandIndex < 0) return null;
  const stop = new Set(["price","specs","specification","phone","mobile","قیمت","گوشی","موبایل","چنده","چقدر","چیست","مشخصات","سخت","افزار","پردازنده","رم","حافظه","دوربین","باتری","بخرم","مقایسه"]);
  let selected = tokens.slice(brandIndex, brandIndex + 6);
  selected = selected.filter((x, i) => !(i > 1 && stop.has(x)));
  if (selected.length < 2) return null;
  let name = selected.join(" ");
  if (selected[0] === "galaxy") name = "samsung " + name;
  if (selected[0] === "redmi" || selected[0] === "poco") name = "xiaomi " + name;
  if (!/^(samsung|galaxy|xiaomi|redmi|poco|iphone)\b/.test(name)) return null;
  const id = name.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").toLowerCase();
  const variants = [selected];
  if (selected[0] === "samsung" && selected[1] === "galaxy") variants.push(selected.slice(1));
  if (selected[0] === "xiaomi" && selected.length > 1) variants.push(selected.slice(1));
  const paths = [];
  for (const variant of variants) {
    const slug = slugTitle(variant.join(" "));
    paths.push("/products/mobile/" + slug, "/products/mobile/" + slug.toLowerCase());
  }
  return { id, name: name.replace(/\b\w/g, c => c.toUpperCase()), query, paths: [...new Set(paths)] };
}
async function fetchCandidateProductPage(model) {
  let lastError = null;
  for (const path of model.paths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(SOURCE_ORIGIN + path, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; AnanasAI-PriceLookup/1.0)",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "fa-IR,fa;q=0.9,en;q=0.7"
        }, redirect: "follow", signal: controller.signal
      });
      if (!response.ok) { lastError = new Error("HTTP " + response.status); continue; }
      const html = await response.text();
      const titleMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
      if (!titleMatch) { lastError = new Error("Product page not found"); continue; }
      const title = htmlToText(titleMatch[1]);
      const expected = normalizePhoneModel(model.name).split(" ").filter(x => x.length > 1);
      const actual = normalizePhoneModel(title);
      const matches = expected.filter(token => actual.includes(token)).length;
      if (matches < Math.min(2, expected.length)) { lastError = new Error("Product title did not match requested model"); continue; }
      return { html, path: new URL(response.url).pathname || path, title };
    } catch (error) { lastError = error; }
    finally { clearTimeout(timer); }
  }
  throw lastError || new Error("مدل موردنظر پیدا نشد.");
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
  const lowestPrice = startingPrice && lowestOffer ? Math.min(startingPrice, lowestOffer) : (lowestOffer || startingPrice);

  let status = "available";
  let message = "قیمت و پیشنهاد فروشندگان برای این مدل در دسترس است.";
  if (!offers.length && !startingPrice) {
    status = "no_listed_price";
    message = "در حال حاضر قیمت یا فروشنده فعالی برای این محصول ثبت نشده است.";
  } else if (!offers.length) {
    status = "starting_price_only";
    message = "قیمت پایه موجود است، اما پیشنهاد فروشنده‌ای در دسترس نیست.";
  } else if (!offers.some(offer => offer.purchase_url)) {
    message = "قیمت فروشندگان موجود است، اما لینک خرید مستقیم در دسترس نیست.";
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
  const q = normalizePhoneModel(query);
  const known = TEST_MODELS.find(model => model.id === q ||
    normalizePhoneModel(model.name) === q ||
    model.aliases.some(alias => normalizePhoneModel(alias) === q));
  if (known) {
    const dynamic = buildPhoneModel(query);
    return { ...known, paths: [...new Set([known.path, ...(dynamic?.paths || [])])] };
  }
  return buildPhoneModel(query);
}

async function fetchProduct(model, request, refresh) {
  const cache = caches.default;
  const cacheKey = new Request(new URL("/__ananas_digiato_price_v2/" + model.id, request.url).toString());
  if (!refresh) {
    try { const cached = await cache.match(cacheKey); if (cached) return { ...(await cached.json()), cached: true }; } catch {}
  }
  const page = await fetchCandidateProductPage(model);
  const resolvedModel = { ...model, path: page.path, name: page.title };
  const product = extractProduct(page.html, resolvedModel);
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
    return json({ success: true, models: TEST_MODELS.map(({ id, name }) => ({ id, name })), usage: "/api/phone-prices?model=Samsung%20Galaxy%20S25%20Ultra" });
  }
  const model = resolveModel(query);
  if (!model) return json({ success: false, error: "نام برند یا مدل گوشی قابل تشخیص نیست." }, 400);
  try {
    const product = await fetchProduct(model, context.request, refresh);
    return json({ success: true, product });
  } catch (error) {
    return json({ success: false, model: model.name, error: "در حال حاضر قیمت این مدل قابل دریافت نیست.", details: String(error?.message || error) }, 502);
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
