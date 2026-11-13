const SITE_ORIGIN = "https://ananasai.ir";
const HISTORY_TTL = 180 * 24 * 60 * 60;
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
  const token = (request.headers.get("X-User-Token") || "").trim();
  if (!token || token.length > 256 || !env.ANANAS_KV) {
    return { error: "برای همگام‌سازی تاریخچه، ابتدا اشتراک Pro یا Ultra را فعال کنید.", status: 401 };
  }
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
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > 400000) return json({ error: "حجم تاریخچه بیش از حد مجاز است." }, 413);

    let body;
    try { body = await request.json(); } catch { return json({ error: "بدنه درخواست معتبر نیست." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "ساختار درخواست معتبر نیست." }, 400);

    const accountHash = await sha256Hex(account.token);
    const prefix = "ananas_chat_history:" + accountHash + ":";
    const action = String(body.action || "");

    if (action === "history_list") {
      const conversations = await listAccountRecords(env.ANANAS_KV, prefix);
      return json({ conversations });
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
      return json({ deleted: true, count: deleted });
    }

    const id = String(body.id || body.conversation?.id || "");
    if (!validId(id)) return json({ error: "شناسه گفتگو معتبر نیست." }, 400);
    const storageKey = prefix + id;

    if (action === "history_get") {
      const raw = await env.ANANAS_KV.get(storageKey);
      if (!raw) return json({ error: "این گفتگو پیدا نشد یا پس از شش ماه عدم فعالیت منقضی شده است." }, 404);
      let conversation;
      try { conversation = JSON.parse(raw); } catch {
        return json({ error: "اطلاعات این گفتگو قابل بازیابی نیست." }, 500);
      }
      const now = Date.now();
      conversation.updated_at = Number(conversation.updated_at) || now;
      await env.ANANAS_KV.put(storageKey, JSON.stringify(conversation), {
        expirationTtl: HISTORY_TTL,
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
      return json({ deleted: true, id });
    }

    if (action !== "history_save") return json({ error: "درخواست ناشناخته است." }, 404);
    const incoming = body.conversation;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || incoming.id !== id) {
      return json({ error: "ساختار گفتگو معتبر نیست." }, 400);
    }

    const inputMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
    if (inputMessages.length > 180) return json({ error: "تعداد پیام‌های گفتگو بیش از حد مجاز است." }, 413);
    let totalCharacters = 0;
    const messages = [];
    for (const message of inputMessages) {
      if (!message || !["user", "assistant", "model"].includes(message.role) || typeof message.text !== "string") {
        continue;
      }
      const text = message.text.slice(0, 7000);
      if (!text.trim()) continue;
      totalCharacters += text.length;
      if (totalCharacters > 140000) return json({ error: "حجم متن تاریخچه بیش از حد مجاز است." }, 413);
      messages.push({ role: message.role === "user" ? "user" : "assistant", text });
    }

    const now = Date.now();
    const firstUserMessage = messages.find(message => message.role === "user")?.text || "";
    const title = String(incoming.title || "")
      .replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) ||
      firstUserMessage.replace(/\s+/g, " ").slice(0, 58) || "گفتگوی جدید";
    const conversation = {
      id,
      title,
      created_at: Number(incoming.created_at) || now,
      updated_at: now,
      messages
    };

    await env.ANANAS_KV.put(storageKey, JSON.stringify(conversation), {
      expirationTtl: HISTORY_TTL,
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
