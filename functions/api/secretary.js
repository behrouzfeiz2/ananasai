const SITE_ORIGIN = "https://ananasai.ir";
const GOOGLE_REDIRECT_URI = SITE_ORIGIN + "/api/secretary?action=callback";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.events.owned"
].join(" ");

const headers = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
const redirect = url => Response.redirect(url, 302);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const encode64 = bytes => { let binary = ""; for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte); return btoa(binary); };
const decode64 = value => Uint8Array.from(atob(value), char => char.charCodeAt(0));
const fromBase64Url = value => String(value || "").replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(value || "").length + 3) % 4);
const toBase64Url = bytes => encode64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

async function sha256(value) { return encode64(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function encryptionKey(secret) {
  if (!secret || String(secret).length < 32) throw new Error("کلید رمزنگاری توکن گوگل در Cloudflare تنظیم نشده است.");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(value, secret) {
  const key = await encryptionKey(secret), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return { iv: encode64(iv), data: encode64(data) };
}
async function decrypt(value, secret) {
  const key = await encryptionKey(secret);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(value.iv) }, key, decode64(value.data));
  return decoder.decode(data);
}
async function getAccount(request, env) {
  const token = (request.headers.get("X-User-Token") || "").trim();
  if (!token || token.length > 256 || !env.ANANAS_KV) return { error: "برای استفاده از منشی هوشمند باید با اشتراک Pro یا Ultra وارد شوید.", status: 401 };
  const raw = await env.ANANAS_KV.get(token);
  if (!raw) return { error: "اشتراک معتبر نیست یا در دسترس نیست.", status: 401 };
  let data;
  try { data = JSON.parse(raw); } catch { return { error: "اطلاعات اشتراک قابل تأیید نیست.", status: 401 }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "ساختار اطلاعات اشتراک معتبر نیست.", status: 401 };
  if (data.tier && !["pro", "ultra"].includes(data.tier)) return { error: "این قابلیت برای اشتراک Pro یا Ultra فعال است.", status: 403 };
  return { token, tier: data.tier === "ultra" || token.startsWith("ULTRA-") ? "ultra" : "pro" };
}
function googleConfigured(env) { return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_ENCRYPTION_KEY && env.ANANAS_KV); }
async function googleLinkKey(token) { return "google_link:" + await sha256(token); }
async function getStoredGoogleLink(env, token) {
  const key = await googleLinkKey(token), raw = await env.ANANAS_KV.get(key);
  if (!raw) return { key, data: null };
  try { return { key, data: JSON.parse(raw) }; } catch { return { key, data: null }; }
}
async function refreshGoogleToken(env, key, current, force = false) {
  if (!current || !current.refresh_encrypted) {
    const error = new Error("اتصال گوگل منقضی شده است. حساب گوگل را دوباره متصل کنید."); error.status = 401; throw error;
  }
  if (!force && Number.isFinite(current.expires_at) && current.expires_at > Date.now() + 60000) {
    return { token: await decrypt(current.access_encrypted, env.GOOGLE_TOKEN_ENCRYPTION_KEY), data: current, key };
  }
  const refreshToken = await decrypt(current.refresh_encrypted, env.GOOGLE_TOKEN_ENCRYPTION_KEY);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refreshToken }).toString()
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.access_token) {
    const error = new Error("تمدید دسترسی گوگل ناموفق بود. اتصال حساب را دوباره برقرار کنید."); error.status = 401; throw error;
  }
  const updated = {
    ...current,
    access_encrypted: await encrypt(result.access_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY),
    refresh_encrypted: result.refresh_token ? await encrypt(result.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY) : current.refresh_encrypted,
    expires_at: Date.now() + (Number(result.expires_in) || 3600) * 1000,
    updated_at: Date.now()
  };
  await env.ANANAS_KV.put(key, JSON.stringify(updated));
  return { token: result.access_token, data: updated, key };
}
async function getGoogleAccess(env, userToken) {
  if (!googleConfigured(env)) { const error = new Error("تنظیمات اتصال گوگل در Cloudflare کامل نشده است."); error.status = 503; throw error; }
  const stored = await getStoredGoogleLink(env, userToken);
  if (!stored.data || !stored.data.access_encrypted) { const error = new Error("ابتدا حساب گوگل را به منشی هوشمند متصل کنید."); error.status = 409; throw error; }
  if (Number.isFinite(stored.data.expires_at) && stored.data.expires_at <= Date.now() + 60000) {
    return refreshGoogleToken(env, stored.key, stored.data);
  }
  return { token: await decrypt(stored.data.access_encrypted, env.GOOGLE_TOKEN_ENCRYPTION_KEY), data: stored.data, key: stored.key };
}
async function googleFetch(env, userToken, url, options = {}) {
  const access = await getGoogleAccess(env, userToken);
  const makeRequest = token => fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: "Bearer " + token } });
  let response = await makeRequest(access.token);
  if (response.status === 401) {
    const raw = await env.ANANAS_KV.get(access.key);
    if (!raw) throw new Error("اتصال گوگل پیدا نشد.");
    const refreshed = await refreshGoogleToken(env, access.key, JSON.parse(raw), true);
    response = await makeRequest(refreshed.token);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error_description || "درخواست به سرویس گوگل ناموفق بود.");
    error.status = response.status === 401 ? 401 : 502; throw error;
  }
  return payload;
}
async function handleGoogleCallback(url, env) {
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "", oauthError = url.searchParams.get("error");
  const stateKey = "google_oauth_state:" + state;
  const rawState = state ? await env.ANANAS_KV.get(stateKey) : null;
  if (!rawState || oauthError || !code) {
    if (rawState) await env.ANANAS_KV.delete(stateKey);
    return redirect(new URL("/index.html?mode=secretary&google_error=" + encodeURIComponent(oauthError || "state"), SITE_ORIGIN));
  }
  await env.ANANAS_KV.delete(stateKey);
  const stateData = JSON.parse(rawState);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code" }).toString()
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token) return redirect(new URL("/index.html?mode=secretary&google_error=token", SITE_ORIGIN));
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tokens.access_token } });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.email) return redirect(new URL("/index.html?mode=secretary&google_error=profile", SITE_ORIGIN));
  const key = "google_link:" + stateData.token_hash;
  const previousRaw = await env.ANANAS_KV.get(key);
  let previous = null; try { previous = previousRaw ? JSON.parse(previousRaw) : null; } catch {}
  const record = {
    access_encrypted: await encrypt(tokens.access_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY),
    refresh_encrypted: tokens.refresh_token ? await encrypt(tokens.refresh_token, env.GOOGLE_TOKEN_ENCRYPTION_KEY) : previous?.refresh_encrypted || null,
    expires_at: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
    email: String(profile.email).slice(0, 254),
    name: String(profile.name || "").slice(0, 120),
    scopes: String(tokens.scope || GOOGLE_SCOPES).split(" "),
    connected_at: previous?.connected_at || Date.now(),
    updated_at: Date.now()
  };
  if (!record.refresh_encrypted) return redirect(new URL("/index.html?mode=secretary&google_error=offline", SITE_ORIGIN));
  await env.ANANAS_KV.put(key, JSON.stringify(record));
  return redirect(new URL("/index.html?mode=secretary&google=connected", SITE_ORIGIN));
}
async function handleGet({ request, env }) {
  const url = new URL(request.url), action = url.searchParams.get("action") || "";
  try {
    if (action === "callback") return handleGoogleCallback(url, env);
    const account = await getAccount(request, env);
    if (account.error) return json({ error: account.error }, account.status);
    if (action === "connect") {
      if (!googleConfigured(env)) return json({ error: "متغیرهای GOOGLE_CLIENT_ID، GOOGLE_CLIENT_SECRET و GOOGLE_TOKEN_ENCRYPTION_KEY در Cloudflare تنظیم نشده‌اند." }, 503);
      const state = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
      await env.ANANAS_KV.put("google_oauth_state:" + state, JSON.stringify({ token_hash: await sha256(account.token), created_at: Date.now() }), { expirationTtl: 600 });
      const oauthUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      oauthUrl.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      oauthUrl.searchParams.set("redirect_uri", GOOGLE_REDIRECT_URI);
      oauthUrl.searchParams.set("response_type", "code");
      oauthUrl.searchParams.set("scope", GOOGLE_SCOPES);
      oauthUrl.searchParams.set("access_type", "offline");
      oauthUrl.searchParams.set("prompt", "consent");
      oauthUrl.searchParams.set("include_granted_scopes", "true");
      oauthUrl.searchParams.set("state", state);
      return json({ url: oauthUrl.toString() });
    }
    if (action === "status") {
      const stored = await getStoredGoogleLink(env, account.token);
      return json({ configured: googleConfigured(env), connected: Boolean(stored.data?.access_encrypted), email: stored.data?.email || null, tier: account.tier });
    }
    return json({ error: "درخواست ناشناخته است." }, 404);
  } catch (error) {
    console.error("ANANAS_SECRETARY_GET", error);
    return json({ error: error.message || "خطای منشی هوشمند" }, error.status || 500);
  }
}
function decodeBase64UrlText(value) {
  if (!value) return "";
  const binary = atob(fromBase64Url(value));
  return decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}
