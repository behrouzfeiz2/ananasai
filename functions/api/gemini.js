
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// =====================================================
// ANANAS AI - GEMINI + GOOGLE SEARCH + GROQ
// Cloudflare Pages Functions
// =====================================================

// -------------------- CONFIG -------------------------

const FREE_DAILY_LIMIT = 10;
const PRO_DAILY_LIMIT = 100;

const GEMINI_TIMEOUT = 30000;
const GROQ_TIMEOUT = 25000;

const ENABLE_GOOGLE_SEARCH = true;

// مدل پیش‌فرض و مدل‌های جایگزین
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite"
];

const GROQ_MODEL = "llama-3.1-8b-instant";

// =====================================================
// 1. GENERAL HELPERS
// =====================================================

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

function getPersianDate() {
  const now = new Date();

  return {
    todayStr: now.toLocaleDateString("fa-IR", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }),

    gregorianStr: now.toLocaleDateString("en-US", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    })
  };
}

function uniqueModels(models) {
  return [...new Set(models.filter(Boolean))];
}

// =====================================================
// 2. USER AUTHENTICATION AND QUOTA
// =====================================================

async function getUserStatusAndQuota(request, env) {

  const userToken = (
    request.headers.get("X-User-Token") || ""
  ).trim();

  const deviceUUID = (
    request.headers.get("X-Device-UUID") || "unknown_device"
  ).trim();

  let isPro = false;
  let limitText = FREE_DAILY_LIMIT;

  // اعتبارسنجی کد پرو
  if (userToken !== "") {

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
    limitText = PRO_DAILY_LIMIT;
  }

  const today = getTodayTehran();

  const storageKey = `usage_${
    isPro ? "pro_" : "device_"
  }${isPro ? userToken : deviceUUID}_${today}`;

  let usedText = 0;

  if (env.ANANAS_KV) {

    try {

      const rawUsage = await env.ANANAS_KV.get(storageKey);

      if (rawUsage) {
        const parsed = JSON.parse(rawUsage);
        usedText = Math.max(0, Number(parsed.text) || 0);
      }

    } catch (err) {

      console.error("Quota read error:", err);

    }

  }

  return {
    isPro,
    limitText,
    usedText,
    storageKey
  };
}

// =====================================================
// 3. SAVE QUOTA
// =====================================================

