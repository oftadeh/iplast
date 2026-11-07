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

1. Docker و Docker Compose را نصب کنید.
2. رکوردهای DNS `app.<دامنه>` و `admin.<دامنه>` را به IP سرور بدهید.
3. مخزن را کلون کنید، `.env` را از روی `.env.example` بسازید و پر کنید.
4. `docker compose up -d --build`

ربات با long polling کار می‌کند و به پورت باز نیاز ندارد. Caddy گواهی HTTPS را خودکار می‌گیرد.
