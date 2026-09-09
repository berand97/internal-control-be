# syntax=docker/dockerfile:1
# Dokploy: contexto = carpeta internal-control-be, Dockerfile = Dockerfile
# Monta un volumen persistente en /data/storage (fotos, plantillas, adjuntos).

# -----------------------------------------------------------------------------
# 1) Dependencias (incluye toolchain para argon2)
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH="${PNPM_HOME}:${PATH}" \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# -----------------------------------------------------------------------------
# 2) Compilación + prune de dependencias de desarrollo
# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

COPY . .
RUN pnpm run build \
  && pnpm prune --prod

# -----------------------------------------------------------------------------
# 3) Runtime mínimo
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DRIVER=project \
    STORAGE_PROJECT_PATH=/data/storage \
    RUN_MIGRATIONS=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data/storage

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --chown=node:node docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh \
  && chown node:node /data /data/storage

# El entrypoint arranca como root solo para chown del volumen y baja a node.
VOLUME ["/data/storage"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--", "./docker-entrypoint.sh"]
