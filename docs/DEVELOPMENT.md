# راهنمای توسعه و تحویل iPlast | اصفهان پلاست

این سند برای کسی است که بخواهد توسعه‌ی iPlast را ادامه دهد: یک برنامه‌نویس یا یک دستیار هوش مصنوعی دیگر (ChatGPT، Codex، Cursor، Gemini، Claude و …). همه‌ی چیزهایی که برای فهمیدن کد، اجرای آن، تغییر دادنش و رساندن تغییر به سرور لازم است این‌جاست.

- راهنمای نصب، پشتیبان‌گیری، بازگردانی و عیب‌یابی سرور: [BUILD.md](BUILD.md)
- توضیح امکانات برنامه برای کاربر: [README.md](../README.md)

> **هیچ توکن، رمز یا کلیدی در این مخزن نیست و نباید باشد.** این سند فقط می‌گوید هر رمز کجا نگه داشته می‌شود (بخش ۱۲).

---

## ۰. خلاصه‌ی یک‌صفحه‌ای

| موضوع | مقدار |
|---|---|
| محصول | فروش B2B کارخانه‌ی اصفهان پلاست (اتصالات و لوازم آبیاری پلی‌اتیلن) از راه تلگرام |
| بخش‌ها | مینی‌اپ مشتری، پنل مدیریت، API، ربات تلگرام `@iplast_sellerbot`، ایجنت فروش هوش مصنوعی |
| مخزن | `github.com/oftadeh/iplast` (عمومی)، شاخه‌ی اصلی `main` |
| زبان و ابزار | TypeScript همه‌جا؛ pnpm monorepo؛ NestJS 10 + Prisma 5 + PostgreSQL 16؛ React 18 + Vite 5؛ grammY 1.31 |
| آدرس زنده | `https://iplast.keyfitapp.ir` (مینی‌اپ) و `https://iplast.keyfitapp.ir/admin/` (پنل) |
| سرور | VPS داخل ایران (mobinhost)، آی‌پی `87.107.129.163`، اوبونتو، Docker Compose در `/opt/iplast` |
| انتشار | خودکار: هر commit روی `main` در کمتر از ۲ دقیقه دیده می‌شود و ۳ تا ۸ دقیقه بعد روی سرور است |
| زبان رابط کاربری | فارسی، راست‌به‌چپ، فونت Vazirmatn، اعداد فارسی، مبالغ به **ریال** |

---

## ۱. محصول و نقش‌ها

مشتری‌ها (فروشگاه‌ها، نماینده‌ها، پیمانکارها) از داخل تلگرام کاتالوگ را می‌بینند، با قیمت مخصوص خودشان سفارش می‌دهند یا سفارش را متنی/صوتی به ربات می‌گویند. سفارش از چند مرحله‌ی تأیید رد می‌شود، به انبار می‌رود، ارسال می‌شود و فاکتور و حساب مشتری خودکار به‌روز می‌شود.

**نقش کارکنان** (`User.staffRole`، enum `StaffRole`):

| نقش | فارسی | کار |
|---|---|---|
| `ADMIN` | مدیر ارشد / مدیر | همه‌چیز؛ تأیید نهایی سفارش، کارکنان، تنظیمات، پراکسی |
| `SALES` | کارشناس فروش | مشتری‌های خودش، بررسی و قیمت‌گذاری پیش‌فاکتور، گفتگو |
| `WAREHOUSE` | انبار | آماده‌سازی و ثبت ارسال (بارنامه، راننده، پلاک) |

«مدیر ارشد» (owner) یک ADMIN ویژه است که نقشش را کسی نمی‌تواند عوض کند؛ آیدی‌اش در Setting `owner.telegramIds` است و اگر نباشد از `ADMIN_TELEGRAM_IDS` در `.env` خوانده می‌شود (`apps/api/src/common/owner.ts`).

**نقش اعضای شرکت مشتری** (`CustomerMember.role`، enum `MemberRole`): `OWNER` مدیر حساب (همه‌ی سفارش‌ها و حساب مالی)، `BUYER` کارشناس خرید (سفارش می‌دهد، حساب مالی نمی‌بیند)، `VIEWER` فقط مشاهده. یک مشتری چند کاربر تلگرام دارد.

---

## ۲. معماری

