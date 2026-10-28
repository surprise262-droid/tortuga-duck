FROM node:24-bookworm-slim

# Шрифты с кириллицей для карточек приветствия
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
CMD ["npx", "tsx", "src/index.ts"]
