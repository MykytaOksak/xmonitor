# XARB bot server (server/), which also serves the website. Deployed to
# Fly.io — see server/README.md.

# ——— the website: Vite build of src/ into dist/ ———
FROM node:24-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build

# ——— the server ———
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The server runs the website's own quote engine, so it needs src/ as well,
# plus upstreams.json (the /px route table).
COPY tsconfig.json upstreams.json ./
COPY src ./src
COPY server ./server
COPY --from=web /app/dist ./dist

ENV NODE_ENV=production PORT=8080 DB_PATH=/data/xarb.db WEB_DIST=/app/dist
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "server/main.ts"]
