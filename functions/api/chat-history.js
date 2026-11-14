const SITE_ORIGIN = "https://ananasai.ir";
const HISTORY_TTL = 180 * 24 * 60 * 60;
const FREE_HISTORY_TTL = 5 * 24 * 60 * 60;
const FREE_DEVICE_UUID_PATTERN = /^dev_[a-z0-9]{6,80}$/i;
const CHAT_HISTORY_LIMITS = Object.freeze({
  free: { maxMessageCharacters: 7000, maxMessages: 70, maxConversationCharacters: 28000, maxConversations: 7 },
  pro: { maxMessageCharacters: 14000, maxMessages: 112, maxConversationCharacters: 56000, maxConversations: 42 },
  ultra: { maxMessageCharacters: 21000, maxMessages: 126, maxConversationCharacters: 84000, maxConversations: 70 }
});
const headers = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const encoder = new TextEncoder();

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function getAccount(request, env) {
  if (!env.ANANAS_KV) return { error: "سرویس ذخیره تاریخچه در دسترس نیست.", status: 503 };
  const token = (request.headers.get("X-User-Token") || "").trim();
  if (!token) {
    const uuid = (request.headers.get("X-Device-UUID") || "").trim();
    if (!FREE_DEVICE_UUID_PATTERN.test(uuid)) {
      return { error: "شناسه UUID دستگاه برای حساب رایگان معتبر نیست.", status: 401 };
    }
    return { uuid, tier: "free" };
  }
  if (token.length > 256) return { error: "کد اشتراک معتبر نیست.", status: 401 };
  const raw = await env.ANANAS_KV.get(token);
  if (!raw) return { error: "کد اشتراک معتبر نیست یا منقضی شده است.", status: 401 };
  let data;
  try { data = JSON.parse(raw); } catch {
    return { error: "اطلاعات اشتراک قابل تأیید نیست.", status: 401 };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      (data.tier && !["pro", "ultra"].includes(data.tier))) {
    return { error: "ساختار اطلاعات اشتراک معتبر نیست.", status: 401 };
  }
  return { token, tier: data.tier === "ultra" || token.startsWith("ULTRA-") ? "ultra" : "pro" };
}

async function touchFreeUser(env, account) {
  if (account.tier !== "free") return;
  const key = "free_user:" + await sha256Hex("free:" + account.uuid);
  const now = Date.now();
  let previous = null;
  try {
    const raw = await env.ANANAS_KV.get(key);
    previous = raw ? JSON.parse(raw) : null;
  } catch {}
  if (previous && now - (Number(previous.last_seen) || 0) < 60 * 60 * 1000) return;
  await env.ANANAS_KV.put(key, JSON.stringify({
    uuid: account.uuid,
    created_at: Number(previous?.created_at) || now,
    last_seen: now
  }), { expirationTtl: FREE_HISTORY_TTL });
}

function validId(value) {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(value || ""));
}

async function listAccountRecords(kv, prefix) {
  const summaries = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const item of page.keys || []) {
      const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      const id = item.name.slice(prefix.length);
      if (!validId(id)) continue;
      summaries.push({
        id,
        title: String(metadata.title || "گفتگوی بدون عنوان"),
        created_at: Number(metadata.created_at) || 0,
        updated_at: Number(metadata.updated_at) || Number(item.expiration) || 0
      });
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  summaries.sort((a, b) => b.updated_at - a.updated_at);
  return summaries;
}