```
   کاربر تلگرام
       │
       ├── ربات @iplast_sellerbot  (apps/bot, grammY)
       │        │  POST /api/internal/*  با هدر x-internal-key
       │        ▼
       └── مینی‌اپ / پنل  ──HTTPS──►  iplast-front (Caddy روی 80/443 سرور)
                                         │  iplast.keyfitapp.ir → 172.17.0.1:8088
                                         ▼
                                   web (Caddy داخل compose)
                                   ├── /          → apps/miniapp (فایل استاتیک)
                                   ├── /admin/    → apps/admin   (فایل استاتیک)
                                   └── /api/*     → api:3000 (NestJS)
                                                   ├── postgres:16 (Prisma)
                                                   ├── redis:7
                                                   ├── /data/uploads (volume)
                                                   └── OpenAI / Telegram / کاوه‌نگار ── از راه proxy:10809 (xray)
```

- **ورود:** مینی‌اپ و پنل `initData` تلگرام را به `POST /api/auth/telegram` می‌فرستند. API امضای آن را با `BOT_TOKEN` بررسی می‌کند (`packages/shared/src/telegram-init-data.ts`) و یک JWT هشت‌ساعته می‌دهد. نقش کارکنان در **هر درخواست** دوباره از دیتابیس خوانده می‌شود (`SessionGuard` در `apps/api/src/common/session.ts`)، پس حذف یک کارمند فوراً اثر دارد.
- **ربات ↔ API:** ربات خودش منطق کسب‌وکار ندارد؛ برای ثبت سفارش، تأیید، رسید و پیام ایجنت به مسیرهای `/api/internal/*` درخواست می‌دهد با هدر `x-internal-key: $INTERNAL_KEY`. Caddy این مسیرها را از بیرون 404 می‌کند. API هم برای فرستادن پیام تلگرام مستقیم از `TelegramService` (`apps/api/src/common/telegram.service.ts`) استفاده می‌کند.
- **کارهای زمان‌بندی‌شده:** با `setInterval` داخل سرویس‌ها (مثلاً `OrdersService` هر ۱۰ دقیقه: انقضای پیش‌فاکتور، یادآوری چک؛ `WeeklyReport` در `growth.ts`؛ ربات هر ۲ دقیقه دکمه‌ی منو را همگام می‌کند). Redis فعلاً تقریباً استفاده نمی‌شود.
- **هوش مصنوعی:** OpenAI Agents SDK (`@openai/agents`). ایجنت فروش در `apps/api/src/assistant/sales-agent.service.ts` با ابزارهای سمت سرور (جستجوی کاتالوگ، قیمت، ثبت/لغو/اصلاح سفارش، ارسال PDF لیست قیمت، سپردن به کارشناس). خواندن PDF قیمت با AI در `apps/api/src/prices/price-ai.service.ts`.

---

## ۳. ساختار پوشه‌ها

```
apps/
  api/                 NestJS. یک ماژول (AppModule) و کنترلرها در پوشه‌های موضوعی
    src/main.ts        prefix سراسری /api؛ BigInt در JSON رشته می‌شود
    src/app.module.ts  فهرست همه‌ی کنترلرها و سرویس‌ها (کنترلر جدید را این‌جا ثبت کنید)
    src/common/        session.ts (گارد و @Staff)، validate.ts (req/int/rialOf/telegramId)، audit.ts، owner.ts، telegram.service.ts
    src/auth/          ورود با initData، JWT، ساختن مدیر ارشد اول، گزارش migration ناموفق به مدیر
    src/catalog/       کاتالوگ عمومی و درخت دسته‌ها (tree.ts)
    src/orders/        orders.service.ts (قلب روند سفارش و وضعیت‌ها)، pricing.ts (محاسبه‌ی قیمت هر مشتری)
    src/admin/         admin-*.controller.ts: یک فایل برای هر بخش پنل
    src/me/            مسیرهای مشتری (/me، گفتگوی مینی‌اپ)
    src/accounting/    فاکتور، دریافتی، چک، رسید مشتری
    src/documents/     اسناد مالی و بارنامه (آپلود)
    src/prices/        وارد کردن PDF لیست قیمت (pdf-parse.ts) و تطبیق با AI
    src/assistant/     دستیار سفارش و ایجنت فروش + مسیرهای internal ربات
    src/growth/        لینک دعوت، تخفیف سفارش از اپ، لینک اشتراک پیش‌فاکتور، گزارش هفتگی
    test/e2e.mjs       آزمون سرتاسری روی API در حال اجرا
    test/ticks.cjs     آزمون کارهای زمان‌بندی‌شده
  bot/src/main.ts      کل ربات در یک فایل (grammY)؛ TunnelAgent برای پراکسی
  miniapp/src/         پنل مشتری. App.tsx (مسیریابی با stack در state)، screens.tsx، proforma.tsx، account.tsx، chat.tsx، Picker.tsx، lib.ts (api و انواع)، telegram.ts
  miniapp/public/      عکس محصولات (products/) و ویدیوی معرفی intro.mp4
  admin/src/           پنل مدیریت. App.tsx (منوی درختی AREAS و مسیریابی با hash)، pages/*.tsx یک فایل برای هر صفحه، lib.ts (api، useApi، قالب‌بندی)
packages/
  db/prisma/schema.prisma   مدل داده (منبع حقیقت)
  db/prisma/migrations/     migrationهای Prisma با نام زمان‌دار
  db/seed/                  کاتالوگ آبان ۱۴۰۵ (۹۸ خانواده، ۸۸۳ سایز) و نقشه‌ی عکس‌ها
  db/src/seed.ts            بارگذاری کاتالوگ (فقط یک بار روی سرور؛ فایل .seeded)
  shared/src/               کد مشترک سرور و کلاینت: initData، money.ts (درصد نقد/مدت‌دار، تخفیف ویژه، قیمت خالص)
infra/
  Dockerfile.node           ساخت api و bot (ARG APP)
  Dockerfile.web            ساخت مینی‌اپ و پنل و Caddy
  Caddyfile                 مسیرهای /، /admin/، /api
  setup.sh                  نصب یک‌باره روی سرور
  autodeploy.sh             انتشار خودکار (systemd timer)
  backup.sh                 پشتیبان هفتگی
  front/install.sh          پراکسی جلوی سرور (iplast-front) برای iplast و keyfit
  proxy/                    xray (V2Ray) برای دسترسی سرور ایران به تلگرام/OpenAI/گیت‌هاب
  tls/cert-cloudflare.sh    گواهی Let's Encrypt با DNS کلادفلر
  enable-web.sh             انتقال به دامنه‌ی دیگر
docker-compose.yml          postgres، redis، migrate، api، bot، web، proxy
docs/BUILD.md               نصب و نگهداری سرور
docs/DEVELOPMENT.md         همین سند
```

