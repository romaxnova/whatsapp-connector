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

# Whisper (whisper.cpp) transcribes voice notes on this server when no ElevenLabs key is set: free, and the
# audio never leaves the server. Built for any x86-64 or arm64 CPU (no host-specific instructions), with the
# multilingual "small" model (quantized, 181 MB), checked against its published SHA-256.
FROM node:24-slim AS whisper
ARG WHISPER_CPP_VERSION=v1.8.2
ARG WHISPER_MODEL=ggml-small-q5_1.bin
ARG WHISPER_MODEL_SHA256=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git cmake make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_VERSION" https://github.com/ggml-org/whisper.cpp /src \
  && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
  && cmake --build /src/build -j"$(nproc)" --target whisper-cli \
  && mkdir -p /opt/whisper \
  && cp /src/build/bin/whisper-cli /opt/whisper/ \
  && curl -fsSL --retry 3 -o "/opt/whisper/$WHISPER_MODEL" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL" \
  && echo "$WHISPER_MODEL_SHA256  /opt/whisper/$WHISPER_MODEL" | sha256sum -c - \
  && rm -rf /src

FROM node:24-slim
ENV NODE_ENV=production PORT=8080
# ffmpeg turns ElevenLabs speech into WhatsApp voice notes (Ogg Opus) for whatsapp_send_voice, and voice
# notes into 16 kHz audio for Whisper.
# tesseract reads the text in photos and scanned PDFs (OCR) on this server, in English, French and Russian;
# poppler-utils (pdftoppm) turns the pages of a scanned PDF into images for it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra tesseract-ocr-rus poppler-utils \
  && rm -rf /var/lib/apt/lists/*
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
COPY --from=whisper /opt/whisper /opt/whisper
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