async function saveQuota(context, env, quota) {

  quota.usedText += 1;

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

// =====================================================
// 4. SYSTEM PROMPT
// =====================================================

function createSystemPrompt(mode) {

  const { todayStr, gregorianStr } = getPersianDate();

  let prompt = `
نام تو «آناناس» (AnanasAI) است.

تو یک دستیار هوش مصنوعی فارسی‌زبان، صمیمی، دقیق و حرفه‌ای هستی.

قوانین هویتی:
- همیشه نام خود را دقیقاً به شکل «آناناس» با حروف فارسی بنویس.
- هرگز نام خود را به شکل ترکیبی فارسی و انگلیسی ننویس.
- درباره مدل و نسخه دقیق موتور هوش مصنوعی فقط اطلاعات تأییدشده ارائه بده.
- پاسخ‌ها را به زبان فارسی روان و با فرمت Markdown بنویس.

تاریخ امروز به وقت تهران:
${todayStr}

معادل میلادی:
${gregorianStr}

قوانین پاسخ‌گویی:
- پاسخ‌ها باید دقیق، کاربردی و متناسب با سؤال باشند.
- فقط در صورت سؤال مستقیم درباره تاریخ یا زمان، تاریخ امروز را اعلام کن.
- از توضیحات غیرضروری خودداری کن.
- اگر سؤال عمومی و پایدار است، مستقیم پاسخ بده.
- اگر اطلاعات ممکن است تغییر کرده باشد، از جست‌وجوی گوگل استفاده کن.
- برای اخبار، قیمت‌ها، انتخابات، نسخه‌های جدید، رویدادها و اطلاعات روز، اطلاعات به‌روز را بررسی کن.
- در صورت استفاده از نتایج وب، آن‌ها را با دانش خود ترکیب و تحلیل کن.
- منابع اینترنتی را جعل نکن.
- اگر جست‌وجو انجام نشده، ادعای جست‌وجو نکن.
- اگر اطلاعات کافی وجود ندارد، صادقانه اعلام کن.
- هرگز فقط به کاربر نگو که در حال جست‌وجو یا گردآوری اطلاعات هستی؛ پاسخ نهایی را ارائه بده.

`;

  if (mode === "coder") {

    prompt += `
نقش تخصصی:
تو یک مهندس ارشد نرم‌افزار و برنامه‌نویس حرفه‌ای هستی.

حوزه‌های تخصص:
- JavaScript و TypeScript
- Python
- Rust
- HTML و CSS
- توسعه وب
- Backend و API
- دیتابیس
- امنیت نرم‌افزار
- دیباگ
- معماری نرم‌افزار

قوانین:
- کدهای تمیز، استاندارد و قابل توسعه ارائه بده.
- در اصلاح کدهای موجود، قابلیت‌های قبلی را حفظ کن.
- بدون دلیل فنی بخش‌های مهم کد را حذف نکن.
- در صورت نیاز، کد کامل و یکپارچه ارائه بده.
- برای اطلاعات فنی جدید، مستندات رسمی را بررسی کن.
`;

  }

  return prompt;
}

// =====================================================
// 5. SEARCH INTENT DETECTION
// =====================================================

// تشخیص سؤالات نیازمند اطلاعات روز
function requiresFreshSearch(text) {

  const pattern = /امروز|دیروز|فردا|این هفته|این ماه|این سال|جدیدترین|آخرین|فعلی|اکنون|در حال حاضر|قیمت|نرخ|دلار|یورو|طلا|بیت.?کوین|اتریوم|اخبار|خبرهای|انتخابات|نتایج انتخابات|نتایج زنده|مسابقه امروز|نسخه جدید|آپدیت|به.?روزرسانی|چه اتفاقی افتاد|چه شد|آخرین وضعیت|latest|today|yesterday|tomorrow|current|currently|recent|breaking|news|price|election|elections|exchange rate|live results|latest version/i;

  return pattern.test(text || "");
}

// استخراج آخرین پیام کاربر
function getLastUserMessage(contents) {

  const lastUser = [...(contents || [])]
    .reverse()
    .find(item => item.role === "user");

  return (lastUser?.parts || [])
    .map(part => part.text || "")
    .join("\n");
}

// =====================================================
// 6. INCOMPLETE RESPONSE DETECTION
// =====================================================

function isPendingSearchMessage(text) {

  const pattern =
    /در حال بررسی|در حال جست.?وجو|در حال گردآوری اطلاعات|اجازه بدهید.*بررسی کنم|اجازه دهید.*بررسی کنم|دارم.*جست.?وجو می.?کنم|در حال دریافت اطلاعات|لطفاً کمی صبر کنید|لطفا کمی صبر کنید|به زودی نتیجه را|نتیجه را اعلام می‌کنم|نتیجه را اعلام خواهم کرد|i am searching|i'm searching|let me search|let me look up|searching the web|checking the latest|gathering information/i;

  return pattern.test(text || "");
}

// تشخیص پاسخ‌هایی که مدل اطلاعات کافی ندارد
function isKnowledgeFailure(text) {

  const pattern =
    /به اطلاعات به.?روز دسترسی ندارم|نمی‌توانم اطلاعات فعلی را تأیید کنم|نمی‌توانم نتایج جدید را بررسی کنم|دانش من تا سال|اطلاعات من تا سال|اطلاعات به.?روز در دسترس ندارم|i cannot access real.?time|i don't have access to current|my knowledge cutoff|i cannot verify current/i;

  return pattern.test(text || "");
}

// =====================================================
// 7. EXTRACT RESPONSE TEXT
// =====================================================

function getGeminiAnswer(responseJson) {

  return (
    responseJson?.candidates?.[0]?.content?.parts || []
  )
    .map(part => part.text || "")
    .join("\n")
    .trim();
}

// =====================================================
// 8. CHECK REAL GOOGLE GROUNDING
// =====================================================

function hasRealGrounding(responseJson) {

  const metadata =
    responseJson?.candidates?.[0]?.groundingMetadata;

  if (!metadata) return false;

  const hasQueries =
    (metadata.webSearchQueries || []).length > 0;

  const hasSources =
    (metadata.groundingChunks || []).some(
      item => Boolean(item.web?.uri)
    );

  return hasQueries || hasSources;
}

// =====================================================
// 9. EXTRACT GOOGLE SOURCES
// =====================================================

function extractWebSources(responseJson) {

  const candidate = responseJson?.candidates?.[0];

  const metadata = candidate?.groundingMetadata;

  if (!metadata) {

    return {
      used: false,
      queries: [],
      sources: [],
      citations: []
    };

  }

  const chunks = metadata.groundingChunks || [];

  const sources = chunks
    .filter(item => item.web?.uri)
    .map((item, index) => ({
      id: index,
      title: item.web.title || "منبع اینترنتی",
      url: item.web.uri
    }));

  const uniqueSources = [
    ...new Map(
      sources.map(source => [
        source.url,
        source
      ])
    ).values()
  ];

  const citations = (
    metadata.groundingSupports || []
  ).map(item => ({
    segment: item.segment || null,
    sources: item.groundingChunkIndices || []
  }));

  return {
    used: true,
    queries: metadata.webSearchQueries || [],
    sources: uniqueSources,
    citations
  };
}

// =====================================================
// 10. PREPARE GEMINI PAYLOAD
// =====================================================

function prepareGeminiPayload(
  originalPayload,
  systemPrompt,
  useSearch
) {

  const payload = structuredClone(originalPayload || {});

  // حفظ دستور قبلی سیستم
  const previousParts =
    payload.systemInstruction?.parts || [];

  const previousInstruction = previousParts
    .map(part => part.text || "")
    .filter(Boolean)
    .join("\n");

  payload.systemInstruction = {
    ...(payload.systemInstruction || {}),
    parts: [
      {
        text: previousInstruction
          ? systemPrompt + "\n\n" + previousInstruction
          : systemPrompt
      }
    ]
  };

  // فعال کردن Google Search
  if (useSearch && ENABLE_GOOGLE_SEARCH) {

    if (!Array.isArray(payload.tools)) {
      payload.tools = [];
    }

    const alreadyConfigured = payload.tools.some(tool =>
      tool.google_search || tool.googleSearch
    );

    if (!alreadyConfigured) {

      payload.tools.push({
        google_search: {}
      });

    }

  }

  return payload;
}

// =====================================================
// 11. GEMINI API CALL
// =====================================================

async function callGemini(
  targetModel,
  apiKey,
  originalPayload,
  systemPrompt,
  useSearch
) {

  const cleanName = targetModel.replace(/^models\//, "");

  const apiUrl =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanName)}:generateContent`;

  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    GEMINI_TIMEOUT
  );

  try {

    const payload = prepareGeminiPayload(
      originalPayload,
      systemPrompt,
      useSearch
    );

    const response = await fetch(apiUrl, {

      method: "POST",

      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },

      body: JSON.stringify(payload),

      signal: controller.signal

    });

    const responseText = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      responseText,
      model: cleanName,
      searchEnabled: useSearch
    };

  } finally {

    clearTimeout(timeoutId);

  }
}

// =====================================================
// 12. SEARCH ERROR DETECTION
// =====================================================

function isSearchConfigurationError(status, responseText) {

  if (![400, 403, 404, 422].includes(status)) {
    return false;
  }

  const errorText = (responseText || "").toLowerCase();

  const indicators = [
    "google_search",
    "google search",
    "grounding",
    "unsupported tool",
    "tool not supported",
    "tool is not supported",
    "not available on free tier",
    "not enabled for your project",
    "billing required",
    "not supported for this model"
  ];

  return indicators.some(term =>
    errorText.includes(term)
  );
}

// =====================================================
// 13. BUILD GROQ MESSAGES
// =====================================================

function createGroqMessages(contents, systemPrompt) {

  const messages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];

  (contents || []).forEach(item => {

    const textContent = (item.parts || [])
      .map(part => part.text || "")
      .filter(Boolean)
      .join("\n");

    if (!textContent.trim()) return;

    messages.push({
      role: item.role === "user" ? "user" : "assistant",
      content: textContent
    });

  });

  return messages;
}

// =====================================================
// 14. GROQ FALLBACK
// =====================================================

async function callGroq(apiKey, messages) {

  const controller = new AbortController();

  const timeoutId = setTimeout(
    () => controller.abort(),
    GROQ_TIMEOUT
  );

  try {

    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {

        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },

        body: JSON.stringify({

          model: GROQ_MODEL,
          messages,
          temperature: 0.7

        }),

        signal: controller.signal

      }
    );

    const responseText = await response.text();

    if (!response.ok) {

      console.error("Groq API error:", response.status);

      return {
        success: false
      };

    }

    const result = JSON.parse(responseText);

    const answer =
      result.choices?.[0]?.message?.content || "";

    return {

      success: true,

      responseJson: {

        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: answer
                }
              ]
            }
          }
        ]

      }

    };

  } finally {

    clearTimeout(timeoutId);

  }
}

// =====================================================
// 15. GET REQUEST - QUOTA
// =====================================================

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

      quota: {
        isPro: quota.isPro,
        used: quota.usedText,
        limit: quota.limitText
      }

    });

  } catch (err) {

    console.error("GET error:", err);

    return jsonResponse({

      error: {
        message: "خطای داخلی سرور در بررسی سهمیه."
      }

    }, 500);

  }

}

// =====================================================
// 16. MAIN POST REQUEST
// =====================================================

export async function onRequestPost(context) {

  const { request, env } = context;

  try {

    // -----------------------------------------------
    // دریافت درخواست
    // -----------------------------------------------

    const body = await request.json();

    const {
      model,
      payload: originalPayload,
      mode
    } = body;

    if (
      !originalPayload ||
      !Array.isArray(originalPayload.contents) ||
      originalPayload.contents.length === 0
    ) {

      return jsonResponse({

        error: {
          message: "ساختار درخواست یا محتوای پیام معتبر نیست."
        }

      }, 400);

    }

    // -----------------------------------------------
    // بررسی کلید API
    // -----------------------------------------------

    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {

      return jsonResponse({

        error: {
          message: "کلید GEMINI_API_KEY در تنظیمات Cloudflare تعریف نشده است."
        }

      }, 500);

    }

    // -----------------------------------------------
    // احراز هویت و سهمیه
    // -----------------------------------------------

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
            `سهمیه پیام‌های امروز شما (${quota.limitText} از ${quota.limitText}) به پایان رسیده است.` +
            (!quota.isPro
              ? " برای ارتقا به ۱۰۰ پیام روزانه، کد فعال‌سازی پرو تهیه کنید."
              : "")

        },

        quota: {
          isPro: quota.isPro,
          used: quota.usedText,
          limit: quota.limitText
        }

      }, 429);

    }

    // -----------------------------------------------
    // بررسی فایل‌های ضمیمه
    // -----------------------------------------------

    const payload = structuredClone(originalPayload);

    const contents = payload.contents || [];

    const hasAttachment = contents.some(item =>
      (item.parts || []).some(part =>
        part.inlineData || part.fileData
      )
    );

    // -----------------------------------------------
    // محدودیت کاربران رایگان
    // -----------------------------------------------

    if (!quota.isPro && (hasAttachment || mode === "coder")) {

      return jsonResponse({

        error: {

          message:
            "امکان ضمیمه کردن فایل و استفاده از بخش تخصصی «کد نویس» ویژه کاربران پرو است."

        },

        quota: {
          isPro: quota.isPro,
          used: quota.usedText,
          limit: quota.limitText
        }

      }, 403);

    }

    // -----------------------------------------------
    // ساخت دستورات سیستم
    // -----------------------------------------------

    const systemPrompt = createSystemPrompt(mode);

    const lastUserMessage = getLastUserMessage(contents);

    // تشخیص نیاز به اطلاعات روز
    const needsFreshSearch =
      requiresFreshSearch(lastUserMessage);

    // -----------------------------------------------
    // ساخت پیام‌های Groq
    // -----------------------------------------------

    const groqMessages = createGroqMessages(
      contents,
      systemPrompt
    );

    // -----------------------------------------------
    // زنجیره مدل‌های Gemini
    // -----------------------------------------------

    const geminiModels = uniqueModels([

      model || DEFAULT_GEMINI_MODEL,

      ...GEMINI_MODELS

    ]);

    let geminiResult = null;
    let lastGeminiError = null;

    let responseJson = {};
    let isGroqSuccess = false;

    let pendingResponseDetected = false;

    // =================================================
    // 17. SMART GOOGLE SEARCH
    // =================================================

    // در این مرحله Google Search به تمام مدل‌ها ارائه می‌شود.
    // خود Gemini تشخیص می‌دهد که جست‌وجو لازم است یا خیر.

    if (ENABLE_GOOGLE_SEARCH) {

      for (const targetModel of geminiModels) {

        try {

          const result = await callGemini(
            targetModel,
            apiKey,
            payload,
            systemPrompt,
            true
          );

          if (!result.ok) {

            lastGeminiError = {
              status: result.status,
              text: result.responseText
            };

            console.warn(
              "Gemini Search failed:",
              targetModel,
              result.status
            );

            continue;
          }

          let candidateJson;

          try {

            candidateJson = JSON.parse(
              result.responseText
            );

          } catch {

            continue;

          }

          const answer = getGeminiAnswer(candidateJson);

          const grounded = hasRealGrounding(candidateJson);

          const pending =
            isPendingSearchMessage(answer);

          const knowledgeFailure =
            isKnowledgeFailure(answer);

          if (pending || knowledgeFailure) {
            pendingResponseDetected = true;
          }

          // برای موضوعات روز، پاسخ بدون Grounding
          // به‌عنوان پاسخ نهایی پذیرفته نمی‌شود.
          if (needsFreshSearch && !grounded) {

            console.warn(
              "Fresh information required but no grounding:",
              targetModel
            );

            continue;
          }

          // رد پیام ناقص
          if (pending || knowledgeFailure) {

            if (!grounded) continue;

            console.warn(
              "Incomplete response detected:",
              targetModel
            );

            continue;
          }

          if (!answer) continue;

          geminiResult = {
            ...result,
            parsed: candidateJson
          };

          break;

        } catch (err) {

          lastGeminiError = {
            status: 502,
            text: err.message
          };

          console.error(
            "Gemini Search exception:",
            targetModel,
            err
          );

        }

      }

    }

    // =================================================
    // 18. FORCED SEARCH FALLBACK
    // =================================================

    // اگر مدل‌های اصلی جست‌وجوی واقعی انجام ندادند،
    // یک درخواست ویژه با مدل جست‌وجوی جایگزین اجرا می‌شود.

    if (
      !geminiResult &&
      ENABLE_GOOGLE_SEARCH &&
      (
        needsFreshSearch ||
        pendingResponseDetected
      )
    ) {

      const forcedSearchPrompt = systemPrompt + `

دستور ویژه و ضروری:

این درخواست به اطلاعات به‌روز و جست‌وجوی اینترنتی نیاز دارد.

حتماً از ابزار Google Search استفاده کن.

قوانین:
1. قبل از پاسخ نهایی جست‌وجوی واقعی انجام بده.
2. نتایج مرتبط را بررسی کن.
3. برای اطلاعات مهم به منابع معتبر اولویت بده.
4. اطلاعات جدید را از اطلاعات تاریخی و قدیمی تفکیک کن.
5. هیچ نتیجه‌ای را حدس نزن.
6. هرگز فقط اعلام نکن که در حال جست‌وجو هستی.
7. پاسخ نهایی را در همین درخواست ارائه بده.
8. اگر اطلاعات کافی وجود ندارد، محدودیت را شفاف بیان کن.
`;

      const forcedSearchModels = uniqueModels([

        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite"

      ]);

      for (const searchModel of forcedSearchModels) {

        try {

          const result = await callGemini(
            searchModel,
            apiKey,
            payload,
            forcedSearchPrompt,
            true
          );

          if (!result.ok) {

            lastGeminiError = {
              status: result.status,
              text: result.responseText
            };

            console.error(
              "Forced Search HTTP error:",
              searchModel,
              result.status
            );

            continue;
          }

          const candidateJson = JSON.parse(
            result.responseText
          );

          const answer = getGeminiAnswer(candidateJson);

          // پذیرش فقط پاسخ دارای منابع واقعی
          if (
            answer &&
            hasRealGrounding(candidateJson) &&
            !isPendingSearchMessage(answer) &&
            !isKnowledgeFailure(answer)
          ) {

            geminiResult = {
              ...result,
              parsed: candidateJson
            };

            console.log(
              "Forced Google Search successful:",
              searchModel
            );

            break;

          }

          console.warn(
            "Forced Search returned no usable grounding:",
            searchModel
          );

        } catch (err) {

          lastGeminiError = {
            status: 502,
            text: err.message
          };

          console.error(
            "Forced Search exception:",
            searchModel,
            err
          );

        }

      }

    }

    // =================================================
    // 19. NORMAL GEMINI FALLBACK
    // =================================================

    // فقط برای سؤال‌هایی که جست‌وجوی ضروری ندارند.
    // هرگز پاسخ قدیمی را جایگزین نتیجه جست‌وجوی ناموفق نکن.

    if (
      !geminiResult &&
      !needsFreshSearch &&
      !pendingResponseDetected
    ) {

      for (const targetModel of geminiModels) {

        try {

          const result = await callGemini(
            targetModel,
            apiKey,
            payload,
            systemPrompt,
            false
          );

          if (!result.ok) {

            lastGeminiError = {
              status: result.status,
              text: result.responseText
            };

            continue;
          }

          const candidateJson = JSON.parse(
            result.responseText
          );

          const answer = getGeminiAnswer(candidateJson);

          if (
            answer &&
            !isPendingSearchMessage(answer) &&
            !isKnowledgeFailure(answer)
          ) {

            geminiResult = {
              ...result,
              parsed: candidateJson
            };

            break;

          }

        } catch (err) {

          lastGeminiError = {
            status: 502,
            text: err.message
          };

          console.error(
            "Normal Gemini error:",
            targetModel,
            err
          );

        }

      }

    }

    // =================================================
    // 20. PROCESS GEMINI RESPONSE
    // =================================================

    if (geminiResult) {

      responseJson = geminiResult.parsed;

      responseJson.webSearch = extractWebSources(
        responseJson
      );

      responseJson.provider = {

        name: "Gemini",
        model: geminiResult.model

      };

    }

    // =================================================
    // 21. REQUIRED SEARCH FAILURE
    // =================================================

    // سؤال روز نباید با اطلاعات قدیمی پاسخ داده شود.
    // در این شرایط پاسخ Groq هم جایگزین نمی‌شود.

    if (
      !geminiResult &&
      (
        needsFreshSearch ||
        pendingResponseDetected
      )
    ) {

      console.error(
        "Required search failed:",
        lastGeminiError?.status
      );

      return jsonResponse({

        error: {

          message:
            "جست‌وجوی اینترنتی در حال حاضر موفق نشد. لطفاً چند لحظه دیگر دوباره سؤال خود را ارسال کنید."

        },

        webSearch: {

          used: false,
          queries: [],
          sources: []

        },

        quota: {

          isPro: quota.isPro,
          used: quota.usedText,
          limit: quota.limitText

        }

      }, 503);

    }

    // =================================================
    // 22. GROQ FALLBACK
    // =================================================

    if (!geminiResult) {

      const groqApiKey = env.GROQ_API_KEY;

      // فایل‌های ضمیمه به Groq ارسال نمی‌شوند.
      if (groqApiKey && !hasAttachment) {

        try {

          const groqResult = await callGroq(
            groqApiKey,
            groqMessages
          );

          if (groqResult.success) {

            responseJson = groqResult.responseJson;

            responseJson.provider = {

              name: "Groq",
              model: GROQ_MODEL

            };

            responseJson.webSearch = {

              used: false,
              queries: [],
              sources: [],
              citations: []

            };

            isGroqSuccess = true;

          }

        } catch (err) {

          console.error("Groq fallback error:", err);

        }

      }

    }

    // =================================================
    // 23. FINAL ERROR HANDLING
    // =================================================

    if (!geminiResult && !isGroqSuccess) {

      let errorMessage =
        "در حال حاضر امکان دریافت پاسخ از سرویس هوش مصنوعی وجود ندارد. لطفاً کمی بعد دوباره تلاش کنید.";

      if (hasAttachment) {

        errorMessage =
          "پردازش فایل یا تصویر با Gemini ناموفق بود. لطفاً دوباره تلاش کنید.";

      }

      console.error(
        "All AI providers failed:",
        lastGeminiError?.status
      );

      return jsonResponse({

        error: {
          message: errorMessage
        },

        quota: {

          isPro: quota.isPro,
          used: quota.usedText,
          limit: quota.limitText

        }

      }, 502);

    }

    // =================================================
    // 24. SAVE QUOTA
    // =================================================

    await saveQuota(
      context,
      env,
      quota
    );

    responseJson.quota = {

      isPro: quota.isPro,
      used: quota.usedText,
      limit: quota.limitText

    };

    // =================================================
    // 25. FINAL RESPONSE
    // =================================================

    return jsonResponse(responseJson, 200);

  } catch (err) {

    console.error("POST Internal Error:", err);

    return jsonResponse({

      error: {

        message:
          "خطای داخلی سرور. لطفاً دوباره تلاش کنید."

      }

    }, 500);

  }

}

// =====================================================
// 26. OPTIONS REQUEST
// =====================================================

export async function onRequestOptions() {

  return new Response(null, {

    status: 204,
    headers: corsHeaders

  });

}
