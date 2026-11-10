
const API = "https://api.appalpha.ir/v1";

const ALLOWED_SPEAKERS = [
  "ava", "mahsa", "shabnam", "sahar",
  "maryam", "farnaz", "sara", "mahtab"
];

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.ALPHA_KEY) {
    return reply({ error: "تنظیمات سرویس صوت انجام نشده است." }, 500);
  }

  try {
    const body = await request.json();
    const text = String(body.text || "").trim();
    const speaker = String(body.speaker || "ava");

    if (!text) {
      return reply({ error: "متنی ارسال نشده است." }, 400);
    }

    if (text.length > 2500) {
      return reply({ error: "متن نباید بیشتر از ۲۵۰۰ نویسه باشد." }, 400);
    }

    if (!ALLOWED_SPEAKERS.includes(speaker)) {
      return reply({ error: "گوینده نامعتبر است." }, 400);
    }

    const response = await fetch(`${API}/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.ALPHA_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "alpha-tts",
        text,
        speaker,
        tone: "با لحنی طبیعی، گرم و صمیمی"
      })
    });

    const result = await response.json();

    if (!response.ok) {
      return reply({
        error: result.error?.message || "خطا در سرویس تبدیل صوت",
        code: result.error?.code
      }, response.status);
    }

    return reply({
      success: true,
      id: result.id,
      status: result.status
    });

  } catch (e) {
    return reply({ error: "ارتباط با سرویس صوت برقرار نشد." }, 502);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.ALPHA_KEY) {
    return reply({ error: "تنظیمات سرویس صوت انجام نشده است." }, 500);
  }

  const id = new URL(request.url).searchParams.get("id");

  if (!id) {
  return reply({
    success: true,
    message: "سرویس تبدیل متن به صوت آناناس فعال است.",
    usage: "برای تولید صوت از POST /api/tts استفاده کنید."
  });
}

if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
  return reply({ error: "شناسه درخواست معتبر نیست." }, 400);
}

  try {
    const response = await fetch(`${API}/generations/${id}`, {
      headers: {
        Authorization: `Bearer ${env.ALPHA_KEY}`
      }
    });

    const result = await response.json();

    if (!response.ok) {
      return reply({
        error: result.error?.message || "خطا در دریافت وضعیت"
      }, response.status);
    }

    return reply({
      success: true,
      status: result.status,
      output: result.output || null,
      error: result.error || null
    });

  } catch (e) {
    return reply({ error: "دریافت وضعیت صوت ناموفق بود." }, 502);
  }
}
