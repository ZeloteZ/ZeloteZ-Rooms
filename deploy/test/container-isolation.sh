#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: container-isolation.sh IMAGE}
fixtures=$(mktemp -d)
container="rooms-isolation-$(basename "$fixtures")"
cleanup() {
  docker rm --force --volumes "$container" >/dev/null 2>&1 || true
  rm -rf -- "$fixtures"
}
trap cleanup EXIT

mkdir -p "$fixtures/tls" "$fixtures/desktop-downloads/0.1.0"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=rooms.example.test \
  -keyout "$fixtures/tls/privkey.pem" -out "$fixtures/tls/fullchain.pem" >/dev/null 2>&1
chmod 644 "$fixtures/tls/privkey.pem"
printf '{"version":"999.0.0"}\n' > "$fixtures/desktop-downloads/release.json"
printf 'dummy installer\n' > "$fixtures/desktop-downloads/0.1.0/ZeloteZ-Rooms-0.1.0-x64.exe"

docker run --detach --name "$container" --read-only --tmpfs /tmp:mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges --publish 127.0.0.1::8080 \
  --health-interval=1s --health-timeout=5s \
  --env PUBLIC_ORIGIN=https://rooms.example.test --env TRUST_PROXY_IP=1 \
  --env ROOMS_TRUSTED_PROXY_IPS=127.0.0.1 \
  --mount "type=bind,source=$fixtures/desktop-downloads,target=/srv/desktop-downloads,readonly" \
  --mount "type=bind,source=$fixtures/tls,target=/tls,readonly" "$image"

