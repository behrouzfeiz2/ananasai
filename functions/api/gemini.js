export async function onRequestPost(context) {
  const { request, env } = context;

  // کلید از متغیر محیطی کلودفلر خوانده می‌شود (یا اگر کاربر در تنظیمات سایت کلید شخصی وارد کرده باشد)
  const clientKey = request.headers.get("X-Custom-API-Key");
  const apiKey = clientKey || env.GEMINI_API_KEY;

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: "کلید API جمنای در سرور تنظیم نشده است." } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const body = await request.json();
    const model = body.model || "gemini-2.5-flash";
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body.payload)
    });

    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: { message: err.message } }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
