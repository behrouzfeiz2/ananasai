
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Content-Type": "application/json; charset=utf-8"
};

// ======================================================
// ANANAS AI - COMPLETE BACKEND
// Gemini Interactions + Google Search + Groq
// Cloudflare Pages Functions
// ======================================================

const CONFIG = {
  FREE_LIMIT: 10,
  PRO_LIMIT: 100,

  DEFAULT_MODEL: "gemini-3.8-flash",

  SEARCH_MODEL: "gemini-3.8-flash",

  GEMINI_FALLBACK_MODELS: [
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash"
  ],

  GROQ_MODEL: "llama-3.1-8b-instant",

  GEMINI_TIMEOUT: 45000,
  GROQ_TIMEOUT: 25000,

  ENABLE_SEARCH: true,
  ENABLE_GROQ: true
};

// ======================================================
// 1. RESPONSE HELPERS
// ======================================================

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

function getDateInfo() {
  const now = new Date();

  return {
    persian: now.toLocaleDateString("fa-IR", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    }),

    gregorian: now.toLocaleDateString("en-US", {
      timeZone: "Asia/Tehran",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    })
  };
}

function unique(array) {
  return [...new Set(array.filter(Boolean))];
}

// ======================================================
// 2. USER AUTHENTICATION AND QUOTA
// ======================================================

async function getUserStatusAndQuota(request, env) {
  const userToken = (
    request.headers.get("X-User-Token") || ""
  ).trim();

  const deviceUUID = (
    request.headers.get("X-Device-UUID") || "unknown_device"
  ).trim();

  let isPro = false;
  let limitText = CONFIG.FREE_LIMIT;

  if (userToken) {
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
    limitText = CONFIG.PRO_LIMIT;
  }

  const today = getTodayTehran();

  const storageKey =
    `usage_${isPro ? "pro_" : "device_"}${isPro ? userToken : deviceUUID}_${today}`;

  let usedText = 0;

  if (env.ANANAS_KV) {
    try {
      const raw = await env.ANANAS_KV.get(storageKey);

      if (raw) {
        const parsed = JSON.parse(raw);
        usedText = Math.max(0, Number(parsed.text) || 0);
      }
    } catch (error) {
      console.error("QUOTA_READ_ERROR", error.message);
    }
  }

  return {
    isPro,
    limitText,
    usedText,
    storageKey
  };
}

