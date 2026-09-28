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

# Manifests only for the viewer's own dependency closure, so this layer -- and the
# filtered install below -- stay cached across source-only changes. Deliberately
# excludes packages/cli: it depends on @onirenaud/node-webgl and webgpu (Dawn) for
# headless rendering, neither of which ships a linux-x64 prebuild, so pnpm would fall
# back to compiling them from source -- which node:26-slim has no toolchain for.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json tsconfig.node.json ./
COPY packages/renderers/package.json packages/renderers/tsconfig.json ./packages/renderers/
COPY packages/scenes/package.json packages/scenes/tsconfig.json ./packages/scenes/
COPY packages/viewer/package.json ./packages/viewer/
COPY submodules/three.js/package.json ./submodules/three.js/
COPY submodules/three-gpu-pathtracer/package.json ./submodules/three-gpu-pathtracer/

# Only fetches/installs the viewer + its workspace deps (renderers, scenes, the three.js
# and three-gpu-pathtracer submodules) -- packages/cli and its native deps are never
# resolved, downloaded, or built for this image.
RUN pnpm install --filter '@ss-fidelity/viewer...' --frozen-lockfile --prefer-offline

# Includes submodules/ (three.js examples are served at /three-examples/) and results/ (served at /api/results/)
COPY . .

# packages/cli's *source* is now present (tsconfig project-reference resolution needs
# the file), but it was never installed above. Without verify-deps-before-run=false,
# pnpm would notice cli is "missing" from node_modules and silently re-run a full,
# unfiltered `pnpm install` before each script below -- reintroducing node-webgl/webgpu.
ENV pnpm_config_verify_deps_before_run=false
RUN pnpm --filter './submodules/three.js' build
RUN pnpm exec tsc -b packages/renderers
RUN pnpm --filter '@ss-fidelity/viewer' build

EXPOSE 8080

# cwd /app is the repo root the server resolves results/ and submodules/ from
CMD ["node", "/app/packages/viewer/.output/server/index.mjs"]
