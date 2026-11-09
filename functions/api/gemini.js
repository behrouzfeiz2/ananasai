
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// ==================================================
// ANANAS AI - GEMINI API + GOOGLE SEARCH GROUNDING
// Cloudflare Pages Functions
// ==================================================

// ---------------- CONFIGURATION ----------------

const FREE_DAILY_LIMIT = 10;
const PRO_DAILY_LIMIT = 100;

const GEMINI_TIMEOUT = 25000;
const GROQ_TIMEOUT = 25000;

const ENABLE_GOOGLE_SEARCH = true;

// مدل‌های اصلی و جایگزین
// مدل درخواستی فرانت‌اند همیشه در اولویت است.
const FALLBACK_GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite"
];

const GROQ_MODEL = "llama-3.1-8b-instant";

// ==================================================
// 1. GENERAL HELPERS
// ==================================================

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

// ==================================================
// 2. USER AUTHENTICATION AND DAILY QUOTA
// ==================================================

async function getUserStatusAndQuota(request, env) {

  const userToken = (
    request.headers.get("X-User-Token") || ""
  ).trim();

  const deviceUUID = (
    request.headers.get("X-Device-UUID") || "unknown_device"
  ).trim();

  let isPro = false;
  let limitText = FREE_DAILY_LIMIT;

  if (userToken) {

    if (!env.ANANAS_KV) {
      return {
        error: "سیستم احراز هویت در حال حاضر در دسترس نیست.",
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

// ==================================================
// 3. SAVE USER QUOTA
// ==================================================

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

// ==================================================
// 4. SYSTEM PROMPT
// ==================================================

function createSystemPrompt(mode) {

  const { todayStr, gregorianStr } = getPersianDate();

  let systemPrompt = `
نام تو «آناناس» (AnanasAI) است.

تو یک دستیار هوش مصنوعی فارسی‌زبان، صمیمی، دقیق و حرفه‌ای هستی.

قوانین هویتی:
- همیشه نام خود را دقیقاً به شکل «آناناس» بنویس.
- از ترکیب حروف فارسی و انگلیسی در نوشتن نام خودداری کن.
- درباره هویت یا نسخه دقیق مدل فقط اطلاعات تأییدشده ارائه بده.
- پاسخ‌ها را به زبان فارسی روان و با فرمت Markdown ارائه بده.

تاریخ امروز به وقت تهران:
${todayStr}

معادل میلادی:
${gregorianStr}

قوانین پاسخ‌گویی:
- پاسخ‌ها باید دقیق، کاربردی و متناسب با سؤال باشند.
- فقط زمانی تاریخ امروز را اعلام کن که کاربر مستقیماً درباره تاریخ یا زمان سؤال کند.
- از پاسخ‌های طولانی و غیرضروری خودداری کن.
- در صورت نیاز از جست‌وجوی گوگل استفاده کن.
- برای اخبار، اطلاعات روز، قیمت‌ها، نسخه‌های جدید نرم‌افزار و رویدادهای جدید، اطلاعات به‌روز را بررسی کن.
- اگر اطلاعات موردنیاز ممکن است پس از تاریخ آموزش مدل تغییر کرده باشد، جست‌وجو را در اولویت قرار بده.
- برای سؤالات عمومی و اطلاعات پایدار، بدون جست‌وجوی غیرضروری پاسخ بده.
- اطلاعات حاصل از جست‌وجو را با دانش خود ترکیب و تحلیل کن.
- در صورت استفاده از منابع اینترنتی، اطلاعات و ارجاعات منابع را حفظ کن.
- اگر جست‌وجو انجام نداده‌ای، هرگز ادعا نکن که اطلاعات را از اینترنت دریافت کرده‌ای.
- اطلاعات نامطمئن را به‌عنوان واقعیت قطعی بیان نکن.
`;

  if (mode === "coder") {

    systemPrompt += `

نقش تخصصی:
تو در این گفتگو یک مهندس ارشد نرم‌افزار و برنامه‌نویس حرفه‌ای هستی.

در زمینه‌های زیر تخصص داری:
- JavaScript و TypeScript
- Python
- Rust
- HTML و CSS
- توسعه وب
- Backend و API
- دیتابیس
- امنیت نرم‌افزار
- دیباگ و تحلیل کد
- طراحی معماری نرم‌افزار

قوانین:
- کدهای تمیز، استاندارد و قابل توسعه ارائه بده.
- در اصلاح کدهای موجود، قابلیت‌های قبلی را حفظ کن.
- از حذف بخش‌های مهم کد بدون دلیل فنی خودداری کن.
- خطاها را توضیح بده و راه‌حل عملی ارائه کن.
- در صورت نیاز به مستندات جدید، از جست‌وجوی اینترنتی استفاده کن.
`;

  }

  return systemPrompt;
}

// ==================================================
// 5. PREPARE GEMINI PAYLOAD
// ==================================================

function prepareGeminiPayload(originalPayload, systemPrompt, useSearch) {

  const payload = structuredClone(originalPayload || {});

  // حفظ System Instruction قبلی
  const previousParts = payload.systemInstruction?.parts || [];

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

  // فعال‌سازی Google Search Grounding
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

// ==================================================
// 6. GOOGLE SEARCH ERROR DETECTION
// ==================================================

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

// ==================================================
// 7. GEMINI API REQUEST
// ==================================================

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

// ==================================================
// 8. EXTRACT GOOGLE SEARCH SOURCES
// ==================================================

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
    .map(item => ({
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

// ==================================================
// 9. BUILD GROQ MESSAGES
// ==================================================

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

// ==================================================
// 10. GROQ FALLBACK
// ==================================================

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

      return {
        success: false,
        error: responseText
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

// ==================================================
// 11. GET REQUEST - QUOTA STATUS
// ==================================================

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

    console.error("GET Error:", err);

    return jsonResponse({

      error: {
        message: "خطای داخلی سرور در بررسی سهمیه."
      }

    }, 500);

  }

}

// ==================================================
// 12. POST REQUEST - MAIN AI ENGINE
// ==================================================

export async function onRequestPost(context) {

  const { request, env } = context;

  try {

    // ----------------------------------------------
    // دریافت اطلاعات درخواست
    // ----------------------------------------------

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

    // ----------------------------------------------
    // بررسی کلید Gemini
    // ----------------------------------------------

    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {

      return jsonResponse({
        error: {
          message: "کلید GEMINI_API_KEY در تنظیمات Cloudflare تعریف نشده است."
        }
      }, 500);

    }

    // ----------------------------------------------
    // بررسی سهمیه و اعتبار کاربر
    // ----------------------------------------------

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

    // ----------------------------------------------
    // بررسی ضمیمه‌ها
    // ----------------------------------------------

    const payload = structuredClone(originalPayload);

    const contents = payload.contents || [];

    const hasAttachment = contents.some(item =>
      (item.parts || []).some(part =>
        part.inlineData || part.fileData
      )
    );

    // ----------------------------------------------
    // محدودیت کاربران رایگان
    // ----------------------------------------------

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

    // ----------------------------------------------
    // ساخت دستور اصلی مدل
    // ----------------------------------------------

    const systemPrompt = createSystemPrompt(mode);

    // ----------------------------------------------
    // ساخت پیام‌های Groq
    // ----------------------------------------------

    const groqMessages = createGroqMessages(
      contents,
      systemPrompt
    );

    // ----------------------------------------------
    // ساخت زنجیره مدل‌ها
    // ----------------------------------------------

    const geminiModels = uniqueModels([
      model || "gemini-3.5-flash-lite",
      ...FALLBACK_GEMINI_MODELS
    ]);

    let geminiResult = null;
    let lastGeminiError = null;

    // ==================================================
    // 13. FIRST PASS: GEMINI WITH GOOGLE SEARCH
    // ==================================================

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

          if (result.ok) {

            geminiResult = result;
            break;

          }

          lastGeminiError = {
            status: result.status,
            text: result.responseText
          };

          console.warn(
            `Gemini Search failed: ${targetModel}`,
            result.status
          );

        } catch (err) {

          lastGeminiError = {
            status: 502,
            text: err.message
          };

          console.error(
            `Gemini Search exception: ${targetModel}`,
            err
          );

        }

      }

    }

    // ==================================================
    // 14. SECOND PASS: GEMINI WITHOUT GOOGLE SEARCH
    // ==================================================

    if (!geminiResult) {

      for (const targetModel of geminiModels) {

        try {

          const result = await callGemini(
            targetModel,
            apiKey,
            payload,
            systemPrompt,
            false
          );

          if (result.ok) {

            geminiResult = result;
            break;

          }

          lastGeminiError = {
            status: result.status,
            text: result.responseText
          };

          console.warn(
            `Gemini normal request failed: ${targetModel}`,
            result.status
          );

        } catch (err) {

          lastGeminiError = {
            status: 502,
            text: err.message
          };

          console.error(
            `Gemini normal exception: ${targetModel}`,
            err
          );

        }

      }

    }

    // ==================================================
    // 15. PROCESS GEMINI RESPONSE
    // ==================================================

    let responseJson = {};
    let isGroqSuccess = false;

    if (geminiResult) {

      try {

        responseJson = JSON.parse(
          geminiResult.responseText
        );

      } catch (err) {

        return jsonResponse({

          error: {
            message: "پاسخ دریافتی از Gemini قابل پردازش نیست."
          }

        }, 502);

      }

      // استخراج منابع جست‌وجو
      responseJson.webSearch = extractWebSources(
        responseJson
      );

      responseJson.provider = {
        name: "Gemini",
        model: geminiResult.model
      };

    }

    // ==================================================
    // 16. THIRD PASS: GROQ FALLBACK
    // ==================================================

    if (!geminiResult) {

      const groqApiKey = env.GROQ_API_KEY;

      // فایل‌های ضمیمه فقط برای Gemini هستند.
      // در صورت خرابی Gemini، آن‌ها را ناقص به Groq نمی‌فرستیم.

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

    // ==================================================
    // 17. FINAL ERROR HANDLING
    // ==================================================

    if (!geminiResult && !isGroqSuccess) {

      let errorMessage =
        "در حال حاضر امکان دریافت پاسخ از سرویس هوش مصنوعی وجود ندارد. لطفاً کمی بعد دوباره تلاش کنید.";

      // پیام خطای Google را در لاگ نگه می‌داریم.
      if (lastGeminiError?.text) {

        console.error(
          "Last Gemini error:",
          lastGeminiError.text
        );

      }

      if (hasAttachment && !geminiResult) {

        errorMessage =
          "پردازش فایل یا تصویر با Gemini ناموفق بود. لطفاً دوباره تلاش کنید.";

      }

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

    // ==================================================
    // 18. SAVE QUOTA AFTER SUCCESS
    // ==================================================

    await saveQuota(context, env, quota);

    responseJson.quota = {

      isPro: quota.isPro,
      used: quota.usedText,
      limit: quota.limitText

    };

    // ==================================================
    // 19. FINAL RESPONSE
    // ==================================================

    return jsonResponse(responseJson, 200);

  } catch (err) {

    console.error("POST Internal Error:", err);

    return jsonResponse({

      error: {
        message: "خطای داخلی سرور. لطفاً دوباره تلاش کنید."
      }

    }, 500);

  }

}

// ==================================================
// 20. OPTIONS REQUEST
// ==================================================

export async function onRequestOptions() {

  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });

}
