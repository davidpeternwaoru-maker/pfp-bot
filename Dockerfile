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
#
# The placeholder URL is scoped to this one command rather than set as an ENV,
# so it never becomes part of any layer and cannot be mistaken for
# configuration. prisma.config.ts resolves the datasource eagerly and throws
# when it is unset — deliberately, so a migration can never run against a
# fallback — but `generate` only reads the schema and opens no connection.
# Satisfying that check here is cheaper than weakening it everywhere.
RUN DATABASE_URL="postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder"     npx prisma generate
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

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node package.json ./

# Trait artwork ships with the image. The glob means a build with no local
# pack still succeeds rather than failing on a missing path.
COPY --chown=node:node trait-pack[s] ./trait-packs

# Rendered claims are written here. Created with the right owner up front
# because the process runs as node and cannot create a directory under /app.
RUN mkdir -p /app/output/claims && chown -R node:node /app/output

# Never root, and set after the directory above is created: a process that
# reads trait images and writes claim artwork has no business being able to
# write anywhere else in the filesystem.
USER node

EXPOSE 3000

# Node directly rather than through npm: npm would sit between the signal and
# the process, and a SIGTERM that never reaches the app is a shutdown that
# never runs.
CMD ["node", "dist/index.js"]
