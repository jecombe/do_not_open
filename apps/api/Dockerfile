# syntax=docker/dockerfile:1
# Built from the repository root: `docker build -f apps/api/Dockerfile .`

FROM node:24-alpine AS build
RUN npm install -g pnpm@9.9.0
WORKDIR /repo
# Manifests first, so dependencies are cached until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/game-spec/package.json packages/game-spec/
COPY packages/generator/package.json packages/generator/
COPY packages/chain-adapter/package.json packages/chain-adapter/
COPY packages/scene/package.json packages/scene/
COPY packages/contracts-evm/package.json packages/contracts-evm/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY apps/admin/package.json apps/admin/
RUN pnpm install --frozen-lockfile --filter "@dno/api..." --filter "@dno/admin..."
COPY packages/game-spec packages/game-spec
COPY packages/generator packages/generator
COPY packages/chain-adapter packages/chain-adapter
COPY apps/api apps/api
COPY apps/admin apps/admin
RUN pnpm --filter @dno/api build && pnpm --filter @dno/admin build

# One bundled file (and the admin site's static files): no node_modules at run time.
FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /repo/apps/api/dist ./
# The team's admin site, served under /admin when ADMIN_PASSWORD is set.
COPY --from=build /repo/apps/admin/dist ./admin
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "main.js"]
