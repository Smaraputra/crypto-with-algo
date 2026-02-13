# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_ vars are inlined at build time
ARG NEXT_PUBLIC_BINANCE_WS_URL=wss://stream.binance.com:9443
ENV NEXT_PUBLIC_BINANCE_WS_URL=$NEXT_PUBLIC_BINANCE_WS_URL

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]

# Stage 4: Seeder (optional build target)
FROM node:22-alpine AS seeder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
CMD ["npx", "tsx", "scripts/seed.ts"]
