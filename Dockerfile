# API do Gestor Br.
#   docker build -t gestor-api .                    -> imagem da API
#   docker build --target migrate -t gestor-migrate . -> roda "prisma migrate deploy" antes do deploy
FROM node:26-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS prod-deps
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production PORT=4000 UPLOAD_DIR=/app/uploads TZ=America/Sao_Paulo
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
