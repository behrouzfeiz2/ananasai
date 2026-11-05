export async function onRequest(context) {
  const { request, env } = context;
  
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Password",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const adminPassword = request.headers.get("X-Admin-Password");
  if (adminPassword !== "YOUR_SECURE_ADMIN_PASSWORD") {
    return new Response(JSON.stringify({ error: "رمز عبور اشتباه است." }), { status: 401, headers: corsHeaders });
  }

  try {
    // اگر متد POST بود یعنی درخواست ساخت کد جدید است
    if (request.method === "POST") {
      let tokenName = "";
      try {
        const body = await request.json();
        tokenName = body.token;
      } catch (e) {}

      if (!tokenName) {
        return new Response(JSON.stringify({ error: "نام کد فعال‌سازی الزامی است." }), { status: 400, headers: corsHeaders });
      }
      
      const expirationSeconds = 30 * 24 * 60 * 60; // ۳۰ روز
      await env.ANANAS_KV.put(
        `token_${tokenName.trim()}`, 
        JSON.stringify({ active: true, created: Date.now() }),
        { expirationTtl: expirationSeconds }
      );

      return new Response(JSON.stringify({ success: true, message: "کد با موفقیت ساخته شد." }), { headers: corsHeaders });
    }
    
    // اگر متد GET بود یعنی درخواست لیست کردن کدها است
    const list = await env.ANANAS_KV.list({ prefix: "token_" });
    const tokens = [];
    for (const key of list.keys) {
      const val = await env.ANANAS_KV.get(key.name);
      tokens.push({ name: key.name.replace("token_", ""), data: JSON.parse(val || "{}") });
    }
    return new Response(JSON.stringify({ tokens }), { headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: `خطای سرور: ${err.message}` }), { status: 500, headers: corsHeaders });
  }
}
