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

mkdir "$fixtures/tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=rooms.example.test \
  -keyout "$fixtures/tls/privkey.pem" -out "$fixtures/tls/fullchain.pem" >/dev/null 2>&1
chmod 644 "$fixtures/tls/privkey.pem"

docker run --detach --name "$container" --read-only --tmpfs /tmp:mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges --publish 127.0.0.1::8080 \
  --health-interval=1s --health-timeout=5s \
  --env PUBLIC_ORIGIN=https://rooms.example.test --env TRUST_PROXY_IP=1 \
  --env ROOMS_TRUSTED_PROXY_IPS=127.0.0.1 \
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
curl --fail --silent --show-error -H 'X-Real-IP: 192.0.2.24' "http://$port/api/setup" | jq -e '.available == true'
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