---

## ۴. مدل داده (`packages/db/prisma/schema.prisma`)

| گروه | مدل‌ها | نکته |
|---|---|---|
| کاتالوگ | `Category` (درخت تا ۳ سطح)، `Brand`، `ProductFamily` (خانواده‌ی کالا)، `OptionAxis` (محور مثل سایز)، `Variant` (هر سایز، `sku` داخلی یکتا)، `VariantOption`، `Synonym`، `Media` | `Variant.stock` دستی (۰ = ناموجود)؛ `ProductFamily.packOnly` = فقط کارتنی |
| قیمت | `PriceList` (دارای تاریخ و وضعیت پیش‌نویس/منتشر)، `Price`، `PriceImportRow`، `PriceGroup`، `CustomerPrice` (قیمت اختصاصی) | قیمت ناموجود = `NULL` با `PriceStatus.INQUIRY` |
| تخفیف | `PaymentTerms` (درصد نقدی، درصد مدت‌دار، ماه چک)، `CustomerCategoryDiscount`، `SpecialDiscount` («تخفیف ویژه»: EXTRA/FIXED) | بهترین تخفیف ویژه برنده است، جمع نمی‌شوند |
| کاربر و مشتری | `User` (هر کاربر تلگرام، `staffRole` اختیاری)، `Customer` (`code` از ۱۰۰۱، `supportId` = کارشناس فروش)، `CustomerMember`، `JoinRequest`، `Invite` | |
| سفارش | `Order` (`number` خودافزا)، `OrderItem`، `OrderStatusEvent`، `Proforma` (مهلت ۴۸ ساعت)، `Shipment` | `PayMode`: `CASH` نقدی، `TERM` مدت‌دار |
| مالی | `Invoice`، `InvoiceItem`، `Payment` (نقد، واریز، چک با سررسید) | |
| گفتگو | `Conversation`، `Message`، `AssistantDraft` | |
| سیستم | `Setting` (کلید/مقدار JSON)، `AuditLog`، `Broadcast`، `Document` | |

**وضعیت‌های سفارش** (`OrderStatus`، متن فارسی در `STATUS_FA` در `orders.service.ts`):

```
SUBMITTED → SALES_REVIEW → (اگر قیمت/تعداد عوض شد) PROFORMA_SENT → مشتری تأیید → SALES_APPROVED
         → CONFIRMED (تأیید نهایی مدیر؛ فاکتور خودکار) → PREPARING → SHIPPED → DELIVERED
شاخه‌ها: NEEDS_FIX، PROFORMA_EXPIRED، REJECTED، CANCELLED
```

**کلیدهای Setting که در کد استفاده می‌شوند:** `owner.telegramIds`، `owner.transfer`، `sale.appBonusPct`، `proforma.ttlHours`، `bot.introVideo`، `seen.<userId>` (زمان آخرین بازدید هر صفحه‌ی پنل برای شمارنده‌ها). قبل از اضافه کردن کلید جدید، با `grep -rn "setting\." apps/api/src` الگو را ببینید.

