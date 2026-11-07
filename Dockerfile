FROM node:24-bookworm-slim

# Шрифты с кириллицей для карточек приветствия
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
# Один процесс Node вместо цепочки npx → tsx → node: меньше памяти, и сигнал остановки доходит сразу до бота
CMD ["node", "--import", "tsx", "src/index.ts"]
