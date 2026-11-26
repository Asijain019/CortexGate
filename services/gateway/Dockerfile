# CortexGate gateway image (also used for the BullMQ worker).
#   docker build -t cortexgate-gateway services/gateway
#   docker run --rm -p 127.0.0.1:3003:3003 --env-file services/gateway/.env cortexgate-gateway
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3003 \
    DATA_DIR=/data

WORKDIR /app

# Dependencies first so the layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Persistent state (cache, request history, provider health/stats, encrypted
# provider keys, client keys, .secret). Created here owned by `node` so a fresh
# named volume mounted at /data inherits that ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "src/index.js"]
