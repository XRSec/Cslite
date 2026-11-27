FROM node:22-alpine AS builder
WORKDIR /build

COPY package.json package-lock.json tsconfig.json tsconfig.web.json ./
RUN npm ci

COPY shared ./shared
COPY server ./server
COPY web ./web

RUN if [ -f web/build.mjs ]; then npm run build:web; fi
RUN ./node_modules/.bin/esbuild server/src/entry-node.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --minify \
  --external:node:sqlite \
  --external:mysql2 \
  --external:mysql2/promise \
  --outfile=/build/dist/server.mjs

FROM node:22-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist/server.mjs /app/dist/server.mjs
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    CSLITE_PORT=9000 \
    CSLITE_DB_PATH=/app/data/cslite.db

VOLUME ["/app/data"]
EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CSLITE_PORT || 9000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "/app/dist/server.mjs"]
