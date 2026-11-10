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

// تابع تایید اعتبار کپچای گوگل
async function verifyRecaptcha(token, env) {
  const secret = env.RECAPTCHA_SECRET_KEY;
  if (!secret) return true; // اگر کلید سکرت در کلودفلر تنظیم نشده باشد، موقتاً سخت‌گیری نمی‌کند
  
  try {
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${secret}&response=${token}`
    });
    const data = await res.json();
    return data.success;
  } catch (e) {
    return false;
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = findKV(env);

  if (!kv) {
    return new Response(JSON.stringify({ error: 'KV not bound' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // --- لایه امنیتی ۱: مسدودسازی IP کاربر در صورت ۳ بار خطای رمز عبور ---
  const clientIP = request.headers.get('cf-connecting-ip') || 'unknown-ip';
  const failKey = `admin_fail_${clientIP}`;
  
  const failDataRaw = await kv.get(failKey);
  let failData = failDataRaw ? JSON.parse(failDataRaw) : { attempts: 0, lockUntil: 0 };

  // بررسی وضعیت مسدودی IP
  if (failData.lockUntil > Date.now()) {
    const hoursLeft = Math.ceil((failData.lockUntil - Date.now()) / (1000 * 60 * 60));
    return new Response(JSON.stringify({ error: `دسترسی شما به دلیل تلاش‌های ناموفق مسدود شده است. لطفاً ${hoursLeft} ساعت دیگر تلاش کنید.` }), {
      status: 429, // Too Many Requests
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const isAuthValid = checkAdminAuth(request, env);

  if (!isAuthValid) {
    // ثبت تلاش ناموفق
    failData.attempts += 1;
    if (failData.attempts >= 3) {
      failData.lockUntil = Date.now() + (24 * 60 * 60 * 1000); // مسدودسازی برای 24 ساعت
    }
    
    // ذخیره در KV با قابلیت انقضای خودکار دقیقاً پس از 24 ساعت برای جلوگیری از پر شدن دیتابیس
    await kv.put(failKey, JSON.stringify(failData), { expirationTtl: 86400 });

    const attemptsLeft = Math.max(0, 3 - failData.attempts);
    return new Response(JSON.stringify({ error: `رمز عبور اشتباه است! (فرصت باقیمانده: ${attemptsLeft} بار)` }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // اگر رمز درست بود، تاریخچه خطاهای این IP پاک می‌شود
  if (failData.attempts > 0) {
    await kv.delete(failKey);
  }

  // ۱. دریافت لیست کدهای پرو + لیست درخواست‌های پرداخت (GET)
  if (request.method === 'GET') {
    const tokens = [];
    const payments = [];
    let cursor;
    do {
      const page = await kv.list({ cursor, limit: 1000 });
      for (const key of page.keys) {
        const rawVal = await kv.get(key.name);
        if (!rawVal) continue;
        let parsed = {};
        try { parsed = JSON.parse(rawVal); }
        catch { parsed = { created: Date.now() }; }
        if (key.name.startsWith('PAY-')) payments.push(parsed);
        else if (key.name.startsWith('PRO-') || key.name.startsWith('ULTRA-')) {
          tokens.push({ name: key.name, data: parsed });
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    payments.sort((a, b) => (b.created || 0) - (a.created || 0));
    tokens.sort((a, b) => (b.data?.created || 0) - (a.data?.created || 0));

    return new Response(JSON.stringify({ tokens, payments }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ۲. مدیریت اکشن‌های POST
  if (request.method === 'POST') {
    const body = await request.json();

    // --- لایه امنیتی ۲: بررسی لاگین اولیه و ریکپچا ---
    if (body.action === 'login') {
      if (env.RECAPTCHA_SECRET_KEY) {
        if (!body.captchaToken) {
          return new Response(JSON.stringify({ error: 'لطفاً تایید کنید که ربات نیستید.' }), { status: 400 });
        }
        const isHuman = await verifyRecaptcha(body.captchaToken, env);
        if (!isHuman) {
          return new Response(JSON.stringify({ error: 'تشخیص ربات! کپچا نامعتبر است یا منقضی شده.' }), { status: 403 });
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    // ساخت کد پرو جدید
    if (body.token) {
      const tokenName = body.token.trim();
      const tokenData = {
        created: Date.now(),
        note: body.note || '', tier: body.tier === 'ultra' || tokenName.startsWith('ULTRA-') ? 'ultra' : 'pro'
      };
      await kv.put(tokenName, JSON.stringify(tokenData));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // اتصال کد تازه به سفارش و ثبت قطعی وضعیت انجام‌شده
    if (body.action === 'assignPaymentToken' && body.id && body.assignedToken) {
      const raw = await kv.get(body.id);
      if (!raw) return new Response(JSON.stringify({ error: 'سفارش پیدا نشد' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const payment = JSON.parse(raw);
      const tokenRaw = await kv.get(body.assignedToken);
      if (!tokenRaw) return new Response(JSON.stringify({ error: 'کد فعال‌سازی پیدا نشد' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      payment.status = 'done';
      payment.assignedToken = body.assignedToken;
      await kv.put(body.id, JSON.stringify(payment));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // تغییر وضعیت سفارش پرداخت
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

    // حذف آیتم
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
