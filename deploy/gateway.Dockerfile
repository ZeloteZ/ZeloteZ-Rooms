FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS player
WORKDIR /build
COPY deploy/player.package.json package.json
COPY deploy/player.package-lock.json package-lock.json
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM nginx:1.30.6-alpine@sha256:901e593c95dc85f5a729f5765516321366ef4ac401821431d408897e95287d0a
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY web/ /srv/www/
COPY --from=player /build/node_modules/hls.js/dist/hls.min.js /srv/www/vendor/hls.min.js
COPY --from=player /build/node_modules/hls.js/LICENSE /srv/www/vendor/hls.LICENSE
COPY --from=player /build/node_modules/qrcode-generator/dist/qrcode.mjs /srv/www/vendor/qrcode-generator.js
COPY server/qrcode-generator-license.json /srv/www/vendor/qrcode-generator-license.json
# Move the whole module graph together so relative imports share one version.
RUN set -eu; cd /srv/www; \
    set -- ./*.js ./*.css ./vendor/hls.min.js ./vendor/qrcode-generator.js; \
    version=$(sha256sum "$@" | sha256sum | cut -c 1-32); \
    mkdir -p "assets/$version"; \
    mv "$@" "assets/$version/"; \
    sed -i -E \
      -e "s#(src|href)=\"/([A-Za-z][A-Za-z0-9_.-]*\.(css|js))\"#\1=\"/assets/$version/\2\"#g" \
      -e "s#src=\"/vendor/hls\.min\.js\"#src=\"/assets/$version/hls.min.js\"#g" index.html guest.html
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-g", "daemon off;"]
