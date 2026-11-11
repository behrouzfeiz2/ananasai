/**
 * AnanasAI - Dynamic phone specifications lookup.
 * GET /api/phone-specs?q=Samsung%20Galaxy%20S25%20Ultra
 *
 * Searches the public GSMArena catalogue and extracts the matched device
 * specification table. No hard-coded supported-model allowlist.
 */
const SOURCE = "https://www.gsmarena.com";
const TTL = 86400;
const TIMEOUT = 12000;
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: HEADERS });
}
function normalizeDigits(value) {
  return String(value || "").replace(/[۰-۹٠-٩]/g, d => {
    const fa = "۰۱۲۳۴۵۶۷۸۹";
    const ar = "٠١٢٣٤٥٦٧٨٩";
    const i = fa.indexOf(d);
    return String(i >= 0 ? i : ar.indexOf(d));
  });
}
function normalize(value) {
  return normalizeDigits(value).toLowerCase()
    .replace(/ي/g, "ی").replace(/ك/g, "ک")
    .replace(/گالاکسی|گلکسی/g, "galaxy")
    .replace(/سامسونگ/g, "samsung").replace(/شیائومی/g, "xiaomi")
    .replace(/ردمی/g, "redmi").replace(/پوکو/g, "poco")
    .replace(/آیفون|ایفون/g, "iphone")
    .replace(/[\u200c\u200f\u200e]/g, " ")
    .replace(/[^\p{L}\p{N}\s.+-]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
function decode(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ""; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } });
}
function textFromHtml(value) {
  return decode(String(value || "")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/tr|\/td)>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AnanasAI-PhoneSpecs/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9,fa;q=0.7"
      },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("GSMArena HTTP " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
function findSearchMatches(html, query) {
  const found = [];
  const re = /<a\b([^>]*href=["']([^"']+-\d+\.php)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  const q = normalize(query);
  const tokens = q.split(" ").filter(x => x.length > 1);
  while ((m = re.exec(html)) !== null) {
    const href = m[2];
    const inner = m[3];
    const imgAlt = (inner.match(/\balt=["']([^"']+)["']/i) || [])[1] || "";
    const titleAttr = (m[1].match(/\btitle=["']([^"']+)["']/i) || [])[1] || "";
    const name = textFromHtml(inner) || decode(imgAlt) || decode(titleAttr);
    const candidate = normalize(name || imgAlt || titleAttr);
    if (!candidate || !/phone|iphone|galaxy|redmi|xiaomi|poco|samsung/i.test(candidate + " " + href)) continue;
    const score = tokens.reduce((n, token) => n + (candidate.includes(token) ? 1 : 0), 0);
    if (!found.some(x => x.url === new URL(href, SOURCE).toString())) {
      found.push({ name: name || decode(imgAlt) || decode(titleAttr), url: new URL(href, SOURCE).toString(), score });
    }
  }
  return found.sort((a, b) => b.score - a.score).slice(0, 8);
}
function extractSpecs(html) {
  const specs = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowRe.exec(html)) !== null) {
    const cells = [...row[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 2) continue;
    const label = textFromHtml(cells[0][2]);
    const value = textFromHtml(cells.slice(1).map(x => x[2]).join(" "));
    if (!label || !value) continue;
    if (label.length > 80 || value.length > 900) continue;
    specs.push({ label: label.slice(0, 80), value: value.slice(0, 900) });
  }
  const preferred = ["Network", "Launch", "Body", "Display", "Platform", "Memory", "Main Camera", "Selfie camera", "Sound", "Comms", "Features", "Battery", "Misc"];
  specs.sort((a, b) => {
    const ai = preferred.findIndex(x => normalize(x) === normalize(a.label));
    const bi = preferred.findIndex(x => normalize(x) === normalize(b.label));
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
  return specs.slice(0, 40);
}
function getBrand(name, url) {
  const s = normalize(name + " " + url);
  if (/iphone|apple/.test(s)) return "Apple";
  if (/samsung|galaxy/.test(s)) return "Samsung";
  if (/xiaomi|redmi|poco/.test(s)) return "Xiaomi";
  return "نامشخص";
}
async function lookup(query, request) {
  const cache = caches.default;
  const cacheUrl = new URL("/__ananas_phone_specs_v1/" + encodeURIComponent(normalize(query)), request.url);
  const cacheKey = new Request(cacheUrl.toString());
  try {
    const cached = await cache.match(cacheKey);
    if (cached) return { ...(await cached.json()), cached: true };
  } catch {}
  const searchUrl = SOURCE + "/res.php3?sSearch=" + encodeURIComponent(query);
  const searchHtml = await fetchText(searchUrl);
  const matches = findSearchMatches(searchHtml, query);
  if (!matches.length || matches[0].score < Math.max(1, normalize(query).split(" ").filter(x => x.length > 1).length * 0.45)) {
    throw new Error("مدل دقیقی با این عبارت در فهرست GSMArena پیدا نشد.");
  }
  const chosen = matches[0];
  const pageHtml = await fetchText(chosen.url);
  const h1 = pageHtml.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = h1 ? textFromHtml(h1[1]) : chosen.name;
  const specs = extractSpecs(pageHtml);
  if (specs.length < 3) throw new Error("جدول مشخصات فنی این صفحه قابل استخراج نیست.");
  const result = {
    name,
    brand: getBrand(name, chosen.url),
    specs,
    source: "GSMArena",
    source_url: chosen.url,
    checked_at: new Date().toISOString()
  };
  try {
    await cache.put(cacheKey, new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=" + TTL }
    }));
  } catch {}
  return { ...result, cached: false };
}
export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const query = (url.searchParams.get("q") || url.searchParams.get("model") || "").trim();
  if (!query) return json({ success: false, error: "نام مدل گوشی را وارد کنید.", usage: "/api/phone-specs?q=Samsung%20Galaxy%20S25%20Ultra" }, 400);
  if (query.length > 100) return json({ success: false, error: "عبارت جست‌وجو بیش از حد طولانی است." }, 400);
  try {
    const phone = await lookup(query, context.request);
    return json({ success: true, phone });
  } catch (error) {
    console.error("ANANAS_PHONE_SPECS_LOOKUP_ERROR", query, error.message);
    return json({ success: false, source: "GSMArena", error: String(error.message || error) }, 502);
  }
}
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: HEADERS });
}