function stripHtml(value) {
  return String(value || "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function findEmailBody(payload) {
  let plain = "", html = "";
  const visit = part => {
    if (!part) return;
    const mime = String(part.mimeType || "").toLowerCase(), data = part.body?.data;
    if (data && mime === "text/plain" && !plain) plain = decodeBase64UrlText(data);
    if (data && mime === "text/html" && !html) html = decodeBase64UrlText(data);
    for (const child of part.parts || []) visit(child);
  };
  visit(payload);
  return (plain || stripHtml(html) || "").slice(0, 6500);
}
function headerValue(list, name) {
  const found = (list || []).find(item => String(item.name || "").toLowerCase() === name.toLowerCase());
  return found?.value || "";
}
async function listEmails(env, userToken, query, maxResults) {
  const search = new URLSearchParams({ maxResults: String(Math.min(8, Math.max(1, Number(maxResults) || 6))), q: String(query || "in:inbox").slice(0, 500) });
  const listed = await googleFetch(env, userToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages?" + search.toString());
  const emails = await Promise.all((listed.messages || []).slice(0, 8).map(async item => {
    const message = await googleFetch(env, userToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(item.id) + "?format=full");
    const h = message.payload?.headers || [];
    return {
      id: message.id, threadId: message.threadId, from: headerValue(h, "From"), to: headerValue(h, "To"),
      subject: headerValue(h, "Subject") || "(بدون موضوع)", date: headerValue(h, "Date"),
      snippet: String(message.snippet || "").slice(0, 900), body: findEmailBody(message.payload).slice(0, 6500),
      url: "https://mail.google.com/mail/u/0/#all/" + encodeURIComponent(message.id)
    };
  }));
  return { emails, resultSizeEstimate: listed.resultSizeEstimate || emails.length };
}
function utf8Base64(value) { return encode64(encoder.encode(String(value || ""))); }
async function sendEmail(env, userToken, email) {
  const to = String(email?.to || "").trim(), subject = String(email?.subject || "").trim(), body = String(email?.body || "").trim();
  if (!to || !subject || !body) throw new Error("گیرنده، موضوع و متن ایمیل باید کامل باشند.");
  if (to.length > 500 || /[\r\n]/.test(to) || subject.length > 250 || /[\r\n]/.test(subject) || body.length > 30000) throw new Error("یکی از بخش‌های ایمیل بیش از حد مجاز یا نامعتبر است.");
  const recipients = to.split(",").map(item => item.trim()).filter(Boolean);
  const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
  if (!recipients.length || recipients.some(item => !emailPattern.test(item))) throw new Error("آدرس گیرنده ایمیل معتبر نیست.");
  const subjectEncoded = "=?UTF-8?B?" + utf8Base64(subject) + "?=";
  const bodyBase64 = utf8Base64(body.replace(/\r?\n/g, "\r\n"));
  const wrappedBody = bodyBase64.match(/.{1,76}/g)?.join("\r\n") || "";
  const mime = ["To: " + recipients.join(", "), "Subject: " + subjectEncoded, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrappedBody].join("\r\n");
  return googleFetch(env, userToken, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ raw: toBase64Url(encoder.encode(mime)) })
  });
}
function normalizeEvent(event) {
  const summary = String(event?.summary || "").trim().slice(0, 250);
  if (!summary) throw new Error("عنوان یادآوری مشخص نشده است.");
  const timeZone = String(event.timeZone || "Europe/Amsterdam").slice(0, 80), start = {}, end = {};
  if (event.startDate && event.endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(event.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(event.endDate) || event.endDate <= event.startDate) throw new Error("بازه تاریخ یادآوری معتبر نیست.");
    start.date = event.startDate; end.date = event.endDate;
  } else {
    const startDateTime = String(event.startDateTime || "").trim(), endDateTime = String(event.endDateTime || "").trim();
    if (!startDateTime || !endDateTime || !Number.isFinite(Date.parse(startDateTime)) || !Number.isFinite(Date.parse(endDateTime)) || Date.parse(endDateTime) <= Date.parse(startDateTime)) throw new Error("تاریخ و ساعت شروع و پایان یادآوری باید مشخص و معتبر باشند.");
    start.dateTime = startDateTime; start.timeZone = timeZone; end.dateTime = endDateTime; end.timeZone = timeZone;
  }
  const reminders = Array.isArray(event.remindersMinutes) ? event.remindersMinutes.map(Number).filter(value => Number.isInteger(value) && value >= 0 && value <= 40320).slice(0, 5) : [];
  return {
    summary, description: String(event.description || "").slice(0, 4000), start, end,
    reminders: reminders.length ? { useDefault: false, overrides: reminders.map(minutes => ({ method: "popup", minutes })) } : { useDefault: true }
  };
}
async function createCalendarEvent(env, userToken, input) {
  const result = await googleFetch(env, userToken, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(normalizeEvent(input))
  });
  return { id: result.id, summary: result.summary, htmlLink: result.htmlLink, start: result.start, end: result.end };
}
async function listCalendarEvents(env, userToken, maxResults) {
  const params = new URLSearchParams({ timeMin: new Date().toISOString(), maxResults: String(Math.min(15, Math.max(1, Number(maxResults) || 10))), singleEvents: "true", orderBy: "startTime" });
  const result = await googleFetch(env, userToken, "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + params.toString());
  return (result.items || []).map(item => ({ summary: item.summary || "(بدون عنوان)", description: String(item.description || "").slice(0, 700), start: item.start?.dateTime || item.start?.date || "", end: item.end?.dateTime || item.end?.date || "", htmlLink: item.htmlLink || "" }));
}
async function handleHistoryAction(env, account, body) {
  const accountHash = await sha256(account.token), indexKey = "secretary_history_index:" + accountHash;
  const recordKey = id => "secretary_history_record:" + accountHash + ":" + id;
  const validId = value => /^sec_[A-Za-z0-9_-]{8,60}$/.test(String(value || ""));
  const rawIndex = await env.ANANAS_KV.get(indexKey);
  let index = []; try { index = rawIndex ? JSON.parse(rawIndex) : []; } catch {}
  if (!Array.isArray(index)) index = [];
  const action = body.action;
  if (action === "history_list") return json({ conversations: index.filter(item => item && validId(item.id)).sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0)).slice(0, 50) });
  const id = String(body.id || body.conversation?.id || "");
  if (!validId(id)) return json({ error: "شناسه گفتگوی منشی معتبر نیست." }, 400);
  const storageKey = recordKey(id);
  if (action === "history_get") {
    const raw = await env.ANANAS_KV.get(storageKey);
    if (!raw) return json({ error: "گفتگوی منشی پیدا نشد." }, 404);
    return json({ conversation: JSON.parse(raw) });
  }
  if (action === "history_delete") {
    await env.ANANAS_KV.delete(storageKey);
    index = index.filter(item => item?.id !== id);
    await env.ANANAS_KV.put(indexKey, JSON.stringify(index));
    return json({ deleted: true, id });
  }
  const incoming = body.conversation;
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || incoming.id !== id) return json({ error: "ساختار اطلاعات گفتگوی منشی معتبر نیست." }, 400);
  const inputMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
  if (inputMessages.length > 120) return json({ error: "تعداد پیام‌های گفتگو بیش از حد مجاز است." }, 413);
  let total = 0; const messages = [];
  for (const message of inputMessages) {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") return json({ error: "ساختار پیام گفتگوی منشی معتبر نیست." }, 400);
    const content = message.content.slice(0, 7000); total += content.length;
    if (total > 100000) return json({ error: "حجم تاریخچه گفتگوی منشی بیش از حد مجاز است." }, 413);
    const saved = { role: message.role, content };
    if (message.secretaryAction && ["email_preview", "event_preview", "connect"].includes(message.secretaryAction.type)) saved.secretaryAction = message.secretaryAction;
    messages.push(saved);
  }
  const now = Date.now(), firstRequest = messages.find(message => message.role === "user")?.content || "";
  const title = String(incoming.title || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120) || firstRequest.replace(/\s+/g, " ").slice(0, 58) || "گفتگوی منشی";
  const conversation = {
    id, title, created_at: Number(incoming.created_at) || now, updated_at: now, messages,
    pendingAction: incoming.pendingAction && ["email", "event"].includes(incoming.pendingAction.type) ? incoming.pendingAction : null
  };
  await env.ANANAS_KV.put(storageKey, JSON.stringify(conversation));
  index = index.filter(item => item?.id !== id);
  index.unshift({ id, title, created_at: conversation.created_at, updated_at: now });
  await env.ANANAS_KV.put(indexKey, JSON.stringify(index.slice(0, 60)));
  return json({ saved: true, conversation: { id, title, updated_at: now } });
}
async function handlePost({ request, env }) {
  try {
    const account = await getAccount(request, env);
    if (account.error) return json({ error: account.error }, account.status);
    if (Number(request.headers.get("Content-Length") || 0) > 180000) return json({ error: "حجم درخواست بیش از حد مجاز است." }, 413);
    let body; try { body = await request.json(); } catch { return json({ error: "بدنه درخواست JSON معتبر نیست." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "ساختار درخواست معتبر نیست." }, 400);
    if (["history_list", "history_get", "history_save", "history_delete", "history_rename"].includes(body.action)) return handleHistoryAction(env, account, body);
    if (body.action === "disconnect") {
      const stored = await getStoredGoogleLink(env, account.token);
      if (stored.data?.refresh_encrypted) {
        try {
          const refresh = await decrypt(stored.data.refresh_encrypted, env.GOOGLE_TOKEN_ENCRYPTION_KEY);
          await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refresh }).toString() });
        } catch {}
      }
      await env.ANANAS_KV.delete(stored.key);
      return json({ disconnected: true });
    }
    if (body.action === "list_emails") return json(await listEmails(env, account.token, body.query, body.maxResults));
    if (body.action === "send_email") {
      const result = await sendEmail(env, account.token, body.email || {});
      return json({ sent: true, id: result.id, threadId: result.threadId });
    }
    if (body.action === "create_event") return json({ created: true, event: await createCalendarEvent(env, account.token, body.event || {}) });
    if (body.action === "list_events") return json({ events: await listCalendarEvents(env, account.token, body.maxResults) });
    return json({ error: "درخواست ناشناخته است." }, 404);
  } catch (error) {
    console.error("ANANAS_SECRETARY_POST", error);
    return json({ error: error.message || "خطای منشی هوشمند" }, error.status || 500);
  }
}
export async function onRequestGet(context) {
  const origin = context.request.headers.get("Origin");
  if (origin && origin !== SITE_ORIGIN) return json({ error: "Origin نامعتبر است." }, 403);
  return handleGet(context);
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
