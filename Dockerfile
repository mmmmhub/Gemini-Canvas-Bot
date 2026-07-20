FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# تثبيت أحدث إصدار من pnpm
RUN npm install -g pnpm@latest

COPY . .

RUN pnpm install

CMD ["npx", "tsx", "artifacts/api-server/src/index.ts"]
