# XARB bot server (server/). Deployed to Fly.io — see server/README.md.
FROM node:24-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The server runs the website's own quote engine, so it needs src/ as well,
# plus vercel.json (the upstream table) and api/ (keyed upstreams).
COPY tsconfig.json vercel.json ./
COPY api ./api
COPY src ./src
COPY server ./server

ENV NODE_ENV=production PORT=8080 DB_PATH=/data/xarb.db
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "server/main.ts"]
