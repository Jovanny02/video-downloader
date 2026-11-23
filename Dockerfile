# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src src
COPY test test
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package*.json ./
COPY sql sql
COPY fixtures/catalog fixtures/catalog
COPY test/stack.mjs test/stack.mjs
USER node
CMD ["node","dist/src/api.js"]

FROM api AS worker
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
# Freeze the OS dependency set as well as the npm/browser revision.
RUN node -e "require('fs').writeFileSync('/tmp/debian-roots.pem',require('tls').rootCertificates.join('\n'))" \
 && echo 'Acquire::https::CaInfo "/tmp/debian-roots.pem";' > /etc/apt/apt.conf.d/98bootstrap-ca \
 && sed -i 's|http://deb.debian.org/debian-security|https://snapshot.debian.org/archive/debian-security/20261120T000000Z|;s|http://deb.debian.org/debian|https://snapshot.debian.org/archive/debian/20261120T000000Z|' /etc/apt/sources.list.d/debian.sources \
 && echo 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99snapshot \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm /etc/apt/apt.conf.d/98bootstrap-ca /tmp/debian-roots.pem \
 && node node_modules/playwright-core/cli.js install --with-deps chromium --only-shell \
 && rm -rf /var/lib/apt/lists/*
USER node
CMD ["node","dist/src/worker.js"]
