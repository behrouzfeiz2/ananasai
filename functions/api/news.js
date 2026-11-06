export async function onRequestGet(context) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8"
  };

  const url = new URL(context.request.url);
  const query = (url.searchParams.get("q") || "").trim().toLowerCase();

  if (!query) {
    return new Response(JSON.stringify({ success: false, error: "کلمه کلیدی جستجو ارسال نشده است." }), {
      status: 400,
      headers: corsHeaders
    });
  }

  try {
    // لیست منابع RSS (ایران اینترنشنال، ۱آیت‌نویس و ایسنا)
    const rssUrls = [
      "https://www.iranintl.com/feed",
      "https://www.1itnevis.com/feeds/posts/default?alt=rss",
      "https://www.isna.ir/rss"
    ];

    let allItems = [];

    // دریافت و پردازش موازی تمام فیدهای RSS
    await Promise.all(
      rssUrls.map(async (rssUrl) => {
        try {
          const response = await fetch(rssUrl, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AnanasAI-Bot/1.0"
            }
          });

          if (!response.ok) return;
          const xmlText = await response.text();

          const itemMatches = xmlText.match(/<item>([\s\S]*?)<\/item>/g) || [];
          for (let rawItem of itemMatches) {
            const getTagText = (tag) => {
              const match = rawItem.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, "i"));
              if (!match) return "";
              return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim();
            };

            const title = getTagText("title");
            const link = getTagText("link");
            const pubDate = getTagText("pubDate");
            const description = getTagText("description");

            if (title) {
              allItems.push({ title, link, pubDate, description });
            }
          }
        } catch (e) {
          // اگر یکی از منابع خطا داد، بقیه کار کنند و متوقف نشود
        }
      })
    );

    // جستجوی کلمات کلیدی پرسیده شده توسط کاربر در میان تمامی اخبار جمع‌آوری‌شده
    const keywords = query.split(" ").filter(w => w.length > 2); // حذف کلمات خیلی کوتاه
    let matchedNews = null;

    for (let item of allItems) {
      const textToSearch = (item.title + " " + item.description).toLowerCase();
      const isMatch = keywords.some(kw => textToSearch.includes(kw));
      if (isMatch) {
        matchedNews = item;
        break; // اولین خبر مرتبط پیدا شده را برگردان
      }
    }

    // اگر خبر کاملاً مطابق پیدا نشد، اولین خبر موجود در لیست کلی را برگردان
    if (!matchedNews && allItems.length > 0) {
      matchedNews = allItems[0];
    }

    return new Response(JSON.stringify({ 
      success: true, 
      query: query,
      news: matchedNews 
    }), {
      status: 200,
      headers: corsHeaders
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