**قواعد داده که نباید شکسته شوند:**
1. قیمتی که در لیست نیست یا «بزودی» است هرگز صفر یا عدد ساختگی نمی‌شود: `NULL` و نمایش «استعلامی».
2. «کد کالا»ی حسابداری یکتا نیست (۸۲ تکراری)؛ کلید هر سایز `sku` داخلی است.
3. مبالغ `BigInt` (ریال) هستند و در JSON رشته می‌روند. در کلاینت با `BigInt(...)` یا `fa()` کار کنید، نه `Number`.
4. نقش‌ها فقط از دیتابیس خوانده می‌شوند، نه از چیزی که کلاینت می‌فرستد.
5. هیچ داده‌ی ساختگی (قیمت، آمار، عکس، مشتری نمونه) در محیط واقعی نباشد. کاتالوگ seed واقعی است (لیست‌های آبان ۱۴۰۵).
6. درصد تخفیف یک مشتری را هرگز به مشتری دیگر یا در محتوای تبلیغاتی نشان ندهید.

---

## ۵. منطق اصلی کسب‌وکار

### قیمت هر مشتری (`apps/api/src/orders/pricing.ts` و `packages/shared/src/money.ts`)
1. قیمت لیست از `PriceList` منتشرشده‌ی فعال.
2. اگر `CustomerPrice` برای آن کالا هست، همان (بر همه مقدم).
3. وگرنه قیمت لیست منهای درصد مشتری برای نوع فروش (`cashPct` یا `termPct`)؛ اگر برای دسته‌ی کالا (یا دسته‌ی بالاتر) درصد جدا هست، آن.
4. «تخفیف ویژه»ی بهتر (برای همه یا همان مشتری، با شرط حداقل کارتن و بازه‌ی تاریخ) جایش می‌نشیند.
تابع اصلی `quote(prisma, variantIds, customerId, mode, terms)` است. هر جایی که قیمت نشان داده یا ذخیره می‌شود باید از همین بگذرد.

### روند تأیید
مشتری یا ایجنت سفارش می‌دهد → پیام با دکمه برای کارشناس فروش همان مشتری (یا همه‌ی کارشناس‌ها) → کارشناس قیمت استعلامی را می‌گذارد، تأیید/اصلاح/رد → اگر چیزی عوض شد پیش‌فاکتور برای تأیید مشتری → مدیر «تأیید نهایی» (پیام تلگرام و در صورت تنظیم، پیامک کاوه‌نگار) → فاکتور خودکار → انبار. همه‌ی گذارها در `OrdersService.decide()` با جدول «از کدام وضعیت به کدام» چک می‌شوند؛ وضعیت را جای دیگری مستقیم عوض نکنید.

### ایجنت فروش
همه‌ی پیام‌های مشتری (ربات و گفتگوی مینی‌اپ) اول به ایجنت می‌رسد. قاعده‌ی مهم در prompt: **هرگز ادعای کاری را نکند که ابزاری آن را تأیید نکرده** (یک بار گفته بود سفارش حذف شد در حالی که نشده بود). کارفرما ایجنت را «فوق هوشمند» می‌خواهد و سپردن به کارشناس فقط آخرین راه است. اگر کارمندی در ۳۰ دقیقه‌ی اخیر در آن گفتگو پیام داده باشد، ایجنت ساکت می‌ماند. `SALES_AGENT=0` ایجنت را خاموش می‌کند.

### اعلان‌ها
کارفرما پیام کم می‌خواهد: انتشار موفق بی‌صداست، فقط خطا خبر داده می‌شود؛ پشتیبان هفتگی بی‌صدا فرستاده می‌شود؛ هشدار کمبود دیسک حداکثر روزی یک بار. پیام جدید برای مدیر اضافه نکنید مگر لازم باشد.

---

## ۶. قواعد کدنویسی

**کلی**
- TypeScript با `strict`. قبل از هر commit: `pnpm typecheck`.
- سبک کد فشرده است: خط‌های بلند (تا حدود ۱۶۰ تا ۲۰۰ نویسه)، توابع کوتاه، بدون لایه‌ی اضافه (repository، DTO class، state manager). کد جدید را شبیه فایل‌های کناری بنویسید.
- **کامنت‌ها انگلیسی** و فقط برای «چرا»، نه «چه». متن‌هایی که کاربر می‌بیند (پیام خطا، برچسب، پیام ربات) **فارسی** هستند.
- پیام خطای API فارسی و قابل نمایش مستقیم به کاربر است: `throw new BadRequestException('…')`. کلاینت `message` را همان‌طور نشان می‌دهد.
- اعداد ورودی کاربر ممکن است فارسی باشند: `toEnDigits`، `rialOf`، `int` در `common/validate.ts`.
- وابستگی جدید فقط وقتی واقعاً لازم است؛ نسخه‌ها دقیق (بدون `^`) در `package.json`.

