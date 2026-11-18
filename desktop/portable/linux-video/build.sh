#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
output_dir=${1:-"$source_dir"}
mkdir -p -- "$output_dir"

dependencies=(libpipewire-0.3 gstreamer-base-1.0 gstreamer-video-1.0)
pkg-config --atleast-version=0.3.65 libpipewire-0.3
pkg-config --atleast-version=1.20 gstreamer-video-1.0
read -r -a include_flags <<< "$(pkg-config --cflags "${dependencies[@]}")"
read -r -a linker_flags <<< "$(pkg-config --libs "${dependencies[@]}")"
temporary=$(mktemp "$output_dir/.rooms-capture.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT

"${CC:-cc}" -std=gnu11 -O3 -Wall -Wextra -Werror -Wno-missing-field-initializers -fPIC -shared \
  "${include_flags[@]}" "$source_dir/rooms-capture.c" "${linker_flags[@]}" -Wl,-z,defs,-z,relro,-z,now -o "$temporary"
chmod 0755 "$temporary"
mv -f -- "$temporary" "$output_dir/libgstroomscapture.so"
