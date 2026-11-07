// تشخیص خودکار دیتابیس KV متصل به کلودفلر
function findKV(env) {
  for (const key of Object.keys(env)) {
    if (env[key] && typeof env[key].get === 'function' && typeof env[key].put === 'function' && typeof env[key].list === 'function') {
      return env[key];
    }
  }
  return null;
}

// تشخیص خودکار رمز ادمین از Environment Variables کلودفلر
function checkAdminAuth(request, env) {
  const pass = request.headers.get('X-Admin-Password');
  if (!pass) return false;
  const envPass = env.ADMIN_PASSWORD || env.ADMIN_PASS || env.PASSWORD;
  if (envPass) return pass === envPass;
  for (const key of Object.keys(env)) {
    if (typeof env[key] === 'string' && key.toUpperCase().includes('PASS')) {
      return pass === env[key];
    }
  }
  return false;
}

export async function onRequest(context) {
  const { request, env } = context;

  if (!checkAdminAuth(request, env)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const kv = findKV(env);
  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ۱. دریافت لیست کدهای پرو + لیست درخواست‌های پرداخت (GET)
  if (request.method === 'GET') {
    const list = await kv.list();
    const tokens = [];
    const payments = [];

    for (const key of list.keys) {
      const rawVal = await kv.get(key.name);
      if (!rawVal) continue;

      let parsed = {};
      try {
        parsed = JSON.parse(rawVal);
      } catch {
        parsed = { created: Date.now() };
      }

      if (key.name.startsWith('PAY-')) {
        payments.push(parsed);
      } else if (key.name.startsWith('PRO-')) {
        tokens.push({ name: key.name, data: parsed });
      }
    }

    payments.sort((a, b) => (b.created || 0) - (a.created || 0));
    tokens.sort((a, b) => (b.data?.created || 0) - (a.data?.created || 0));

    return new Response(JSON.stringify({ tokens, payments }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ۲. ساخت کد پرو جدید یا تغییر وضعیت / حذف سفارش پرداخت (POST)
  if (request.method === 'POST') {
    const body = await request.json();

    if (body.token) {
      const tokenName = body.token.trim();
      const tokenData = {
        created: Date.now(), // ثبت زمان دقیق ایجاد کد در دیتابیس KV[cite: 3]
        note: body.note || ''
      };
      await kv.put(tokenName, JSON.stringify(tokenData));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body.action === 'togglePayment' && body.id) {
      const raw = await kv.get(body.id);
      if (raw) {
        const payment = JSON.parse(raw);
        payment.status = payment.status === 'done' ? 'pending' : 'done';
        payment.assignedToken = body.assignedToken || payment.assignedToken || '';
        await kv.put(body.id, JSON.stringify(payment));
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (body.action === 'deleteKey' && body.key) {
      await kv.delete(body.key);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  return new Response('Method Not Allowed', { status: 405 });
}
