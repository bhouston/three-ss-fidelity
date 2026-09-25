# syntax=docker/dockerfile:1.6
# Build from the repo root with submodules checked out: docker build -f packages/viewer/Dockerfile .
FROM --platform=linux/amd64 node:26-slim AS base

ENV PNPM_HOME="/pnpm" \
    PATH="$PNPM_HOME:$PATH" \
    NODE_ENV=production \
    PORT=8080 \
    CI=true

# Keep in sync with `packageManager` in the root package.json.
RUN npm install -g pnpm@11.0.8

WORKDIR /app

# Copy dependency manifests first so this layer is cacheable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Fetch deps in container so platform-specific optional deps (e.g. @tailwindcss/oxide-linux-x64-gnu) install
RUN pnpm fetch --reporter=silent

# Includes submodules/ (three.js examples are served at /three-examples/) and results/ (served at /api/results/)
COPY . .

RUN pnpm install --frozen-lockfile --prefer-offline

RUN pnpm build

EXPOSE 8080

# cwd /app is the repo root the server resolves results/ and submodules/ from
CMD ["node", "/app/packages/viewer/.output/server/index.mjs"]