**API (NestJS)**
- یک ماژول؛ هر کنترلر جدید را در `app.module.ts` ثبت کنید.
- دسترسی: `@UseGuards(SessionGuard)` روی کلاس، و `@Staff('ADMIN', ...)` برای مسیرهای کارکنان. بدون نقش = هر کاربر واردشده. کاربر فعلی با `@Session() s: SessionClaims` (`s.sub` = id کاربر، `s.staff` = نقش).
- مسیرهای کارکنان با `admin/...`، مسیرهای مشتری با `me/...` یا `orders/...`، مسیرهای ربات با `internal/...` و بررسی `x-internal-key`.
- اعتبارسنجی دستی با توابع `validate.ts` (zod فقط برای ابزارهای ایجنت).
- تغییرهای مهم را با `audit(prisma, actorId, action, entity, id, before, after)` ثبت کنید.
- Prisma مستقیم در کنترلر مجاز است؛ منطق مشترک در سرویس (`OrdersService`، `AccountingService`، …).

**فرانت (مینی‌اپ و پنل)**
- React 18 بدون router و بدون کتابخانه‌ی UI/state. مینی‌اپ: stack مسیرها در `App.tsx` (`go`/`back`). پنل: hash به شکل `#<area>/<page>[/<id>]` و درخت منو `AREAS` در `apps/admin/src/App.tsx`.
- درخواست‌ها فقط با `api<T>(path, {method, body})` و در پنل `useApi<T>(path)` از `lib.ts`.
- CSS ساده در `styles.css` هر اپ با متغیرهای رنگ در `:root` و حالت تاریک. پنل مدیریت ابزار کار است (سایدبار تیره، یک رنگ آبی برای عمل)، **نه** شبیه مینی‌اپ. مینی‌اپ رنگ برند زرشکی لوگو (`#5E1430`/`#8A1C46`) و آبی روشن دارد.
- همه‌چیز راست‌به‌چپ، اعداد با `Intl.NumberFormat('fa-IR')`، تاریخ شمسی.
- صفحه‌ی جدید پنل: فایل در `apps/admin/src/pages/`، اضافه به `AREAS` با `roles`، و در صورت نیاز شمارنده در `Queue` و `admin-dashboard.controller.ts`.

**ربات**
- یک فایل `apps/bot/src/main.ts`. منطق کسب‌وکار در API؛ ربات فقط نمایش، دکمه و `internal(...)`.
- callback data کوتاه (محدودیت ۶۴ بایت تلگرام) با الگوی `<پیشوند>:<شناسه>:<عمل>`، مثل `os:<orderId>:sales_ok` (وضعیت سفارش)، `pf:` (پیش‌فاکتور)، `pay:` (رسید).

**Migration**
- مدل را در `schema.prisma` عوض کنید و `pnpm db:migrate` (یعنی `prisma migrate dev`) بزنید. نام پوشه به شکل `YYYYMMDDHHMMSS_name` است.
- migration روی داده‌ی واقعی اجرا می‌شود: ستون جدید یا پیش‌فرض داشته باشد یا nullable باشد.
- **هرگز migration پاک‌کننده‌ی داده بدون اجازه‌ی صریح کارفرما نسازید** (یک بار با اجازه‌اش داده‌ی آزمایشی پاک شد: `20261108235900_clear_test_data`).
- اگر migration روی سرور شکست بخورد، سایت با جدول‌های قبلی بالا می‌ماند و خطا در تلگرام برای مدیر ارشد می‌رود (`AuthService.reportFailedMigrations`). یک migration ناموفق (خطای P3009) همه‌ی بعدی‌ها را متوقف می‌کند؛ رفع آن با `prisma migrate resolve` روی سرور است و قبلش باید از کارفرما اجازه گرفت.

---

## ۷. اجرای محلی و آزمون

پیش‌نیاز: Node 22، pnpm 10 (`corepack enable`)، PostgreSQL 16 (یا `docker compose up -d postgres redis`).

```bash
pnpm install
cp .env.example .env                 # DATABASE_URL را به localhost بدهید؛ BOT_TOKEN یک ربات آزمایشی
pnpm db:migrate                      # migrationها
pnpm --filter @iplast/db build && node packages/db/dist/seed.js   # کاتالوگ
pnpm --filter @iplast/shared build && pnpm --filter @iplast/shared test
pnpm dev:api                         # http://localhost:3000/api/health
pnpm dev:miniapp                     # http://localhost:5173
pnpm dev:admin
pnpm dev:bot                         # فقط اگر یک ربات آزمایشی جدا دارید؛ با توکن ربات اصلی اجرا نکنید
pnpm typecheck
```

