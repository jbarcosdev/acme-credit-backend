# syntax=docker/dockerfile:1
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
ARG SERVICE
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@acme/${SERVICE}..."
RUN pnpm --filter "@acme/${SERVICE}..." build
RUN pnpm --filter "@acme/${SERVICE}" deploy --legacy --prod /out/runtime
RUN pnpm --filter "@acme/${SERVICE}" deploy --legacy /out/migrate

FROM node:${NODE_VERSION}-slim AS migrate
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY --from=build /out/migrate .
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM node:${NODE_VERSION}-slim AS runtime
ARG SERVICE
ARG PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
ENV PORT=${PORT}
WORKDIR /app
COPY --from=build /out/runtime .
USER node
EXPOSE ${PORT}
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/main.js"]
