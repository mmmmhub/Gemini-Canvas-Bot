# 1. استخدام صورة Playwright لتوفير المتصفحات المطلوبة
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# 2. تحديد مسار العمل
WORKDIR /app

# 3. تثبيت pnpm عالمياً لحل أزمة الـ workspaces
RUN npm install -g pnpm@8.15.5

# 4. نسخ جميع ملفات المشروع
COPY . .

# 5. تثبيت جميع الحزم (سيقوم pnpm تلقائياً بربط api-zod وغيرها)
RUN pnpm install

# 6. أمر تشغيل السيرفر النهائي
CMD ["npx", "tsx", "artifacts/api-server/src/index.ts"]
