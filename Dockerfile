# WhatsApp Connector: one image for Railway (which builds this file by itself), Docker Compose or any container host.
# Everything the server keeps (one SQLite file: the WhatsApp session and the message index) lives in /data: mount a volume there, or each restart starts afresh.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev --no-audit --no-fund \
  && find dist \( -name '*.test.js' -o -name '*.test.js.map' \) -delete

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
# Memory: glibc keeps freed memory for reuse, and after each larger buffer than
# before (an attachment, an upload, a PDF being read) it raises the size below
# which it keeps it, so resident memory climbs in steps and never comes down.
# Fixed thresholds hand blocks over 128 KB back to the system once freed, and two
# arenas stop each thread from keeping its own reserve. See docs/REFERENCE.md, Memory.
ENV MALLOC_ARENA_MAX=2 MALLOC_MMAP_THRESHOLD_=131072 MALLOC_TRIM_THRESHOLD_=131072
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/wa-entrypoint
RUN chmod 0755 /usr/local/bin/wa-entrypoint && mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# Starts as root only to hand the data volume to the "node" user, then runs the server as that user.
ENTRYPOINT ["wa-entrypoint"]
# A 2 MB young generation instead of up to 32 MB: Node keeps that space once a
# burst of requests has grown it, and this server's traffic does not need it.
CMD ["node", "--max-semi-space-size=2", "--disable-warning=ExperimentalWarning", "dist/server.js"]
