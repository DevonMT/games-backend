FROM node:22-bookworm-slim

WORKDIR /app

# Build tools for better-sqlite3's native addon (falls back to compile if no prebuilt).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN mkdir -p /app/data

EXPOSE 8787

CMD ["npm", "start"]
