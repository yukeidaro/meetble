# Meetble for the cloud (Cloud Run, or any Docker host). One container: the Node server, the TypeScript research
# pipeline, the Python planner, and a headless Chromium + browser-use for the signed-in LinkedIn / X / Luma steps.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv chromium fonts-noto-cjk ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir "browser-use[anthropic]>=0.13,<2"

COPY . .
RUN npm run build && rm -rf node_modules && npm ci --omit=dev --no-audit --no-fund

# Cloud Run sets PORT. GOOGLE_CLIENT_ID turns on Google sign-in and per-account storage under MEETBLE_DATA.
ENV HOST=0.0.0.0 PORT=8080 PYTHON=/app/.venv/bin/python BROWSER_PYTHON=/app/.venv/bin/python \
    CHROME_PATH=/usr/bin/chromium MEETBLE_DATA=/data PYTHONUTF8=1
EXPOSE 8080
CMD ["node", "server.mjs"]