مینی‌اپ و پنل بیرون از تلگرام `initData` ندارند. برای آزمون محلی با `signInitData` از `packages/shared` یک initData امضاشده بسازید (همان کاری که `e2e.mjs` می‌کند).

**آزمون‌ها** (CI ندارد؛ قبل از PR دستی اجرا شوند):
```bash
# روی دیتابیس تازه‌ی seed‌شده و API در حال اجرا روی 3999
API=http://localhost:3999 BOT_TOKEN=<توکن آزمایشی> ADMIN_ID=42 node apps/api/test/e2e.mjs
cd apps/api && DATABASE_URL=... JWT_SECRET=... BOT_TOKEN=... NODE_ENV=test node test/ticks.cjs
```
`e2e.mjs` کل روند (کاتالوگ، ورود، سفارش، تأییدها، پیش‌فاکتور، فاکتور، دریافتی، تخفیف ویژه، کارتنی) را می‌آزماید. با هر قابلیت جدید چند گام به آن اضافه کنید.

برای دیدن ظاهر، صفحه‌ها را با Playwright در عرض موبایل (۳۹۰px) و دسکتاپ اسکرین‌شات بگیرید و هر دو تم روشن و تاریک را ببینید.

---

## ۸. روند کار تا امروز

1. کارفرما (HRO) درخواست را به فارسی می‌نویسد.
2. کار روی یک شاخه انجام می‌شود (قبلاً `next`، اخیراً `claude/...`)، typecheck و e2e اجرا و برای تغییر ظاهری اسکرین‌شات گرفته می‌شود.
3. Pull Request به `main` باز می‌شود با توضیح فارسی و ساده (چه چیزی برای کاربر عوض می‌شود).
4. کارفرما بررسی می‌کند. **ادغام در `main` یعنی انتشار روی سرور واقعی**، پس فقط وقتی کارفرما گفت «نصب کن» ادغام می‌شود. کارهای پایداری (deploy، پشتیبان، دیسک) را کارفرما اجازه داده بدون پرسیدن نصب شوند.
5. چند دقیقه بعد سایت را بررسی کنید (`/api/health`). اگر deploy شکست بخورد، پیام خطا با لاگ در تلگرام مدیر ارشد می‌آید.

PRهای تا امروز: #1 روند فروش و پیش‌فاکتور، #2 شرایط فروش نقدی/مدت‌دار، #3 متن‌های ربات و پیشخوان و جذب مشتری، #4 کد مشتری و درخواست عضویت، #5 شمارنده‌های منو و انتقال مدیر ارشد، #6 پاک کردن داده‌ی آزمایشی، #7 درخت دسته و تخفیف ویژه و فروش کارتنی، #8 تا #10 پایداری deploy، #11 پراکسی جلو و پشتیبان هفتگی.

**ترجیحات کارفرما:**
- پاسخ و متن‌ها فارسی، روان و رسمی؛ اصطلاح فنی می‌تواند انگلیسی بماند.
- پنل مدیریت ساده و مرتب (قبلاً «گنگ و به هم ریخته» توصیف شده بود)؛ هر بار ساده‌تر کنید، نه شلوغ‌تر.
- مهم‌ترین‌ها: روند سفارش و تأیید (مشتری → کارشناس → مدیر ارشد)، ارسال، چک و پول، درصد هر مشتری، اسناد مالی، ایجنت هوش مصنوعی. موجودی انبار اولویت ندارد (کارخانه تقریباً همه‌چیز را دارد).
- صفحه‌ی اول مشتری کارت «تکرار آخرین سفارش» نداشته باشد.
- پیام مدیریتی کم.

---

## ۹. سرور و انتشار (وضعیت فعلی)

