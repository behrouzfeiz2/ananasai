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