async function handlePost({ request, env }) {
  try {
    const account = await getAccount(request, env);
    if (account.error) return json({ error: account.error }, account.status);
    const limits = CHAT_HISTORY_LIMITS[account.tier] || CHAT_HISTORY_LIMITS.free;
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 400000) return json({ error: "حجم تاریخچه بیش از حد مجاز است." }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: "بدنه درخواست معتبر نیست." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "ساختار درخواست معتبر نیست." }, 400);

    const accountHash = await sha256Hex(account.tier === "free" ? "free:" + account.uuid : account.token);
    const historyTtl = account.tier === "free" ? FREE_HISTORY_TTL : HISTORY_TTL;
    await touchFreeUser(env, account);
    const prefix = "ananas_chat_history:" + accountHash + ":";
    const action = String(body.action || "");
    const globalPurgedAt = Number(await env.ANANAS_KV.get("admin_chat_history_purge_at")) || 0;

    if (action === "history_list") {
      const conversations = (await listAccountRecords(env.ANANAS_KV, prefix))
        .filter(item => Number(item.updated_at || item.created_at || 0) >= Date.now() - historyTtl * 1000)
        .filter(item => !globalPurgedAt || Number(item.created_at || 0) >= globalPurgedAt);
      const deletedPrefix = "ananas_chat_history_deleted:" + accountHash + ":";
      const deletedIds = [];
      let cursor;
      do {
        const page = await env.ANANAS_KV.list({ prefix: deletedPrefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const item of page.keys || []) deletedIds.push(item.name.slice(deletedPrefix.length));
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      const clearedAt = Number(await env.ANANAS_KV.get("ananas_chat_history_clear:" + accountHash)) || 0;
      return json({ conversations, deleted_ids: deletedIds, deleted_before: clearedAt, purged_before: globalPurgedAt });
    }

    if (action === "history_clear") {
      const keys = [];
      let cursor;
      do {
        const page = await env.ANANAS_KV.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const item of page.keys || []) keys.push(item.name);
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor);
      let deleted = 0;
      for (let i = 0; i < keys.length; i += 100) {
        const batch = keys.slice(i, i + 100);
        await Promise.all(batch.map(key => env.ANANAS_KV.delete(key)));
        deleted += batch.length;
      }
      const clearedAt = Date.now();
      await env.ANANAS_KV.put("ananas_chat_history_clear:" + accountHash, String(clearedAt), { expirationTtl: historyTtl });
      return json({ deleted: true, count: deleted, deleted_before: clearedAt });
    }

    const id = String(body.id || body.conversation?.id || "");
    if (!validId(id)) return json({ error: "شناسه گفتگو معتبر نیست." }, 400);
    const storageKey = prefix + id;

    if (action === "history_get") {
      const raw = await env.ANANAS_KV.get(storageKey);
      if (!raw) return json({ error: "این گفتگو پیدا نشد یا پس از پایان مهلت نگهداری تاریخچه منقضی شده است." }, 404);
      let conversation;
      try { conversation = JSON.parse(raw); } catch {
        return json({ error: "اطلاعات این گفتگو قابل بازیابی نیست." }, 500);
      }
      if (globalPurgedAt && Number(conversation.created_at || 0) < globalPurgedAt) {
        return json({ error: "این گفتگو در پاک‌سازی سراسری تاریخچه حذف شده است." }, 404);
      }
      const now = Date.now();
      conversation.updated_at = now;
      await env.ANANAS_KV.put(storageKey, JSON.stringify(conversation), {
        expirationTtl: historyTtl,
        metadata: {
          title: conversation.title || "گفتگوی بدون عنوان",
          created_at: Number(conversation.created_at) || now,
          updated_at: now
        }
      });
      return json({ conversation });
    }

    if (action === "history_delete") {
      await env.ANANAS_KV.delete(storageKey);
      await env.ANANAS_KV.put("ananas_chat_history_deleted:" + accountHash + ":" + id, "1", { expirationTtl: historyTtl });
      return json({ deleted: true, id });
    }

    if (action !== "history_save") return json({ error: "درخواست ناشناخته است." }, 404);
    const incoming = body.conversation;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || incoming.id !== id) {
      return json({ error: "ساختار گفتگو معتبر نیست." }, 400);
    }
    const incomingCreatedAt = Number(incoming.created_at) || Date.now();
    if (globalPurgedAt && incomingCreatedAt < globalPurgedAt) {
      return json({ error: "این تاریخچه در پاک‌سازی سراسری حذف شده و قابل بازیابی مجدد نیست." }, 410);
    }

    const now = Date.now();
    const inputMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
    if (inputMessages.length > limits.maxMessages) {
      return json({ error: `این گفتگو به سقف ${limits.maxMessages} پیام رسیده است. برای ادامه، گفتگوی تازه‌ای ایجاد کنید.`, code: "CHAT_MESSAGE_LIMIT", limit: limits.maxMessages }, 413);
    }

    // سقف گفتگوهای ذخیره‌شده فقط هنگام ایجاد یک رکورد جدید بررسی می‌شود.
    const existingConversation = await env.ANANAS_KV.get(storageKey);
    if (!existingConversation) {
      const activeConversations = (await listAccountRecords(env.ANANAS_KV, prefix))
        .filter(item => Number(item.updated_at || item.created_at || 0) >= now - historyTtl * 1000);
      const currentConversationIsListed = activeConversations.some(item => item.id === id);
      if (!currentConversationIsListed && activeConversations.length >= limits.maxConversations) {
        return json({
          error: `به سقف ${limits.maxConversations} گفتگوی ذخیره‌شده در پلن شما رسیده‌اید. برای ذخیره گفتگوی جدید، ابتدا یکی از گفتگوهای قبلی را حذف کنید.`,
          code: "HISTORY_CONVERSATION_LIMIT",
          limit: limits.maxConversations
        }, 409);
      }
    }

    let totalCharacters = 0;
    const messages = [];
    for (const message of inputMessages) {
      if (!message || !["user", "assistant", "model"].includes(message.role) || typeof message.text !== "string") continue;
      const text = message.text;
      const messageCharacters = Array.from(text).length;
      if (message.role === "user" && messageCharacters > limits.maxMessageCharacters) {
        return json({
          error: `طول پیام شما بیشتر از سقف ${limits.maxMessageCharacters.toLocaleString("fa-IR")} نویسه در پلن فعلی است.`,
          code: "CHAT_MESSAGE_CHARACTER_LIMIT",
          limit: limits.maxMessageCharacters
        }, 413);
      }

      const isImageAttachment = message.role === "user" &&
        typeof message.fileName === "string" &&
        typeof message.fileMime === "string" && /^image\/[a-z0-9.+-]{1,40}$/i.test(message.fileMime);
      if (!text.trim() && !isImageAttachment) continue;
      totalCharacters += messageCharacters;
      const savedMessage = { role: message.role === "user" ? "user" : "assistant", text };
      if (isImageAttachment) {
        savedMessage.fileName = message.fileName.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180) || "تصویر ضمیمه‌شده";
        savedMessage.fileMime = message.fileMime.slice(0, 80);
        if (typeof message.localImageId === "string" && /^image_[A-Za-z0-9_-]{8,100}$/.test(message.localImageId)) savedMessage.localImageId = message.localImageId;
      }
      if (message.role !== "user" && message.imageWizard && typeof message.imageWizard === "object" && !Array.isArray(message.imageWizard)) {
        const wizard = message.imageWizard;
        savedMessage.imageWizard = {
          prompt: String(wizard.prompt || "").slice(0, 4000),
          model: ["flux-dev", "z-image", "qwen-image-edit"].includes(wizard.model) ? wizard.model : null,
          step: wizard.step === "model" ? "model" : "confirm",
          hasReference: Boolean(wizard.hasReference),
          ...(Number.isInteger(Number(wizard.width)) && Number(wizard.width) >= 256 && Number(wizard.width) <= 2048 ? { width: Number(wizard.width) } : {}),
          ...(Number.isInteger(Number(wizard.height)) && Number(wizard.height) >= 256 && Number(wizard.height) <= 2048 ? { height: Number(wizard.height) } : {}),
          ...(typeof wizard.sourceLibraryId === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(wizard.sourceLibraryId) ? { sourceLibraryId: wizard.sourceLibraryId } : {})
        };
      }
      messages.push(savedMessage);
    }

    // اگر مجموع متن از سقف پلن عبور کند، قدیمی‌ترین پیام‌ها از نسخه ابری کنار گذاشته می‌شوند.
    while (messages.length > 1 && totalCharacters > limits.maxConversationCharacters) {
      const removed = messages.shift();
      totalCharacters -= Array.from(removed.text || "").length;
    }
    if (messages.length === 1 && totalCharacters > limits.maxConversationCharacters) {
      messages[0].text = Array.from(messages[0].text || "").slice(-limits.maxConversationCharacters).join("");
    }

    const firstUserMessage = messages.find(message => message.role === "user")?.text || "";
    const title = String(incoming.title || "")
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) ||
      firstUserMessage.replace(/\s+/g, " ").slice(0, 58) || "گفتگوی جدید";
    const conversation = {
      id,
      title,
      created_at: incomingCreatedAt,
      updated_at: now,
      messages
    };

    await env.ANANAS_KV.delete("ananas_chat_history_deleted:" + accountHash + ":" + id);
    await env.ANANAS_KV.put(storageKey, JSON.stringify(conversation), {
      expirationTtl: historyTtl,
      metadata: { title, created_at: conversation.created_at, updated_at: now }
    });
    return json({ saved: true, conversation: { id, title, created_at: conversation.created_at, updated_at: now } });
  } catch (error) {
    console.error("ANANAS_CHAT_HISTORY", error);
    return json({ error: error.message || "ذخیره تاریخچه گفتگو ناموفق بود." }, error.status || 500);
  }
}

export async function onRequestPost(context) {
  const origin = context.request.headers.get("Origin");
  if (origin && origin !== SITE_ORIGIN) return json({ error: "Origin نامعتبر است." }, 403);
  return handlePost(context);
}

export async function onRequestOptions({ request }) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== SITE_ORIGIN) return new Response(null, { status: 403, headers });
  return new Response(null, { status: 204, headers });
}
