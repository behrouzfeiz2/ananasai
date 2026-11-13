// تشخیص خودکار دیتابیس KV متصل به کلودفلر
function findKV(env) {
  for (const key of Object.keys(env)) {
    if (env[key] && typeof env[key].get === 'function' && typeof env[key].put === 'function' && typeof env[key].list === 'function') {
      return env[key];
    }
  }
  return null;
}

// نشست ادمین با کوکی HttpOnly و اعتبار ۴۸ ساعته
function getCookie(request, name) {
  const cookies = request.headers.get('Cookie') || '';
  const item = cookies.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}
async function hashSession(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function checkAdminAuth(request, env, kv) {
  const session = getCookie(request, 'ananas_admin_session');
  if (session) {
    const key = 'admin_session_' + await hashSession(session);
    if (await kv.get(key)) return { ok: true, sessionKey: key };
  }
  const pass = request.headers.get('X-Admin-Password');
  if (!pass) return { ok: false };
  const envPass = env.ADMIN_PASSWORD || env.ADMIN_PASS || env.PASSWORD;
  if (envPass) return { ok: pass === envPass };
  for (const key of Object.keys(env)) {
    if (typeof env[key] === 'string' && key.toUpperCase().includes('PASS')) return { ok: pass === env[key] };
  }
  return { ok: false };
}
function sessionCookie(value, maxAge = 172800) {
  return 'ananas_admin_session=' + encodeURIComponent(value) + '; Path=/; Max-Age=' + maxAge + '; HttpOnly; Secure; SameSite=Strict';
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

  const auth = await checkAdminAuth(request, env, kv);
  const isAuthValid = auth.ok;

  if (!isAuthValid) {
    // درخواست بررسی نشست منقضی‌شده نباید به‌عنوان تلاش رمز اشتباه شمرده شود.
    if (!request.headers.get('X-Admin-Password')) {
      return new Response(JSON.stringify({ error: 'نشست ادمین معتبر نیست یا منقضی شده است.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
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
        if (!key.name.startsWith('PAY-') && !key.name.startsWith('PRO-') && !key.name.startsWith('ULTRA-')) continue;
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

    if (body.action === 'logout') {
      if (auth.sessionKey) await kv.delete(auth.sessionKey);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie('', 0) }
      });
    }

    // پاک‌سازی مرحله‌ای تاریخچه متنی چت همه حساب‌ها؛ داده‌های پرداخت، اشتراک، تصاویر و اتصال سرویس‌ها خارج از این محدوده‌اند.
    if (body.action === 'purgeChatHistoryKv') {
      const prefixes = [
        'ananas_chat_history:', 'ananas_chat_history_deleted:', 'ananas_chat_history_clear:',
        'coder_history_index:', 'coder_history_record:', 'coder_history_deleted:', 'coder_history_clear:', 'coder_history_retention_v1:',
        'secretary_history_index:', 'secretary_history_record:', 'secretary_history_deleted:', 'secretary_history_clear:', 'secretary_history_retention_v1:'
      ];
      const prefixIndex = Number.isInteger(body.prefixIndex) ? body.prefixIndex : 0;
      if (prefixIndex < 0 || prefixIndex > prefixes.length) {
        return new Response(JSON.stringify({ error: 'مرحله پاک‌سازی تاریخچه معتبر نیست.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (prefixIndex === prefixes.length) {
        return new Response(JSON.stringify({ ok: true, deleted: 0, prefixIndex, cursor: null, done: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // نشانگر سراسری مانع بازگشت تاریخچه‌های قدیمی از دستگاه‌های دیگر می‌شود.
      if (prefixIndex === 0 && !body.cursor) {
        await kv.put('admin_chat_history_purge_at', String(Date.now()), { expirationTtl: 180 * 24 * 60 * 60 });
      }
      const options = { prefix: prefixes[prefixIndex], limit: 100 };
      if (typeof body.cursor === 'string' && body.cursor) options.cursor = body.cursor;
      const page = await kv.list(options);
      const keys = Array.isArray(page.keys) ? page.keys : [];
      await Promise.all(keys.map(key => kv.delete(key.name)));
      const doneForPrefix = Boolean(page.list_complete);
      const nextPrefixIndex = doneForPrefix ? prefixIndex + 1 : prefixIndex;
      const nextCursor = doneForPrefix ? null : (page.cursor || null);
      return new Response(JSON.stringify({
        ok: true, deleted: keys.length, prefix: prefixes[prefixIndex],
        prefixIndex: nextPrefixIndex, cursor: nextCursor, done: nextPrefixIndex >= prefixes.length
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // حذف مرحله‌ای فقط فایل‌های تصویری ذخیره‌شده در KV؛ هر درخواست حداکثر ۱۰۰ کلید را پاک می‌کند.
    if (body.action === 'purgeImageKv') {
      const prefixes = ['imgdata_', 'imgmeta_', 'imgref_'];
      let prefixIndex = Number.isInteger(body.prefixIndex) ? body.prefixIndex : 0;
      if (prefixIndex < 0 || prefixIndex > prefixes.length) {
        return new Response(JSON.stringify({ error: 'مرحله پاک‌سازی معتبر نیست.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }
      if (prefixIndex === prefixes.length) {
        return new Response(JSON.stringify({ ok: true, deleted: 0, prefixIndex, cursor: null, done: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const options = { prefix: prefixes[prefixIndex], limit: 100 };
      if (typeof body.cursor === 'string' && body.cursor) options.cursor = body.cursor;
      const page = await kv.list(options);
      const keys = Array.isArray(page.keys) ? page.keys : [];
      await Promise.all(keys.map(key => kv.delete(key.name)));
      const doneForPrefix = Boolean(page.list_complete);
      const nextPrefixIndex = doneForPrefix ? prefixIndex + 1 : prefixIndex;
      const nextCursor = doneForPrefix ? null : (page.cursor || null);
      return new Response(JSON.stringify({
        ok: true,
        deleted: keys.length,
        prefix: prefixes[prefixIndex],
        prefixIndex: nextPrefixIndex,
        cursor: nextCursor,
        done: nextPrefixIndex >= prefixes.length
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

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
      const session = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
      const sessionKey = 'admin_session_' + await hashSession(session);
      await kv.put(sessionKey, JSON.stringify({ created: Date.now() }), { expirationTtl: 172800 });
      return new Response(JSON.stringify({ ok: true, expiresIn: 172800 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookie(session) }
      });
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
