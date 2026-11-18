FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"
COPY LICENSE LICENSING.md /usr/share/licenses/zelotez-rooms/
ENV NODE_ENV=production APP_DATA_DIR=/data
RUN install -d -m 0700 -o node -g node /data /watch-data
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server/qrcode-generator-license.json ./node_modules/qrcode-generator/LICENSE.json
COPY server/*.mjs ./
USER node
CMD ["node", "server.mjs"]
