FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NODE_ENV=production \
    API_PORT=5174 \
    HOST=0.0.0.0

RUN corepack enable

WORKDIR /app

COPY . .

RUN pnpm install --frozen-lockfile \
    && pnpm run build \
    && mkdir -p /app/data/cache \
    && chown -R node:node /app

USER node

EXPOSE 5174

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||5174)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "apps/web/api-server.ts"]
