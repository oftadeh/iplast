# iPlast | اصفهان پلاست

مینی‌اپ فروش B2B تلگرام، پنل مدیریت وب، API و ربات.

## ساختار

| مسیر | توضیح |
|---|---|
| `apps/miniapp` | پنل مشتری؛ مینی‌اپ داخل تلگرام (React + Vite) |
| `apps/admin` | پنل مدیریت وب (React + Vite) |
| `apps/api` | API (NestJS)؛ احراز هویت با initData تلگرام و JWT کوتاه‌مدت |
| `apps/bot` | ربات (grammY)؛ دکمه مینی‌اپ و دریافت متن، ویس، عکس و PDF و ارجاع به پشتیبان فروش |
| `packages/db` | مدل داده Prisma (PostgreSQL) |
| `packages/shared` | کد مشترک: بررسی امضای initData، قالب‌بندی ریال، تقسیم نقد و چک |
| `infra` | Dockerfileها و Caddy (HTTPS خودکار) |

## قواعد داده

- قیمتی که در لیست نیست یا «بزودی» است، `NULL` با وضعیت `INQUIRY` ذخیره و «استعلامی» نمایش داده می‌شود. هرگز صفر یا عدد ساختگی نیست.
- کد کالای حسابداری یکتا نیست؛ هر سایز یک `sku` داخلی دارد.
- نقش‌ها فقط از پایگاه داده خوانده می‌شوند، نه از کلاینت.
- توکن ربات و رمزها فقط در `.env` سرور هستند و هرگز در مخزن قرار نمی‌گیرند.

## اجرای محلی

```bash
pnpm install
cp .env.example .env   # مقادیر را پر کنید؛ DATABASE_URL را به localhost بدهید
pnpm db:migrate
pnpm --filter @iplast/shared build && pnpm --filter @iplast/shared test
pnpm dev:api    # http://localhost:3000/api/health
pnpm dev:miniapp
pnpm dev:admin
pnpm dev:bot
```

## انتشار روی سرور (اوبونتو، خارج از ایران)

یک بار روی سرور، با کاربر root:

```bash
curl -fsSL https://raw.githubusercontent.com/oftadeh/iplast/main/infra/setup.sh | sudo bash
```

این اسکریپت Docker را نصب می‌کند، کد را در `/opt/iplast` می‌گذارد، توکن ربات و آیدی عددی مدیر را می‌پرسد، `.env` را با رمزهای تصادفی می‌سازد و همه سرویس‌ها را بالا می‌آورد.

بعد رکوردهای A زیر را در DNS به IP سرور بدهید:
- `app.isfahanplast.co` برای مینی‌اپ
- `admin.isfahanplast.co` برای پنل مدیریت

**به‌روزرسانی خودکار:** سرور هر ۲ دقیقه گیت‌هاب را بررسی می‌کند. با هر commit جدید روی `main` دوباره بیلد می‌شود و نتیجه، موفق یا خطا، با ربات برای مدیر ارسال می‌شود. برای این کار به دسترسی ورودی SSH نیازی نیست.

## دستیار سفارش (OpenAI)

مشتری در ربات یا در صفحه‌ی «سفارش سریع» مینی‌اپ سفارشش را می‌نویسد یا ویس می‌فرستد. دستیار با OpenAI Agents SDK فقط از کاتالوگ و لیست قیمت فعال اقلام را پیدا می‌کند و پیش‌نویس سبد می‌سازد. مشتری با دکمه‌ی «بررسی و ثبت در سبد» آن را در مینی‌اپ باز می‌کند. کارشناس فروش همه‌ی پیام‌ها و پیش‌نویس‌ها را می‌بیند.

تنظیمات در `.env`: `OPENAI_API_KEY` (خالی = خاموش)، `OPENAI_MODEL` (پیش‌فرض `gpt-6-luna`)، `OPENAI_TRANSCRIBE_MODEL` (پیش‌فرض `gpt-transcribe`).
