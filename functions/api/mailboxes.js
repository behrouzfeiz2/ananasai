import { connect } from "cloudflare:sockets";

const SITE_ORIGIN = "https://ananasai.ir";
const IMAP_HOST = "imap.hostinger.com";
const SMTP_HOST = "smtp.hostinger.com";
const IMAP_PORT = 993;
const SMTP_PORT = 465;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const headers = {
  "Access-Control-Allow-Origin": SITE_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-User-Token, X-Device-UUID",
  "Vary": "Origin",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(String(value || ""));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message || "پاسخی از سرور ایمیل دریافت نشد.")), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
function validEmail(value) {
  const email = String(value || "").trim();
  return email.length <= 254 && /^[^\s@<>;,"']+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email) && !/[\r\n]/.test(email);
}
function safeAccountName(email) { return String(email || "").trim().slice(0, 254); }
function imapQuote(value) {
  const text = String(value || "");
  if (/[\r\n\u0000]/.test(text)) throw new Error("اطلاعات ورود ایمیل شامل نویسه نامعتبر است.");
  return '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
function authBase64(value) { return bytesToBase64(encoder.encode(String(value || ""))); }
function expectReply(text, accepted, protocol) {
  const line = String(text || "").trim().split(/\r?\n/).filter(Boolean).at(-1) || "";
  const code = protocol === "smtp" ? Number(line.slice(0, 3)) : null;
  if (protocol === "smtp" && !accepted.includes(code)) {
    throw new Error("سرور SMTP درخواست را نپذیرفت (" + (code || "unknown") + ").");
  }
  if (protocol === "imap") {
    const match = text.match(/(?:^|\r?\n)(A\d{4}) (OK|NO|BAD)\b[^\r\n]*/i);
    if (!match || match[2].toUpperCase() !== "OK") {
      const detail = String(text || "").match(/(?:^|\r?\n)A\d{4} (?:NO|BAD)\b([^\r\n]*)/i);
      if (detail && /auth|login|password|credential/i.test(detail[1])) throw new Error("نام کاربری یا رمز عبور صندوق ایمیل معتبر نیست.");
      throw new Error("سرور IMAP درخواست را نپذیرفت.");
    }
  }
  return text;
}
async function readUntil(reader, detect, maxBytes = 180000, timeoutMs = 15000) {
  const chunks = [];
  let total = 0;
  while (total < maxBytes) {
    const item = await withTimeout(reader.read(), timeoutMs, "مهلت ارتباط با سرور ایمیل به پایان رسید.");
    if (item.done) throw new Error("ارتباط با سرور ایمیل پیش از دریافت پاسخ بسته شد.");
    chunks.push(item.value);
    total += item.value.length;
    const bytes = concatBytes(chunks);
    const text = decoder.decode(bytes);
    if (detect(text)) return { bytes, text };
  }
  throw new Error("پاسخ سرور ایمیل بیش از حد مجاز است.");
}
async function openSecureSocket(hostname, port) {
  const socket = connect({ hostname, port }, { secureTransport: "on" });
  await withTimeout(socket.opened, 15000, "اتصال امن به سرور ایمیل برقرار نشد.");
  return { socket, reader: socket.readable.getReader(), writer: socket.writable.getWriter() };
}
async function writeText(writer, value) { await writer.write(encoder.encode(value)); }
function smtpFinalLine(text) { return /(?:^|\r\n)\d{3} [^\r\n]*(?:\r\n)?$/.test(text); }
async function smtpRead(reader) {
  const result = await readUntil(reader, smtpFinalLine, 16000, 15000);
  const lines = result.text.trim().split(/\r?\n/);
  const last = lines[lines.length - 1] || "";
  return { code: Number(last.slice(0, 3)), text: result.text };
}
async function smtpCommand(writer, reader, command, accepted) {
  await writeText(writer, command + "\r\n");
  const reply = await smtpRead(reader);
  if (!accepted.includes(reply.code)) {
    if (reply.code === 535 || /authentication|bad credentials|username|password/i.test(reply.text)) {
      throw new Error("Hostinger SMTP نام کاربری یا رمز عبور این صندوق را نپذیرفت.");
    }
    throw new Error("خطای SMTP (" + (reply.code || "unknown") + ").");
  }
  return reply.text;
}
async function authenticateSmtp(email, password) {
  let connection;
  try {
    connection = await openSecureSocket(SMTP_HOST, SMTP_PORT);
    const greeting = await smtpRead(connection.reader);
    if (greeting.code !== 220) throw new Error("سرور SMTP آماده دریافت اتصال نیست.");
    await smtpCommand(connection.writer, connection.reader, "EHLO ananasai.ir", [250]);
    await smtpCommand(connection.writer, connection.reader, "AUTH LOGIN", [334]);
    await smtpCommand(connection.writer, connection.reader, authBase64(email), [334]);
    await smtpCommand(connection.writer, connection.reader, authBase64(password), [235]);
    await smtpCommand(connection.writer, connection.reader, "NOOP", [250]);
    await smtpCommand(connection.writer, connection.reader, "QUIT", [221]);
    return true;
  } finally {
    if (connection) {
      try { await connection.writer.close(); } catch {}
      try { await connection.socket.close(); } catch {}
    }
  }
}
async function imapCommand(writer, reader, tag, command, maxBytes = 180000) {
  await writeText(writer, tag + " " + command + "\r\n");
  const result = await readUntil(reader, text => new RegExp("(?:^|\\r?\\n)" + tag + " (?:OK|NO|BAD)\\b", "i").test(text), maxBytes, 15000);
  expectReply(result.text, null, "imap");
  return result;
}
async function authenticateImap(email, password) {
  let connection;
  try {
    connection = await openSecureSocket(IMAP_HOST, IMAP_PORT);
    const greeting = await readUntil(connection.reader, text => /^\* (?:OK|PREAUTH)\b/im.test(text), 12000, 15000);
    if (!/^\* (?:OK|PREAUTH)\b/im.test(greeting.text)) throw new Error("پاسخ آغازین سرور IMAP معتبر نیست.");
    await imapCommand(connection.writer, connection.reader, "A0001", "LOGIN " + imapQuote(email) + " " + imapQuote(password));
    await imapCommand(connection.writer, connection.reader, "A0002", "LOGOUT", 12000);
    return true;
  } finally {
    if (connection) {
      try { await connection.writer.close(); } catch {}
      try { await connection.socket.close(); } catch {}
    }
  }
}
async function verifyMailbox(email, password) {
  await authenticateImap(email, password);
  await authenticateSmtp(email, password);
  return { imap: true, smtp: true };
}
function decodeQuotedPrintable(value) {
  const input = String(value || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    if (input[i] === "=" && /^[0-9a-f]{2}$/i.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16)); i += 2;
    } else {
      const point = input.charCodeAt(i);
      if (point <= 255) bytes.push(point);
      else bytes.push(...encoder.encode(input[i]));
    }
  }
  return decoder.decode(new Uint8Array(bytes));
}
function decodeTransferBody(value, encoding) {
  const mode = String(encoding || "").toLowerCase().trim();
  if (mode === "base64") {
    try { return decoder.decode(base64ToBytes(String(value || "").replace(/\s/g, ""))); } catch { return ""; }
  }
  if (mode === "quoted-printable") return decodeQuotedPrintable(value);
  return String(value || "").replace(/\r\n/g, "\n").trim();
}
function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (whole, charset, mode, data) => {
    try {
      let bytes;
      if (mode.toLowerCase() === "b") bytes = base64ToBytes(data);
      else bytes = encoder.encode(decodeQuotedPrintable(data.replace(/_/g, " ")));
      return new TextDecoder(charset || "utf-8").decode(bytes);
    } catch { return whole; }
  });
}
function parseHeaderBlock(raw) {
  const unfolded = String(raw || "").replace(/\r?\n[ \t]+/g, " ");
  const result = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const split = line.indexOf(":");
    if (split < 1) continue;
    const name = line.slice(0, split).trim().toLowerCase();
    if (result[name] === undefined) result[name] = line.slice(split + 1).trim();
  }
  return result;
}
function decodeEmailBody(headers, body) {
  const contentType = headers["content-type"] || "text/plain";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (/multipart\//i.test(contentType) && boundaryMatch) {
    const boundary = boundaryMatch[1] || boundaryMatch[2];
    let plain = "", html = "";
    for (const part of String(body || "").split("--" + boundary)) {
      const separator = part.match(/\r?\n\r?\n/);
      if (!separator) continue;
      const splitAt = part.search(/\r?\n\r?\n/);
      const partHeaders = parseHeaderBlock(part.slice(0, splitAt));
      const partBody = part.slice(splitAt + separator[0].length).replace(/\r?\n--?$/, "").trim();
      const decoded = decodeTransferBody(partBody, partHeaders["content-transfer-encoding"]);
      const type = partHeaders["content-type"] || "";
      if (/text\/plain/i.test(type) && !plain) plain = decoded;
      if (/text\/html/i.test(type) && !html) html = decoded;
    }
    if (plain) return plain.slice(0, 6500);
    if (html) return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<\/(p|div|br|li|tr|h[1-6])>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").slice(0, 6500);
  }
  return decodeTransferBody(body, headers["content-transfer-encoding"]).slice(0, 6500);
}
function parseRawEmail(raw) {
  const normalized = String(raw || "");
  const match = normalized.match(/\r?\n\r?\n/);
  const splitAt = match ? match.index : normalized.length;
  const headerText = normalized.slice(0, splitAt);
  const body = match ? normalized.slice(splitAt + match[0].length) : "";
  const h = parseHeaderBlock(headerText);
  return {
    from: decodeMimeWords(h.from || ""),
    to: decodeMimeWords(h.to || ""),
    subject: decodeMimeWords(h.subject || "(بدون موضوع)"),
    date: h.date || "",
    snippet: body.replace(/\s+/g, " ").slice(0, 350),
    body: decodeEmailBody(h, body)
  };
}
function imapSearchCriteria(query) {
  const value = String(query || "").slice(0, 300);
  const criteria = [];
  const from = value.match(/\bfrom:([^\s]+)/i);
  const to = value.match(/\bto:([^\s]+)/i);
  const subject = value.match(/\bsubject:("[^"]+"|[^\s]+)/i);
  if (from && validEmail(from[1])) criteria.push("FROM " + imapQuote(from[1]));
  if (to && validEmail(to[1])) criteria.push("TO " + imapQuote(to[1]));
  if (subject) criteria.push("SUBJECT " + imapQuote(subject[1].replace(/^"|"$/g, "")));
  return criteria.length ? criteria.join(" ") : "ALL";
}
async function listMailboxMessages(email, password, query, maxResults) {
  let connection;
  try {
    connection = await openSecureSocket(IMAP_HOST, IMAP_PORT);
    const greeting = await readUntil(connection.reader, text => /^\* (?:OK|PREAUTH)\b/im.test(text), 12000, 15000);
    if (!/^\* (?:OK|PREAUTH)\b/im.test(greeting.text)) throw new Error("پاسخ آغازین سرور IMAP معتبر نیست.");
    await imapCommand(connection.writer, connection.reader, "A0001", "LOGIN " + imapQuote(email) + " " + imapQuote(password));
    await imapCommand(connection.writer, connection.reader, "A0002", "SELECT INBOX");
    const search = await imapCommand(connection.writer, connection.reader, "A0003", "UID SEARCH " + imapSearchCriteria(query));
    const searchLine = search.text.match(/\* SEARCH([^\r\n]*)/i);
    const uids = (searchLine ? searchLine[1].trim().split(/\s+/) : []).filter(value => /^\d+$/.test(value));
    const selected = uids.slice(-Math.max(1, Math.min(8, Number(maxResults) || 6))).reverse();
    const emails = [];
    for (let index = 0; index < selected.length; index++) {
      const response = await imapCommand(connection.writer, connection.reader, "A" + String(index + 4).padStart(4, "0"), "UID FETCH " + selected[index] + " (BODY.PEEK[]<0.16000>)", 40000);
      const marker = response.text.match(/BODY\[\](?:<\d+>)?\s+\{(\d+)\}\r\n/i);
      if (!marker) continue;
      const prefixLength = encoder.encode(response.text.slice(0, marker.index + marker[0].length)).length;
      const messageLength = Math.min(Number(marker[1]) || 0, 16000);
      const raw = decoder.decode(response.bytes.slice(prefixLength, prefixLength + messageLength));
      emails.push({ id: selected[index], ...parseRawEmail(raw), url: "" });
    }
    try { await imapCommand(connection.writer, connection.reader, "A9998", "LOGOUT", 12000); } catch {}
    return { emails, resultSizeEstimate: uids.length };
  } finally {
    if (connection) {
      try { await connection.writer.close(); } catch {}
      try { await connection.socket.close(); } catch {}
    }
  }
}
function wrapBase64(value) { return String(value || "").match(/.{1,76}/g)?.join("\r\n") || ""; }
async function sendMailboxMessage(email, password, input) {
  const to = String(input?.to || "").trim();
  const subject = String(input?.subject || "").trim();
  const body = String(input?.body || "").trim();
  if (!to || !subject || !body) throw new Error("گیرنده، موضوع و متن ایمیل باید کامل باشند.");
  if (to.length > 500 || /[\r\n]/.test(to) || subject.length > 250 || /[\r\n]/.test(subject) || body.length > 30000) throw new Error("یکی از بخش‌های ایمیل بیش از حد مجاز یا نامعتبر است.");
  const recipients = to.split(",").map(item => item.trim()).filter(Boolean);
  if (!recipients.length || recipients.length > 10 || recipients.some(item => !validEmail(item))) throw new Error("آدرس گیرنده ایمیل معتبر نیست.");
  const messageId = "<" + crypto.randomUUID() + "@ananasai.ir>";
  const rawBody = wrapBase64(bytesToBase64(encoder.encode(body.replace(/\r?\n/g, "\r\n"))));
  const mime = [
    "From: " + email,
    "To: " + recipients.join(", "),
    "Subject: =?UTF-8?B?" + bytesToBase64(encoder.encode(subject)) + "?=",
    "Date: " + new Date().toUTCString(),
    "Message-ID: " + messageId,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    rawBody
  ].join("\r\n");
  let connection;
  try {
    connection = await openSecureSocket(SMTP_HOST, SMTP_PORT);
    const greeting = await smtpRead(connection.reader);
    if (greeting.code !== 220) throw new Error("سرور SMTP آماده ارسال نیست.");
    await smtpCommand(connection.writer, connection.reader, "EHLO ananasai.ir", [250]);
    await smtpCommand(connection.writer, connection.reader, "AUTH LOGIN", [334]);
    await smtpCommand(connection.writer, connection.reader, authBase64(email), [334]);
    await smtpCommand(connection.writer, connection.reader, authBase64(password), [235]);
    await smtpCommand(connection.writer, connection.reader, "MAIL FROM:<" + email + ">", [250]);
    for (const recipient of recipients) await smtpCommand(connection.writer, connection.reader, "RCPT TO:<" + recipient + ">", [250, 251]);
    await smtpCommand(connection.writer, connection.reader, "DATA", [354]);
    await writeText(connection.writer, mime.replace(/(^|\r\n)\./g, "$1..") + "\r\n.\r\n");
    const accepted = await smtpRead(connection.reader);
    if (accepted.code !== 250) throw new Error("سرور SMTP پیام را برای ارسال نپذیرفت (" + (accepted.code || "unknown") + ").");
    try { await smtpCommand(connection.writer, connection.reader, "QUIT", [221]); } catch {}
    return { accepted: true, messageId, recipients };
  } finally {
    if (connection) {
      try { await connection.writer.close(); } catch {}
      try { await connection.socket.close(); } catch {}
    }
  }
}
async function accountHash(token) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
}
async function encryptionKey(env, source) {
  const keySource = source || (env.MAILBOX_ENCRYPTION_KEY ? "mailbox" : "google");
  const secret = keySource === "mailbox" ? env.MAILBOX_ENCRYPTION_KEY : env.GOOGLE_TOKEN_ENCRYPTION_KEY;
  if (!secret || String(secret).length < 32) throw new Error("کلید رمزنگاری سرور تنظیم نشده است. کلید MAILBOX_ENCRYPTION_KEY یا GOOGLE_TOKEN_ENCRYPTION_KEY را در Cloudflare تنظیم کنید.");
  const raw = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return { key: await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]), source: keySource };
}
async function encryptPassword(password, env) {
  const material = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, material.key, encoder.encode(password));
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(data)), key_source: material.source };
}
async function decryptPassword(encrypted, env) {
  const material = await encryptionKey(env, encrypted.key_source || "google");
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(encrypted.iv) }, material.key, base64ToBytes(encrypted.data));
  return decoder.decode(clear);
}
async function getAccount(request, env) {
  const token = String(request.headers.get("X-User-Token") || "").trim();
  if (!token || token.length > 256 || !env.ANANAS_KV) return { error: "برای استفاده از منشی هوشمند به اشتراک Ultra نیاز دارید.", status: 401 };
  const raw = await env.ANANAS_KV.get(token);
  if (!raw) return { error: "اشتراک معتبر نیست یا در دسترس نیست.", status: 401 };
  let data;
  try { data = JSON.parse(raw); } catch { data = {}; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "اطلاعات اشتراک قابل تأیید نیست.", status: 401 };
  if (!(data.tier === "ultra" || token.startsWith("ULTRA-"))) return { error: "اتصال صندوق ایمیل Hostinger فقط برای کاربران Ultra فعال است.", status: 403 };
  return { token };
}
function mailboxIndexKey(hash) { return "mailbox_index:" + hash; }
function mailboxRecordKey(hash, id) { return "mailbox_record:" + hash + ":" + id; }
async function getMailboxIndex(env, hash) {
  const raw = await env.ANANAS_KV.get(mailboxIndexKey(hash));
  let items = [];
  try { items = raw ? JSON.parse(raw) : []; } catch {}
  return Array.isArray(items) ? items.filter(item => item && /^mbx_[A-Za-z0-9_-]{12,50}$/.test(item.id)) : [];
}
async function readMailbox(env, hash, id) {
  if (!/^mbx_[A-Za-z0-9_-]{12,50}$/.test(String(id || ""))) throw new Error("شناسه صندوق ایمیل معتبر نیست.");
  const raw = await env.ANANAS_KV.get(mailboxRecordKey(hash, id));
  if (!raw) throw new Error("صندوق ایمیل پیدا نشد یا قبلاً قطع شده است.");
  const record = JSON.parse(raw);
  const password = await decryptPassword(record.password, env);
  return { ...record, password };
}
function publicMailbox(item) {
  return { id: item.id, provider: "hostinger", email: item.email, label: item.label || item.email, connected_at: item.connected_at };
}
async function handleGet({ request, env }) {
  try {
    const account = await getAccount(request, env);
    if (account.error) return json({ error: account.error }, account.status);
    const hash = await accountHash(account.token);
    const mailboxes = await getMailboxIndex(env, hash);
    return json({ mailboxes: mailboxes.map(publicMailbox) });
  } catch (error) {
    return json({ error: error.message || "دریافت حساب‌های ایمیل ناموفق بود." }, 500);
  }
}
async function handlePost({ request, env }) {
  try {
    const account = await getAccount(request, env);
    if (account.error) return json({ error: account.error }, account.status);
    if (Number(request.headers.get("Content-Length") || 0) > 50000) return json({ error: "حجم درخواست بیش از حد مجاز است." }, 413);
    let body;
    try { body = await request.json(); } catch { return json({ error: "بدنه درخواست معتبر نیست." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "ساختار درخواست معتبر نیست." }, 400);
    const hash = await accountHash(account.token);

    if (body.action === "connect_hostinger") {
      const email = safeAccountName(body.email);
      const password = String(body.password || "");
      if (!validEmail(email) || !password || password.length > 1024 || /[\r\n\u0000]/.test(password)) return json({ error: "آدرس ایمیل یا رمز عبور معتبر نیست." }, 400);
      const existing = await getMailboxIndex(env, hash);
      if (existing.some(item => item.email.toLowerCase() === email.toLowerCase())) return json({ error: "این آدرس ایمیل قبلاً متصل شده است. ابتدا اتصال قبلی را حذف کنید." }, 409);
      try {
        await verifyMailbox(email, password);
      } catch (error) {
        const message = String(error.message || "");
        if (/نام کاربری یا رمز عبور|authentication|535/i.test(message)) return json({ error: "نام کاربری یا رمز عبور صندوق Hostinger معتبر نیست. آدرس کامل ایمیل و رمز خود صندوق را بررسی کنید." }, 401);
        return json({ error: message || "بررسی اتصال Hostinger ناموفق بود." }, 502);
      }
      const id = "mbx_" + bytesToBase64(crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
      const record = {
        id, provider: "hostinger", email, label: email,
        password: await encryptPassword(password, env),
        imap_host: IMAP_HOST, imap_port: IMAP_PORT,
        smtp_host: SMTP_HOST, smtp_port: SMTP_PORT,
        connected_at: Date.now()
      };
      await env.ANANAS_KV.put(mailboxRecordKey(hash, id), JSON.stringify(record));
      existing.unshift({ id, provider: "hostinger", email, label: email, connected_at: record.connected_at });
      await env.ANANAS_KV.put(mailboxIndexKey(hash), JSON.stringify(existing.slice(0, 10)));
      return json({ connected: true, mailbox: publicMailbox(record), tests: { imap: true, smtp: true }, mailboxes: existing.map(publicMailbox) });
    }

    if (body.action === "disconnect") {
      const id = String(body.mailboxId || "");
      if (!/^mbx_[A-Za-z0-9_-]{12,50}$/.test(id)) return json({ error: "شناسه صندوق ایمیل معتبر نیست." }, 400);
      const items = await getMailboxIndex(env, hash);
      await env.ANANAS_KV.delete(mailboxRecordKey(hash, id));
      const updated = items.filter(item => item.id !== id);
      await env.ANANAS_KV.put(mailboxIndexKey(hash), JSON.stringify(updated));
      return json({ disconnected: true, mailboxes: updated.map(publicMailbox) });
    }

    if (body.action === "list_emails") {
      const mailbox = await readMailbox(env, hash, String(body.mailboxId || ""));
      const result = await listMailboxMessages(mailbox.email, mailbox.password, body.query, body.maxResults);
      return json({ ...result, provider: "hostinger", account: mailbox.email });
    }

    if (body.action === "send_email") {
      const mailbox = await readMailbox(env, hash, String(body.mailboxId || ""));
      const result = await sendMailboxMessage(mailbox.email, mailbox.password, body.email || {});
      return json({ sent: true, provider: "hostinger", account: mailbox.email, ...result });
    }

    return json({ error: "درخواست ناشناخته است." }, 404);
  } catch (error) {
    console.error("ANANAS_MAILBOXES", error);
    return json({ error: error.message || "عملیات صندوق ایمیل ناموفق بود." }, 500);
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
