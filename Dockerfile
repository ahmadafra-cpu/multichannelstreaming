# Multi-Camera Live View — backend + static app (long-running host: VM / PaaS / compose).
# Vercel does NOT use this file (it builds api/index.js as a serverless function).
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# app source
COPY server ./server
COPY public ./public

USER node

EXPOSE 8080
ENV PORT=8080
# A long-running host can also serve streams through the proxy (firewall-proof):
ENV STREAM_MODE=proxy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]
