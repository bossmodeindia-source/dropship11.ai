# ─────────────────────────────────────────────────────────────────────────────
# AI Empire V64 — Multi-Stage Production Dockerfile
# Targets: Railway (API + Worker), any Docker host
#
# Stages:
#   1. deps     — install production deps (cached separately from dev)
#   2. builder  — compile TypeScript
#   3. runner   — minimal runtime image (~200MB vs ~800MB full Node)
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Install ALL deps (including dev — needed for nest build) ─────────
FROM node:20-alpine AS deps
WORKDIR /app

# Install native build tools for argon2, bcryptjs bindings
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --frozen-lockfile --legacy-peer-deps

# ── Stage 2: Build TypeScript ─────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── Stage 3: Prune to production deps only ────────────────────────────────────
FROM node:20-alpine AS prod-deps
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --frozen-lockfile --omit=dev --legacy-peer-deps

# ── Stage 4: Minimal runtime ──────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Install FFmpeg — required by VideoPipelineOrchestrator for video assembly (V61).
# Upgrade Alpine security packages and remove bundled npm from the runtime image.
# The container starts with `node dist/src/main.js`, so npm/npx are not required at runtime.
RUN apk upgrade --no-cache && \
    apk add --no-cache ffmpeg && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser  --system --uid 1001 nestjs

# Copy only what's needed to run
COPY --from=prod-deps --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder   --chown=nestjs:nodejs /app/dist         ./dist
COPY --from=builder   --chown=nestjs:nodejs /app/migrations   ./migrations
COPY --from=builder   --chown=nestjs:nodejs /app/scripts      ./scripts
COPY --chown=nestjs:nodejs package.json ./

USER nestjs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Default: start the API server
# Override with: docker run ... node dist/src/worker.js
CMD ["node", "dist/src/main.js"]
