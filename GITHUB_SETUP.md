# راه‌اندازی اتصال GitHub برای عامل کدنویس آناناس

این قابلیت روی Cloudflare Pages و Pages Functions اجرا می‌شود و به Worker یا سرویس Cloudflare جداگانه نیاز ندارد.

## ۱. ساخت OAuth App در GitHub

در حساب GitHub به مسیر Settings → Developer settings → OAuth Apps بروید و یک OAuth App بسازید:

- Application name: AnanasAI Code Agent
- Homepage URL: https://ananas.ai
- Authorization callback URL: https://ananas.ai/api/github?action=callback

پس از ساخت، مقدار Client ID را بردارید و یک Client Secret تولید کنید.

## ۲. تنظیم متغیرهای Cloudflare

در Cloudflare Dashboard وارد Workers & Pages → پروژه Pages آناناس → Settings → Variables and Secrets شوید و این دو مقدار را به‌صورت Secret اضافه کنید:

- GITHUB_CLIENT_ID
- GITHUB_CLIENT_SECRET

Binding موجود ANANAS_KV و متغیر GEMINI_API_KEY نیز باید برای Pages Functions فعال باشند؛ این دو در زیرساخت فعلی پروژه استفاده می‌شوند.

پس از افزودن یا تغییر Secretها، یک بار پروژه را مجدداً Deploy کنید.

## ۳. مجوز دسترسی

اتصال فعلی از OAuth scope با نام repo استفاده می‌کند تا کاربر بتواند مخازن خصوصی و عمومی خود را بخواند و در شاخه مستقل تغییرات ثبت کند. این مجوز دسترسی گسترده به مخازن حساب GitHub می‌دهد؛ قبل از تأیید صفحه مجوز GitHub، متن دسترسی را بررسی کنید. کاربر هر زمان می‌تواند دسترسی AnanasAI را از GitHub Settings → Applications لغو کند.

## ۴. گردش کار

- کاربر Pro یا Ultra از صفحه چت وارد coder.html می‌شود.
- GitHub را متصل و مخزن را انتخاب می‌کند.
- عامل می‌تواند ساختار مخزن را تحلیل کند.
- برای اعمال تغییرات، شاخه‌ای با پیشوند ananas/agent- ساخته می‌شود.
- فایل‌های تغییرکرده در آن شاخه ثبت و یک Pull Request ساخته می‌شود.
- شاخه اصلی مستقیماً تغییر نمی‌کند.

فایل‌های env و workflowهای GitHub Actions از تغییر خودکار مستثنا هستند. اجرای تست و Build خودکار در این نسخه فعال نشده است.