for attempt in {1..30}; do
  status=$(docker inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$container")
  [[ "$status" == 'running healthy' ]] && break
  [[ "$status" == 'running starting' || "$status" == 'running unhealthy' ]] || break
  sleep 1
done
if [[ "$status" != 'running healthy' ]]; then
  docker logs "$container"
  exit 1
fi

port=$(docker port "$container" 8080/tcp)
[[ $(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://$port/api/vault") == 401 ]]
curl --fail --silent --show-error "http://$port/vault" > "$fixtures/vault.html"
vault_asset=$(sed -nE 's/.*src="([^"]+\/vault-share\.js)".*/\1/p' "$fixtures/vault.html")
[[ "$vault_asset" =~ ^/assets/[a-f0-9]{32}/vault-share\.js$ ]]
curl --fail --silent --show-error "http://$port$vault_asset" > "$fixtures/vault-share.js"
[[ -s "$fixtures/vault-share.js" ]]

# Editor modules must travel with the same immutable module graph as the viewer.
curl --fail --silent --show-error --dump-header "$fixtures/index.headers" \
  "http://$port/" > "$fixtures/index.html"
editor_style=$(sed -nE 's/.*href="([^"]+\/vault-editor\.css)".*/\1/p' "$fixtures/index.html")
[[ "$editor_style" =~ ^/assets/[a-f0-9]{32}/vault-editor\.css$ ]]
[[ "$editor_style" == "${vault_asset%/*}/vault-editor.css" ]]
editor_type=$(curl --fail --silent --show-error --output "$fixtures/editor.css" \
  --write-out '%{content_type}' "http://$port$editor_style")
[[ -s "$fixtures/editor.css" && "$editor_type" =~ ^text/css(\;.*)?$ ]]
for module in vault-editor.js vault-media-edit.js vault-pdf-tools.js vault-pdf-worker.js \
  vault-office.js vault-office-editor.js vault-archive.js vault-archive-worker.js vault-archive-viewer.js \
  vault-text-codec.js vault-language-controls.js vault-media-tracks.js vault-media-tracks-worker.js vault-mkv-tracks.js vault-mp4-tracks.js; do
  editor_type=$(curl --fail --silent --show-error --output "$fixtures/editor-module.js" \
    --write-out '%{content_type}' "http://$port${vault_asset%/*}/$module")
  [[ -s "$fixtures/editor-module.js" && "$editor_type" =~ ^(application|text)/(javascript|ecmascript)(\;.*)?$ ]]
done
csp=$(grep --ignore-case '^content-security-policy:' "$fixtures/index.headers")
[[ "$csp" == *"default-src 'self'"* && "$csp" == *"object-src 'none'"* && "$csp" == *"frame-ancestors 'none'"* ]]
[[ "$csp" != *"'unsafe-eval'"* && "$csp" != *"'unsafe-inline'"* ]]

# Check the complete pinned vendor catalog over HTTP, not just the copied files.
rooms_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
curl --fail --silent --show-error "http://$port/vendor/vault-pdf-components.json" > "$fixtures/vault-pdf-components.json"
source_manifest_hash=$(sha256sum "$rooms_source/web/vendor/vault-pdf-components.json")
served_manifest_hash=$(sha256sum "$fixtures/vault-pdf-components.json")
[[ "${source_manifest_hash%% *}" == "${served_manifest_hash%% *}" ]]
jq --exit-status '."pdfjs-dist" == "6.5.438" and ."pdf-lib" == "1.17.1" and
  (.files | type == "object" and length > 0)' "$fixtures/vault-pdf-components.json" >/dev/null
for required in \
  web/vendor/pdfjs-6.5.438/pdf.mjs \
  web/vendor/pdfjs-6.5.438/pdf.worker.mjs \
  web/vendor/pdfjs-6.5.438/LICENSE \
  web/vendor/pdfjs-6.5.438/cmaps/LICENSE \
  web/vendor/pdfjs-6.5.438/cmaps/Adobe-GB1-UCS2.bcmap \
  web/vendor/pdfjs-6.5.438/standard_fonts/LICENSE_FOXIT \
  web/vendor/pdfjs-6.5.438/standard_fonts/LICENSE_LIBERATION \
  web/vendor/pdfjs-6.5.438/standard_fonts/LiberationSans-Regular.ttf \
  web/vendor/pdfjs-6.5.438/standard_fonts/FoxitSerif.pfb \
  web/vendor/pdf-lib-1.17.1/pdf-lib.esm.js \
  web/vendor/pdf-lib-1.17.1/LICENSE.md; do
  jq --exit-status --arg path "$required" '.files[$path].bytes > 0' "$fixtures/vault-pdf-components.json" >/dev/null
done
vendor_count=0
while IFS=$'\t' read -r vendor_path vendor_bytes vendor_hash; do
  [[ "$vendor_path" =~ ^web/vendor/(pdfjs-6\.5\.438|pdf-lib-1\.17\.1)/[A-Za-z0-9_./-]+$ ]]
  [[ "/$vendor_path/" != *'/../'* && "/$vendor_path/" != *'/./'* ]]
  [[ "$vendor_bytes" =~ ^[1-9][0-9]*$ && "$vendor_hash" =~ ^[a-f0-9]{64}$ ]]
  vendor_type=$(curl --fail --silent --show-error --output "$fixtures/vendor-body" \
    --write-out '%{content_type}' "http://$port/${vendor_path#web/}")
  [[ $(wc --bytes < "$fixtures/vendor-body") -eq "$vendor_bytes" ]]
  served_hash=$(sha256sum "$fixtures/vendor-body")
  [[ "${served_hash%% *}" == "$vendor_hash" ]]
  case "$vendor_path" in
    *.mjs|*.js) [[ "$vendor_type" =~ ^(application|text)/(javascript|ecmascript)(\;.*)?$ ]] ;;
  esac
  vendor_count=$((vendor_count + 1))
done < <(jq --raw-output '.files | to_entries[] | [.key, .value.bytes, .value.sha256] | @tsv' "$fixtures/vault-pdf-components.json")
[[ "$vendor_count" -eq $(jq '.files | length' "$fixtures/vault-pdf-components.json") ]]

curl --fail --silent --show-error -H 'X-Real-IP: 192.0.2.24' "http://$port/api/setup" | jq -e '.available == true'
curl --fail --silent --show-error "http://$port/api/desktop/release" |
  jq -e '.product == "zelotez-rooms" and .protocol == 1 and (.version | (type == "string" and . != "999.0.0"))'
for path in /api/desktop-downloads /downloads/desktop/0.1.0/ZeloteZ-Rooms-0.1.0-x64.exe; do
  [[ $(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://$port$path") == 404 ]]
done
docker exec "$container" wget -qO /dev/null --header='X-Real-IP: 192.0.2.25' http://127.0.0.1:8080/api/setup
logs=$(docker logs "$container" 2>&1)
[[ "$logs" != *'192.0.2.24 "GET /api/setup"'* ]]
[[ "$logs" == *'192.0.2.25 "GET /api/setup" 200'* ]]

docker exec "$container" rooms-role api /bin/sh -ec '
  head -c 1 /data/community.sqlite >/dev/null
  touch /watch-data/permission-probe
  ! head -c 1 /tls/privkey.pem >/dev/null 2>&1
'
for role in gateway media relay; do
  docker exec "$container" rooms-role "$role" /bin/sh -ec '
    if head -c 1 /data/community.sqlite >/dev/null 2>&1 || touch /watch-data/forbidden-probe 2>/dev/null; then
      echo "Unexpected access to application volume" >&2
      exit 1
    fi
  '
done
docker exec "$container" rooms-role media /bin/sh -ec '
  head -c 1 /tls/privkey.pem >/dev/null
  rooms-role relay /bin/sh -ec "! head -c 1 /tls/privkey.pem >/dev/null 2>&1"
'
docker exec "$container" rooms-role gateway /bin/sh -ec '
  head -c 1 /srv/www/index.html >/dev/null
  ! head -c 1 /tls/privkey.pem >/dev/null 2>&1
  ! head -c 1 /srv/desktop-downloads/release.json >/dev/null 2>&1
'
docker exec "$container" rooms-role relay /bin/sh -ec '
  ! head -c 1 /tls/privkey.pem >/dev/null 2>&1
'
docker exec "$container" sh -ec '
  if apk info -e libxslt; then exit 1; fi
  zlib=$(apk info -v | sed -n "s/^zlib-//p")
  test -n "$zlib"
  comparison=$(apk version -t "$zlib" 1.4-r0)
  test "$comparison" = "=" || test "$comparison" = ">"
'