| مورد | مقدار |
|---|---|
| سرور | mobinhost، داخل ایران، `87.107.129.163`، دیسک ۴۰ گیگ |
| کد | `/opt/iplast` (کپی git از `main`)، تنظیمات `/opt/iplast/.env` |
| دامنه | `iplast.keyfitapp.ir`؛ DNS در Cloudflare حساب کارفرما (zone `keyfitapp.ir`)، رکورد A به `87.107.129.163` با **DNS only** (ابر خاکستری) |
| HTTPS | Let's Encrypt با چالش DNS-01 کلادفلر (`infra/tls/cert-cloudflare.sh`)، تمدید هفتگی خودکار (`iplast-tls.timer`)، گواهی در `/opt/iplast-tls` |
| پراکسی جلو | کانتینر `iplast-front` (Caddy) روی 80/443، کانفیگ `/opt/iplast-front/Caddyfile`. `iplast.keyfitapp.ir` → `172.17.0.1:8088` (کانتینر web) و `keyfitapp.ir` → `172.17.0.1:18090` |
| پروژه‌ی همسایه | **keyfit** (`/opt/keyfit`) روی همین سرور است. به آن دست نزنید. پروژه‌های niva و karnik به درخواست کارفرما حذف شدند |
| دسترسی خروجی | سرور ایران مستقیم به تلگرام/OpenAI/گیت‌هاب/npm نمی‌رسد؛ xray در `/opt/iplast-proxy` (میزبان: `127.0.0.1:10809`، داخل Docker: `proxy:10809`). اشتراک VPN از پنل ← تنظیمات ← «پراکسی سرور» عوض می‌شود |
| انتشار | `iplast-autodeploy.timer` هر ۲ دقیقه `origin/main` را می‌کشد، ایمیج‌ها را یکی‌یکی می‌سازد، `migrate` و سرویس‌ها را بالا می‌آورد. لاگ: `/var/log/iplast-deploy.log`. دستی: `sudo FORCE=1 /usr/local/bin/iplast-autodeploy`. شکست‌خورده تا ۶ بار هر ۲۰ دقیقه دوباره تلاش می‌شود |
| پشتیبان | جمعه ۰۳:۳۰، `/opt/iplast-backups/` (۸ نسخه)، فایل کامل بی‌صدا با ربات برای مدیر ارشد؛ `settings.tar.gz` (شامل رمزها) فقط روی سرور |
| دسترسی به سرور | SSH ورودی از محیط ابری بسته بود؛ کارها یا با انتشار خودکار (pull) یا از راه کنسول VNC پنل mobinhost انجام شده است |

جزئیات نصب و بازگردانی: [BUILD.md](BUILD.md).

**درس‌هایی که گران تمام شد:**
- **دیسک پر (۲۰۲۶-۱۱-۰۹):** دیسک ۴۰ گیگی ۱۰۰٪ پر شد، PostgreSQL با `ENOSPC` متوقف شد و چند deploy و یک migration شکست خورد. حالا autodeploy ایمیج‌ها و build cache قدیمی را پاک می‌کند (هرگز volume را)، لاگ کانتینرها محدود است (۳×۲۰ مگ) و زیر ۵ گیگ هشدار می‌دهد. اگر deploy با خطای عجیب شکست خورد، اول `df -h` را ببینید.
- **migration ناموفق** همه‌ی بعدی‌ها را قفل می‌کند (P3009). بعد از رفع علت: `prisma migrate resolve --rolled-back <name>` و بعد `migrate deploy`، با اجازه‌ی کارفرما.
- **ربات و پراکسی:** grammY به `HTTPS_PROXY` اعتنا نمی‌کند؛ `TunnelAgent` در `apps/bot/src/main.ts` لازم است. کانتینر proxy باید `/etc/ssl/certs` را mount کند.
- **کنسول VNC مرورگر** نویسه‌های shift‌دار را گاهی اشتباه تایپ می‌کند؛ دستورهای کوتاه یا اسکریپت.
- **سرور فقط از داخل ایران** در دسترس است؛ ابزارهای خارج از ایران ممکن است سایت را نبینند.

---

## ۱۰. ربات تلگرام

- نام: `@iplast_sellerbot`؛ توکن از @BotFather، در `BOT_TOKEN` در `.env` سرور.
- آدرس دکمه‌ی منو از `MINIAPP_URL` خوانده و هر ۲ دقیقه خودکار تنظیم می‌شود.
- `/start` بسته به نقش دکمه‌ی متفاوت نشان می‌دهد؛ `/start ref_<کد>` لینک دعوت کارشناس؛ اولین `/start` ویدیوی معرفی را می‌فرستد. `/admin` پنل را برای کارکنان باز می‌کند.
- ویدیوی آموزشی: مدیر ویدیو را با کپشن `#آموزش` به ربات می‌فرستد.
- پیام متنی/صوتی/عکس/PDF مشتری به ایجنت و در صورت نیاز به کارشناس می‌رسد؛ پاسخ کارشناس از ربات به مشتری برمی‌گردد.
- برای آزمون محلی یک ربات جدا از @BotFather بسازید؛ دو برنامه همزمان با یک توکن polling کنند، یکی پیام‌ها را از دست می‌دهد.

## ۱۱. پنل مدیریت

آدرس `/admin/`؛ داخل تلگرام با حساب خود کارمند باز می‌شود. منو (درخت `AREAS` در `apps/admin/src/App.tsx`):

