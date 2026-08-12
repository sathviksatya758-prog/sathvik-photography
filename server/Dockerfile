# syntax=docker/dockerfile:1

# ---------- deps: install once, reused by build + prod stages ----------
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# sharp needs a few native libs at runtime even with prebuilt binaries
RUN apt-get update && apt-get install -y --no-install-recommends libvips openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install

# ---------- build: compile TypeScript + generate Prisma client ----------
FROM deps AS build
WORKDIR /app
COPY . .
RUN npx prisma generate
RUN npm run build

# ---------- production node_modules only ----------
FROM node:20-bookworm-slim AS prod-deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libvips openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY prisma ./prisma
RUN npx prisma generate

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libvips openssl curl && rm -rf /var/lib/apt/lists/* \
  && groupadd -r app && useradd -r -g app app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R app:app /app

USER app
ENV NODE_ENV=production
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