async function saveQuota(context, env, quota) {
  quota.usedText++;

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

function quotaResponse(quota) {
  return {
    isPro: quota.isPro,
    used: quota.usedText,
    limit: quota.limitText
  };
}

// ======================================================
// 3. SYSTEM PROMPT
// ======================================================

function createSystemPrompt(mode) {
  const date = getDateInfo();

  let prompt = `
نام تو «آناناس» (AnanasAI) است.

تو یک دستیار هوش مصنوعی فارسی‌زبان، دقیق، صمیمی و حرفه‌ای هستی.

قوانین هویتی:
- همیشه نام خود را دقیقاً «آناناس» بنویس.
- از ترکیب حروف فارسی و انگلیسی در نام خودداری کن.
- درباره مدل و نسخه موتور هوش مصنوعی فقط اطلاعات تأییدشده ارائه بده.

تاریخ امروز به وقت تهران:
${date.persian}

معادل میلادی:
${date.gregorian}

قوانین پاسخ‌گویی:
- پاسخ‌ها به زبان فارسی روان باشند.
- از Markdown برای ساختاردهی پاسخ استفاده کن.
- پاسخ‌ها دقیق، مفید و متناسب با سؤال باشند.
- فقط در صورت سؤال مستقیم درباره تاریخ، روز یا زمان، تاریخ امروز را اعلام کن.
- برای اطلاعات عمومی و پایدار، مستقیماً پاسخ بده.
- برای اطلاعات روز، اخبار، قیمت‌ها، انتخابات و نسخه‌های جدید، اطلاعات جدید را بررسی کن.
- اگر از جست‌وجوی اینترنتی استفاده کردی، پاسخ را با منابع واقعی پشتیبانی کن.
- منابع، تاریخ‌ها و آمار را جعل نکن.
- اگر اطلاعات کافی نیست، محدودیت را شفاف بیان کن.
- هرگز فقط اعلام نکن که در حال جست‌وجو یا گردآوری اطلاعات هستی.
- همیشه تلاش کن پاسخ نهایی را در همان درخواست ارائه بدهی.

`;

  if (mode === "coder") {
    prompt += `
نقش تخصصی:
تو یک مهندس ارشد نرم‌افزار و برنامه‌نویس حرفه‌ای هستی.

حوزه‌های تخصصی:
JavaScript، TypeScript، Python، Rust، HTML، CSS،
API، Backend، دیتابیس، امنیت، دیباگ و معماری نرم‌افزار.

قوانین:
- کد تمیز و قابل توسعه ارائه بده.
- قابلیت‌های قبلی کد را حفظ کن.
- هنگام اصلاح فایل، بخش‌های غیرمرتبط را حذف نکن.
- در صورت درخواست، کد کامل و یکپارچه ارائه بده.
- برای اطلاعات فنی متغیر، مستندات رسمی را بررسی کن.
`;
  }

  return prompt;
}

// ======================================================
// 4. SEARCH INTENT
// ======================================================

function getLastUserMessage(contents) {
  const lastUser = [...(contents || [])]
    .reverse()
    .find(item => item.role === "user");

  return (lastUser?.parts || [])
    .map(part => part.text || "")
    .join("\n");
}

function requiresFreshSearch(text) {
  const pattern =
    /امروز|دیروز|فردا|این هفته|این ماه|جدیدترین|آخرین|فعلی|اکنون|در حال حاضر|قیمت|نرخ|دلار|یورو|طلا|بیت.?کوین|اتریوم|اخبار|خبرهای|انتخابات|نتایج انتخابات|نتایج زنده|نسخه جدید|آپدیت|به.?روزرسانی|چه اتفاقی افتاد|چه شد|آخرین وضعیت|latest|today|yesterday|tomorrow|current|currently|recent|breaking|news|price|election|exchange rate|live results|latest version/i;

  return pattern.test(text || "");
}

// ======================================================
// 5. INCOMPLETE ANSWER DETECTION
// ======================================================

function isPendingAnswer(text) {
  const pattern =
    /در حال بررسی|در حال جست.?وجو|در حال گردآوری اطلاعات|اجازه بدهید.*بررسی کنم|اجازه دهید.*بررسی کنم|دارم.*جست.?وجو می.?کنم|در حال دریافت اطلاعات|لطفاً کمی صبر کنید|لطفا کمی صبر کنید|به زودی نتیجه را|نتیجه را اعلام می‌کنم|i am searching|i'm searching|let me search|searching the web|checking the latest|gathering information/i;

  return pattern.test(text || "");
}

function isKnowledgeFailure(text) {
  const pattern =
    /به اطلاعات به.?روز دسترسی ندارم|نمی‌توانم اطلاعات فعلی را تأیید کنم|اطلاعات به.?روز در دسترس ندارم|my knowledge cutoff|i cannot access real.?time|i don't have access to current/i;

  return pattern.test(text || "");
}

// ======================================================
// 6. CONTENT AND ATTACHMENT HELPERS
// ======================================================

function hasAttachments(contents) {
  return (contents || []).some(item =>
    (item.parts || []).some(part =>
      Boolean(part.inlineData || part.fileData)
    )
  );
}

function getConversationText(contents) {
  return (contents || [])
    .map(item => {
      const role =
        item.role === "user" ? "کاربر" : "دستیار";

      const message = (item.parts || [])
        .map(part => part.text || "")
        .filter(Boolean)
        .join("\n");

      if (!message.trim()) return "";

      return `${role}:\n${message}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function getGeminiText(json) {
  return (
    json?.candidates?.[0]?.content?.parts || []
  )
    .map(part => part.text || "")
    .join("\n")
    .trim();
}

// ======================================================
// 7. GENERATE CONTENT API
// مخصوص حفظ ضمیمه‌ها و مدل‌های جایگزین
// ======================================================

async function callGenerateContent(
  model,
  apiKey,
  originalPayload,
  systemPrompt,
  useSearch
) {
  const cleanModel = model.replace(/^models\//, "");

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;

  const payload = structuredClone(originalPayload);

  const oldSystem =
    payload.systemInstruction?.parts || [];

  const oldText = oldSystem
    .map(part => part.text || "")
    .filter(Boolean)
    .join("\n");

  payload.systemInstruction = {
    ...(payload.systemInstruction || {}),
    parts: [{
      text: systemPrompt +
        (oldText ? "\n\n" + oldText : "")
    }]
  };

  if (useSearch && CONFIG.ENABLE_SEARCH) {
    payload.tools = [
      ...(Array.isArray(payload.tools) ? payload.tools : []),
      { google_search: {} }
    ];

    payload.generationConfig = {
      ...(payload.generationConfig || {}),
      temperature: 1.0
    };
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.GEMINI_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseText = await response.text();

    console.error("ANANAS_GENERATE_CONTENT", {
      model: cleanModel,
      status: response.status,
      searchEnabled: useSearch,
      response: responseText.slice(0, 2500)
    });

    return {
      ok: response.ok,
      status: response.status,
      responseText,
      model: cleanModel
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// 8. INTERACTIONS API - GOOGLE SEARCH
// مسیر اصلی جست‌وجوی جدید
// ======================================================

async function callInteractions(
  model,
  apiKey,
  contents,
  systemPrompt,
  forceSearch = false
) {
  const cleanModel = model.replace(/^models\//, "");

  const conversation = getConversationText(contents);

  const input = `
${systemPrompt}

${forceSearch ? `
دستور ویژه:
این سؤال به اطلاعات به‌روز نیاز دارد.
حتماً از ابزار Google Search استفاده کن.
نتایج واقعی را بررسی کن و پاسخ نهایی را همین حالا ارائه بده.
از پاسخ حدسی و اطلاعات قدیمی خودداری کن.
` : ""}

تاریخچه مکالمه:

${conversation}

اکنون به آخرین پیام کاربر پاسخ بده.
`;

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.GEMINI_TIMEOUT
  );

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/interactions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
          "Api-Revision": "2026-05-20"
        },

        body: JSON.stringify({
          model: cleanModel,
          input,
          tools: [
            {
              type: "google_search"
            }
          ]
        }),

        signal: controller.signal
      }
    );

    const responseText = await response.text();

    console.error("ANANAS_INTERACTIONS", {
      model: cleanModel,
      status: response.status,
      forceSearch,
      response: responseText.slice(0, 4000)
    });

    return {
      ok: response.ok,
      status: response.status,
      responseText,
      model: cleanModel
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// 9. PARSE INTERACTIONS RESPONSE
// ======================================================

function parseInteractions(json) {
  const steps = json?.steps || [];

  let answer = "";
  const sources = [];
  const queries = [];
  const annotations = [];

  let searchUsed = false;

  for (const step of steps) {

    // استخراج کوئری‌های جست‌وجو
    if (step.type === "google_search_call") {
      searchUsed = true;

      const foundQueries =
        step.arguments?.queries || [];

      queries.push(...foundQueries);
    }

    // استخراج متن نهایی
    if (step.type === "model_output") {

      for (const block of step.content || []) {

        if (block.type !== "text") continue;

        const blockText = block.text || "";

        if (blockText) {
          answer += (answer ? "\n" : "") + blockText;
        }

        for (const annotation of block.annotations || []) {

          if (annotation.type !== "url_citation") continue;

          const url = annotation.url;

          if (!url) continue;

          sources.push({
            title: annotation.title || "منبع اینترنتی",
            url
          });

          annotations.push({
            title: annotation.title || "",
            url,
            startIndex: annotation.start_index ?? null,
            endIndex: annotation.end_index ?? null
          });
        }
      }
    }
  }

  // حذف منابع تکراری
  const uniqueSources = [
    ...new Map(
      sources.map(item => [item.url, item])
    ).values()
  ];

  return {
    answer: answer.trim(),
    webSearch: {
      used: searchUsed,
      queries: unique(queries),
      sources: uniqueSources,
      citations: annotations
    }
  };
}

// ======================================================
// 10. PARSE GENERATE CONTENT GROUNDING
// ======================================================

function parseGenerateContent(json) {
  const candidate = json?.candidates?.[0];

  const metadata = candidate?.groundingMetadata;

  if (!metadata) {
    return {
      used: false,
      queries: [],
      sources: [],
      citations: []
    };
  }

  const sources = (metadata.groundingChunks || [])
    .filter(item => item.web?.uri)
    .map(item => ({
      title: item.web.title || "منبع اینترنتی",
      url: item.web.uri
    }));

  const uniqueSources = [
    ...new Map(
      sources.map(item => [item.url, item])
    ).values()
  ];

  return {
    used:
      (metadata.webSearchQueries || []).length > 0 ||
      uniqueSources.length > 0,

    queries: metadata.webSearchQueries || [],

    sources: uniqueSources,

    citations: metadata.groundingSupports || []
  };
}

// ======================================================
// 11. GROQ FALLBACK
// ======================================================

async function callGroq(apiKey, contents, systemPrompt) {
  const messages = [
    {
      role: "system",
      content: systemPrompt
    }
  ];

  (contents || []).forEach(item => {
    const text = (item.parts || [])
      .map(part => part.text || "")
      .filter(Boolean)
      .join("\n");

    if (!text.trim()) return;

    messages.push({
      role: item.role === "user" ? "user" : "assistant",
      content: text
    });
  });

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    CONFIG.GROQ_TIMEOUT
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
          model: CONFIG.GROQ_MODEL,
          messages,
          temperature: 0.7
        }),

        signal: controller.signal
      }
    );

    const responseText = await response.text();

    if (!response.ok) {
      console.error("ANANAS_GROQ_ERROR", {
        status: response.status,
        response: responseText.slice(0, 2000)
      });

      return null;
    }

    const result = JSON.parse(responseText);

    const answer =
      result.choices?.[0]?.message?.content || "";

    if (!answer.trim()) return null;

    return {
      candidates: [{
        content: {
          role: "model",
          parts: [{
            text: answer
          }]
        }
      }],

      provider: {
        name: "Groq",
        model: CONFIG.GROQ_MODEL
      },

      webSearch: {
        used: false,
        queries: [],
        sources: [],
        citations: []
      }
    };

  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// 12. GET REQUEST - QUOTA
// ======================================================

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
      quota: quotaResponse(quota)
    });

  } catch (error) {
    console.error("ANANAS_GET_ERROR", error);

    return jsonResponse({
      error: {
        message: "خطا در بررسی سهمیه کاربر."
      }
    }, 500);
  }
}

// ======================================================
// 13. MAIN POST REQUEST
// ======================================================

export async function onRequestPost(context) {
  const { request, env } = context;

  try {

    // -----------------------------------------------
    // دریافت اطلاعات درخواست
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
          message: "ساختار درخواست معتبر نیست."
        }
      }, 400);
    }

    // -----------------------------------------------
    // بررسی API Key
    // -----------------------------------------------

    const apiKey = env.GEMINI_API_KEY;

    if (!apiKey) {
      return jsonResponse({
        error: {
          message: "کلید GEMINI_API_KEY در Cloudflare تعریف نشده است."
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
            `سهمیه امروز شما (${quota.limitText} پیام) به پایان رسیده است.` +
            (!quota.isPro
              ? " برای دریافت ۱۰۰ پیام روزانه، کد فعال‌سازی پرو تهیه کنید."
              : "")
        },

        quota: quotaResponse(quota)

      }, 429);
    }

    // -----------------------------------------------
    // بررسی ضمیمه‌ها
    // -----------------------------------------------

    const payload = structuredClone(originalPayload);

    const contents = payload.contents;

    const attachmentExists = hasAttachments(contents);

    // -----------------------------------------------
    // محدودیت کاربران رایگان
    // -----------------------------------------------

    if (!quota.isPro && (attachmentExists || mode === "coder")) {
      return jsonResponse({
        error: {
          message:
            "امکان ضمیمه کردن فایل و استفاده از بخش تخصصی کدنویس ویژه کاربران پرو است."
        },

        quota: quotaResponse(quota)

      }, 403);
    }

    // -----------------------------------------------
    // ساخت System Prompt
    // -----------------------------------------------

    const systemPrompt = createSystemPrompt(mode);

    const lastUserMessage = getLastUserMessage(contents);

    const needsFreshSearch =
      requiresFreshSearch(lastUserMessage);

    let responseJson = null;
    let geminiResult = false;
    let searchUsed = false;

    let lastError = null;

    // =================================================
    // 14. TEXT REQUESTS - INTERACTIONS API
    // =================================================

    // مسیر جدید برای جست‌وجوی خودکار
    // برای درخواست‌های متنی از Interactions استفاده می‌شود.

    if (!attachmentExists) {

      try {

        const result = await callInteractions(
          model || CONFIG.DEFAULT_MODEL,
          apiKey,
          contents,
          systemPrompt,
          needsFreshSearch
        );

        if (result.ok) {

          const raw = JSON.parse(result.responseText);

          const parsed = parseInteractions(raw);

          const validAnswer =
            parsed.answer &&
            !isPendingAnswer(parsed.answer) &&
            !isKnowledgeFailure(parsed.answer);

          const validSearch =
            parsed.webSearch.used;

          if (validAnswer) {

            // اگر موضوع نیازمند اطلاعات روز است،
            // وجود جست‌وجوی واقعی الزامی است.

            if (!needsFreshSearch || validSearch) {

              responseJson = {
                candidates: [{
                  content: {
                    role: "model",
                    parts: [{
                      text: parsed.answer
                    }]
                  }
                }],

                webSearch: parsed.webSearch,

                provider: {
                  name: "Gemini",
                  model: result.model,
                  api: "Interactions"
                }
              };

              geminiResult = true;
              searchUsed = validSearch;

            }

          }

        } else {

          lastError = {
            status: result.status,
            response: result.responseText
          };

        }

      } catch (error) {

        lastError = {
          message: error.message
        };

        console.error(
          "ANANAS_INTERACTIONS_EXCEPTION",
          error
        );

      }

    }

    // =================================================
    // 15. GEMINI GENERATE CONTENT FALLBACK
    // =================================================

    // این مسیر برای فایل‌ها، تصاویر و مواقعی است
    // که Interactions API پاسخ موفق نداده است.

    if (!geminiResult) {

      const models = unique([
        model || CONFIG.DEFAULT_MODEL,
        ...CONFIG.GEMINI_FALLBACK_MODELS
      ]);

      for (const targetModel of models) {

        try {

          const result = await callGenerateContent(
            targetModel,
            apiKey,
            payload,
            systemPrompt,
            CONFIG.ENABLE_SEARCH
          );

          if (!result.ok) {

            lastError = {
              status: result.status,
              response: result.responseText
            };

            continue;
          }

          const raw = JSON.parse(result.responseText);

          const answer = getGeminiText(raw);

          const grounding = parseGenerateContent(raw);

          if (
            !answer ||
            isPendingAnswer(answer) ||
            isKnowledgeFailure(answer)
          ) {
            continue;
          }

          // سؤال روز بدون منابع پذیرفته نمی‌شود.
          if (needsFreshSearch && !grounding.used) {
            continue;
          }

          responseJson = raw;

          responseJson.webSearch = grounding;

          responseJson.provider = {
            name: "Gemini",
            model: result.model,
            api: "generateContent"
          };

          geminiResult = true;
          searchUsed = grounding.used;

          break;

        } catch (error) {

          lastError = {
            message: error.message
          };

          console.error(
            "ANANAS_GENERATE_CONTENT_EXCEPTION",
            targetModel,
            error
          );

        }

      }

    }

    // =================================================
    // 16. REQUIRED SEARCH FAILURE
    // =================================================

    // برای سؤالات نیازمند اطلاعات روز، اطلاعات قدیمی
    // یا پاسخ بدون جست‌وجو تحویل داده نمی‌شود.

    if (!geminiResult && needsFreshSearch) {

      console.error(
        "ANANAS_REQUIRED_SEARCH_FAILED",
        lastError
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

        quota: quotaResponse(quota)

      }, 503);

    }

    // =================================================
    // 17. GROQ FALLBACK
    // =================================================

    if (!geminiResult && CONFIG.ENABLE_GROQ) {

      const groqKey = env.GROQ_API_KEY;

      // ضمیمه‌ها را به Groq ارسال نمی‌کنیم.
      if (groqKey && !attachmentExists) {

        try {

          responseJson = await callGroq(
            groqKey,
            contents,
            systemPrompt
          );

        } catch (error) {

          console.error("ANANAS_GROQ_EXCEPTION", error);

        }

      }

    }

    // =================================================
    // 18. FINAL ERROR
    // =================================================

    if (!responseJson) {

      return jsonResponse({

        error: {
          message:
            "در حال حاضر امکان دریافت پاسخ وجود ندارد. لطفاً دوباره تلاش کنید."
        },

        quota: quotaResponse(quota)

      }, 502);

    }

    // =================================================
    // 19. SAVE QUOTA
    // =================================================

    await saveQuota(
      context,
      env,
      quota
    );

    responseJson.quota = quotaResponse(quota);

    // =================================================
    // 20. FINAL RESPONSE
    // =================================================

    return jsonResponse(responseJson, 200);

  } catch (error) {

    console.error("ANANAS_INTERNAL_ERROR", error);

    return jsonResponse({

      error: {
        message:
          "خطای داخلی سرور. لطفاً چند لحظه دیگر دوباره تلاش کنید."
      }

    }, 500);

  }
}

// ======================================================
// 21. OPTIONS
// ======================================================

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders
  });
}
