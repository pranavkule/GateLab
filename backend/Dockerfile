FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-fund --no-audit

COPY backend ./backend

ENV NODE_ENV=production
EXPOSE 3010 3011 3012 3013 4011 4012 4013 4014 4015 4016 5010 5011

RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3010/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));"

CMD ["node", "backend/index.js"]
