# Two stages: everything needed to build stays out of what ships.
#
# The runtime image carries no compiler, no test runner and no source, which
# is both smaller and a smaller surface. What reaches production is compiled
# JavaScript, production dependencies, and the Prisma client.

FROM node:22-slim AS build

WORKDIR /app

# Copied before the source so a code change does not invalidate the dependency
# layer. This is most of the build time on every deploy after the first.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
COPY prisma.config.ts ./
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

# Generated after the source is copied, not before. It writes into
# src/generated, and generating first would leave the result depending on
# .dockerignore excluding that directory from the COPY that follows — correct
# today, and silently wrong the day somebody edits .dockerignore.
RUN npx prisma generate
RUN npm run build

# Reinstalled without dev dependencies, into the tree that gets copied out.
# `npm ci --omit=dev` after the build is what keeps typescript, vitest and
# eslint out of the running container.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim AS runtime

# sharp ships prebuilt binaries for linux-x64-glibc, which this base provides.
# No build toolchain is installed here on purpose: needing one at runtime would
# mean the image is compiling something it should have compiled already.

ENV NODE_ENV=production

WORKDIR /app

# Never root. A process that only reads trait images and writes claim artwork
# has no business being able to write anywhere else in the filesystem.
USER node

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node package.json ./

# Trait artwork and rendered claims. Mounted as a volume in fly.toml so a
# deploy does not discard artwork a member has already claimed.
COPY --chown=node:node trait-pack[s] ./trait-packs

EXPOSE 3000

# Node directly rather than through npm: npm would sit between the signal and
# the process, and a SIGTERM that never reaches the app is a shutdown that
# never runs.
CMD ["node", "dist/index.js"]
