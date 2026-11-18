FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build

WORKDIR /backend
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server/qrcode-generator-license.json ./node_modules/qrcode-generator/LICENSE.json
COPY server/*.mjs ./

WORKDIR /player
COPY deploy/player.package.json package.json
COPY deploy/player.package-lock.json package-lock.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/ /srv/www/
COPY server/qrcode-generator-license.json /srv/www/vendor/qrcode-generator-license.json
# Version the whole module graph together, just as in the standalone gateway.
RUN set -eu; \
    cp node_modules/hls.js/LICENSE /srv/www/vendor/hls.LICENSE; \
    cd /srv/www; \
    cp /player/node_modules/hls.js/dist/hls.min.js vendor/hls.min.js; \
    cp /player/node_modules/qrcode-generator/dist/qrcode.mjs vendor/qrcode-generator.js; \
    set -- ./*.js ./*.css vendor/hls.min.js vendor/qrcode-generator.js; \
    version=$(sha256sum "$@" | sha256sum | cut -c 1-32); \
    mkdir -p "assets/$version"; \
    mv "$@" "assets/$version/"; \
    sed -i -E \
      -e "s#(src|href)=\"/([A-Za-z][A-Za-z0-9_.-]*\.(css|js))\"#\1=\"/assets/$version/\2\"#g" \
      -e "s#src=\"/vendor/hls\.min\.js\"#src=\"/assets/$version/hls.min.js\"#g" index.html guest.html

FROM bluenviron/mediamtx:1.21.4-ffmpeg@sha256:1fa0abbefb6f181bf0da075c65a75505ee43bb9996e4a4b5fd30a4ab7dea01e6 AS media

FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS permissions
RUN apk add --no-cache build-base linux-headers
COPY deploy/rooms-role.c /build/rooms-role.c
RUN cc -std=c11 -static -O2 -Wall -Wextra -Werror -o /build/rooms-role /build/rooms-role.c

FROM nginx:1.30.6-alpine@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a

RUN apk del nginx-module-xslt \
    && apk add --no-cache 'zlib>=1.4-r0' ffmpeg libstdc++ tini \
    && addgroup -g 1000 rooms \
    && adduser -S -D -H -u 1000 -G rooms rooms \
    && install -d -m 0700 -o rooms -g rooms /data /watch-data \
    && install -d -m 0755 /tls
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY --from=build /backend/ /app/
COPY --from=build /srv/www/ /srv/www/
COPY --from=media /mediamtx /usr/local/bin/mediamtx
COPY --from=permissions /build/rooms-role /usr/local/bin/rooms-role
# Node 24.22.3 and MediaMTX 1.21.4 notices from the pinned base releases.
COPY deploy/node.LICENSE deploy/mediamtx.LICENSE /usr/share/licenses/rooms/
COPY deploy/mediamtx.yml /etc/rooms/mediamtx.yml
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/rooms-entrypoint.mjs /app/rooms-entrypoint.mjs
# The internal endpoints share a network namespace in the single container.
RUN ln -s rooms-role /usr/local/bin/ffmpeg \
    && sed -i \
      -e '/^    resolver /d' \
      -e 's/server server:8080 resolve;/server 127.0.0.1:8082;/' \
      -e 's/server mediamtx:8888 resolve;/server 127.0.0.1:8888;/' /etc/nginx/nginx.conf

WORKDIR /app
ENV NODE_ENV=production APP_DATA_DIR=/data WATCH_MEDIA_DIR=/watch-data \
    PUBLIC_ORIGIN=http://127.0.0.1:8080 ROOMS_SETUP_TOKEN_FILE=/data/.rooms-setup-token
USER 1000:1000
VOLUME ["/data", "/watch-data"]
EXPOSE 8080/tcp 1935/tcp 1936/tcp 8189/udp 8189/tcp
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD node /app/rooms-entrypoint.mjs --health
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/rooms-entrypoint.mjs"]
