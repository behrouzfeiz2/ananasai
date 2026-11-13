/* AnanasAI Secretary UI */
let secretaryGoogleStatus = { configured: false, connected: false, email: null };
function secretaryHeaders() {
  return { "Content-Type": "application/json", "X-User-Token": userToken, "X-Device-UUID": deviceUUID };
}
async function secretaryApi(action, payload) {
  let url = "/api/secretary";
  let options = { method: "POST", headers: secretaryHeaders(), cache: "no-store", credentials: "same-origin" };
  if (payload && payload.method === "GET") {
    url += "?action=" + encodeURIComponent(action);
    options.method = "GET";
  } else {
    options.body = JSON.stringify(payload || { action: action });
  }
  const response = await fetch(url, options);
  const data = await response.json().catch(function() { return {}; });
  if (!response.ok) throw new Error(data.error || "خطای منشی (" + response.status + ")");
  return data;
}
async function secretaryRefreshStatus() {
  if (!userToken) return;
  try { secretaryGoogleStatus = await secretaryApi("status", { method: "GET" }); }
  catch (error) { secretaryGoogleStatus = { configured: false, connected: false, email: null }; }
  const label = document.getElementById("secretaryGoogleStatusText");
  const connect = document.getElementById("secretaryConnectBtn");
  const disconnect = document.getElementById("secretaryDisconnectBtn");
  if (label) {
    if (!secretaryGoogleStatus.configured) label.textContent = "اتصال گوگل هنوز پیکربندی نشده است.";
    else if (secretaryGoogleStatus.connected) label.textContent = "حساب متصل: " + (secretaryGoogleStatus.email || "Google");
    else label.textContent = "حساب گوگل هنوز متصل نشده است.";
  }
  if (connect) {
    connect.disabled = !secretaryGoogleStatus.configured;
    connect.textContent = secretaryGoogleStatus.connected ? "تغییر حساب گوگل" : "اتصال حساب گوگل";
  }
  if (disconnect) disconnect.classList.toggle("hidden", !secretaryGoogleStatus.connected);
}
async function secretaryConnectGoogle() {
  try {
    const data = await secretaryApi("connect", { method: "GET" });
    location.href = data.url;
  } catch (error) { alert(error.message); }
}
async function secretaryDisconnectGoogle() {
  if (!confirm("اتصال گوگل قطع شود؟")) return;
  try {
    await secretaryApi("disconnect", { action: "disconnect" });
    secretaryGoogleStatus.connected = false;
    secretaryRefreshStatus();
  } catch (error) { alert(error.message); }
}
window.secretaryConnectGoogle = secretaryConnectGoogle;
window.secretaryDisconnectGoogle = secretaryDisconnectGoogle;

function secretaryCurrentSession() {
  return sessions.find(function(item) {
    return item.id === activeSessionId && item.mode === "secretary";
  }) || null;
}
function secretaryNewSession() {
  const id = "sec_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
  const item = {
    id: id, title: "گفتگوی منشی", mode: "secretary", isPinned: false,
    createdAt: Date.now(), updatedAt: Date.now(), remoteLoaded: true,
    secretary: { pendingAction: null }, messages: []
  };
  sessions.unshift(item);
  activeSessionId = id;
  saveSessions(); renderHistoryList(); renderMessages();
  return item;
}
function secretaryAdd(role, text, extra) {
  let session = secretaryCurrentSession();
  if (!session) session = secretaryNewSession();
  const message = { role: role, text: String(text || "") };
  if (extra) Object.assign(message, extra);
  session.messages.push(message);
  session.updatedAt = Date.now();
  saveSessions(); renderMessages(); renderHistoryList();
  return session;
}
function secretarySetTitle(text) {
  const session = secretaryCurrentSession();
  if (session && (!session.title || session.title === "گفتگوی منشی")) {
    session.title = String(text || "").replace(/\s+/g, " ").slice(0, 52);
  }
}
function secretaryConversationPayload(session) {
  const messages = session.messages.slice(-120).map(function(message) {
    const item = {
      role: message.role === "user" ? "user" : "assistant",
      content: String(message.text || "").slice(0, 7000)
    };
    if (message.secretaryAction) item.secretaryAction = message.secretaryAction;
    return item;
  });
  let pending = null;
  if (session.secretary) pending = session.secretary.pendingAction || null;
  return {
    id: session.id, title: session.title || "گفتگوی منشی",
    created_at: session.createdAt || Date.now(), pendingAction: pending, messages: messages
  };
}
async function secretarySaveHistory() {
  const session = secretaryCurrentSession();
  if (!session || !userToken) return;
  await secretaryApi("history_save", { action: "history_save", conversation: secretaryConversationPayload(session) });
  session.remoteLoaded = true;
}
async function secretaryLoadRemote(session) {
  if (!session || !userToken || session.remoteLoaded !== false) return;
  const result = await secretaryApi("history_get", { action: "history_get", id: session.id });
  const conversation = result.conversation;
  if (!conversation) throw new Error("گفتگو پیدا نشد.");
  session.title = conversation.title || session.title;
  session.createdAt = conversation.created_at || Date.now();
  session.updatedAt = conversation.updated_at || Date.now();
  session.secretary = { pendingAction: conversation.pendingAction || null };
  session.messages = (conversation.messages || []).map(function(message) {
    const restored = { role: message.role === "user" ? "user" : "model", text: message.content || "" };
    if (message.secretaryAction) restored.secretaryAction = message.secretaryAction;
    return restored;
  });
  session.remoteLoaded = true;
  saveSessions(); renderMessages(); renderHistoryList();
}
async function secretaryInit() {
  if (currentMode !== "secretary" || !userToken || window.secretaryLoading) return;
  window.secretaryLoading = true;
  try {
    await secretaryRefreshStatus();
    const result = await secretaryApi("history_list", { action: "history_list" });
    (result.conversations || []).forEach(function(item) {
      const exists = sessions.some(function(session) { return session.id === item.id; });
      if (!item.id || exists) return;
      sessions.push({
        id: item.id, title: item.title || "گفتگوی منشی", mode: "secretary",
        isPinned: false, createdAt: item.created_at || Date.now(),
        updatedAt: item.updated_at || Date.now(), remoteLoaded: false,
        secretary: { pendingAction: null }, messages: []
      });
    });
    let session = secretaryCurrentSession();
    if (!session) {
      const list = sessions.filter(function(item) { return item.mode === "secretary"; });
      list.sort(function(a, b) { return Number(b.updatedAt || 0) - Number(a.updatedAt || 0); });
      if (list.length) {
        session = list[0];
        activeSessionId = session.id;
      }
    }
    if (!session) session = secretaryNewSession();
    if (session.remoteLoaded === false) await secretaryLoadRemote(session);
    saveSessions(); renderHistoryList(); renderMessages();
  } catch (error) {
    console.warn("Secretary initialization failed:", error);
    const label = document.getElementById("secretaryGoogleStatusText");
    if (label) label.textContent = "دریافت اطلاعات منشی ناموفق بود: " + error.message;
    if (!secretaryCurrentSession()) secretaryNewSession();
  } finally {
    window.secretaryLoading = false;
  }
}
function secretaryStartNewConversation() {
  activeSessionId = null;
  secretaryNewSession();
}
