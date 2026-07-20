# استخدام صورة Playwright الرسمية المبنية على Ubuntu لتوفير جميع متطلبات المتصفح
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# إعداد مجلد العمل داخل حاوية Railway
WORKDIR /app

# نسخ ملفات الحزم أولاً لتسريع عملية البناء (Caching)
COPY package*.json ./

# تثبيت الاعتماديات
RUN npm install

# نسخ باقي ملفات المشروع
COPY . .

# أمر تشغيل السيرفر
CMD ["npm", "start"]