پیشخوان · سفارش‌ها (منتظر کارشناس، منتظر تأیید نهایی، همه، ثبت سفارش تلفنی) · گفتگوها · مشتریان (همه، منتظر تأیید، درخواست عضویت) · مالی (مانده‌ی حساب‌ها، رسیدهای پرداخت) · جذب مشتری · انبار و ارسال · کاتالوگ (کالاها، دسته‌بندی‌ها، تخفیف ویژه، به‌روزرسانی قیمت) · تنظیمات (ایجنت هوش مصنوعی، کارکنان، پیام و اعلان، پراکسی سرور).

شمارنده‌ی هر منو «جدید از آخرین بازدید» است (`POST /admin/dashboard/seen`).

---

## ۱۲. رمزها و دسترسی‌ها کجا هستند

| چیز | محل |
|---|---|
| `BOT_TOKEN`، `JWT_SECRET`، `INTERNAL_KEY`، رمز PostgreSQL | `/opt/iplast/.env` روی سرور (`chmod 600`) |
| `OPENAI_API_KEY`، `OPENAI_MODEL`، `OPENAI_TRANSCRIBE_MODEL`، `OPENAI_PRICE_MODEL` | همان `.env` |
| `KAVENEGAR_API_KEY`، `ADMIN_SMS_NUMBERS` (هنوز داده نشده) | همان `.env` |
| `ADMIN_TELEGRAM_IDS` (مدیر ارشد اول) | همان `.env`؛ بعد از انتقال، Setting `owner.telegramIds` |
| توکن Cloudflare (Edit zone DNS، zone `keyfitapp.ir`) | `/opt/iplast-tls/cf-token` |
| اشتراک VPN و کانفیگ xray | `/opt/iplast-proxy/` |
| حساب گیت‌هاب، Cloudflare، mobinhost، @BotFather، OpenAI | نزد کارفرما |

فهرست کامل متغیرها: [`.env.example`](../.env.example). متغیرهایی که فقط سرور ایران دارد در BUILD.md بخش ۴.۲.

اگر توکنی لو رفت: ربات با `/revoke` در @BotFather، Cloudflare از داشبورد، OpenAI از داشبورد OpenAI؛ مقدار جدید را در `.env` بگذارید و `docker compose up -d`.

---

## ۱۳. نمونه: افزودن یک قابلیت از صفر تا سرور

فرض: «یادداشت داخلی روی مشتری که فقط کارکنان می‌بینند».
1. `schema.prisma`: `note String?` به `Customer`. سپس `pnpm db:migrate --name customer_note`.
2. API: در `admin-customers.controller.ts` فیلد را در `PATCH` بپذیرید (`@Staff('ADMIN','SALES')`)، طول را چک کنید، `audit(...)`.
3. پنل: در `apps/admin/src/pages/Customers.tsx` یک `textarea` و ذخیره با `api('/admin/customers/'+id, {method:'PATCH', body:{note}})`.
4. `pnpm typecheck`، یک گام در `e2e.mjs`، اسکرین‌شات.
5. شاخه، commit با پیام انگلیسی کوتاه از دید کاربر، PR به `main` با توضیح فارسی.
6. بعد از «نصب کن» کارفرما: ادغام، و چند دقیقه بعد بررسی سایت.

---

## ۱۴. شروع کار با یک دستیار هوش مصنوعی دیگر

این متن را همراه دسترسی به مخزن به دستیار بدهید:

> تو روی پروژه‌ی iPlast کار می‌کنی (مخزن `oftadeh/iplast`). اول `docs/DEVELOPMENT.md`، بعد `docs/BUILD.md` و `packages/db/prisma/schema.prisma` را کامل بخوان. قواعد بخش ۴ و ۶ را رعایت کن: قیمت ساختگی نساز، مبالغ BigInt ریال، متن کاربر فارسی، کامنت انگلیسی، سبک کد مثل فایل‌های کناری. روی یک شاخه کار کن، `pnpm typecheck` و آزمون e2e را اجرا کن و PR به `main` باز کن. ادغام در `main` روی سرور واقعی منتشر می‌شود، پس بدون اجازه‌ی من ادغام نکن. هیچ رمزی را در کد یا commit نگذار. migration پاک‌کننده‌ی داده و هر کار روی سرور که برگشت‌پذیر نیست را اول از من بپرس. با من فارسی صحبت کن.

اگر دستیار به سرور دسترسی ندارد (معمولاً ندارد)، همان انتشار خودکار کافی است: کد را به `main` برسانید و سرور خودش به‌روز می‌شود. برای کار مستقیم روی سرور، دستورها را از BUILD.md در کنسول mobinhost اجرا کنید.
