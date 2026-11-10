// پیدا کردن خودکار دیتابیس KV متصل به پروژه کلودفلر شما
function findKV(env) {
  for (const key of Object.keys(env)) {
    if (env[key] && typeof env[key].get === 'function' && typeof env[key].put === 'function' && typeof env[key].list === 'function') {
      return env[key];
    }
  }
  return null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const kv = findKV(env);

  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV Database not found' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await request.json();
    const { fullName, phone, senderCard, amount, tier } = body;
    const selectedTier = tier === 'ultra' ? 'ultra' : 'pro';

    if (!fullName || !phone || !senderCard) {
      return new Response(JSON.stringify({ error: 'اطلاعات ناقص است' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const id = 'PAY-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const paymentRecord = {
      id,
      fullName: fullName.trim(),
      phone: phone.trim(),
      senderCard: senderCard.trim(),
      amount: amount || (selectedTier === 'ultra' ? '750.000 تومان' : '450.000 تومان'),
      tier: selectedTier,
      status: 'pending', // pending | done
      created: Date.now()
    };

    // ذخیره در KV با پیشوند PAY- تا با کدهای PRO- قاطی نشود
    await kv.put(id, JSON.stringify(paymentRecord));

    return new Response(JSON.stringify({ ok: true, id }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'خطا در ثبت اطلاعات' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
