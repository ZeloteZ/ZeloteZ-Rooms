FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

WORKDIR /app
ENV NODE_ENV=production APP_DATA_DIR=/data
RUN install -d -m 0700 -o node -g node /data /watch-data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs appearance.mjs auth.mjs bootstrap.mjs channel-management.mjs community.mjs direct.mjs history.mjs http.mjs locale.mjs notifications.mjs presence.mjs reactions.mjs stream-chat.mjs streams.mjs tutorials.mjs voice.mjs watch-parties.mjs ./
USER node
CMD ["node", "server.mjs"]
