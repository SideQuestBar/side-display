# syntax=docker/dockerfile:1

# ---- build the client -------------------------------------------------------
FROM oven/bun:1.4.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- production dependencies only (the client's are already bundled) ---------
FROM oven/bun:1.4.4 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- runtime ----------------------------------------------------------------
FROM oven/bun:1.4.4-slim
WORKDIR /app
ENV NODE_ENV=production \
    SIDEDISPLAY_DATA_DIR=/data \
    SIDEDISPLAY_PORT=4380

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/client ./dist/client
COPY package.json ./
COPY drizzle ./drizzle
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY docker-entrypoint.sh /usr/local/bin/sidedisplay-entrypoint

RUN chmod +x /usr/local/bin/sidedisplay-entrypoint && mkdir -p /data && chown bun:bun /data

VOLUME /data
EXPOSE 4380
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "fetch('http://127.0.0.1:' + process.env.SIDEDISPLAY_PORT + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["sidedisplay-entrypoint"]
CMD ["bun", "src/server/index.ts"]
