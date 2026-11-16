FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production APP_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.mjs appearance.mjs auth.mjs bootstrap.mjs channel-management.mjs community.mjs history.mjs http.mjs locale.mjs notifications.mjs reactions.mjs stream-chat.mjs streams.mjs voice.mjs ./
USER node
CMD ["node", "server.mjs"]
