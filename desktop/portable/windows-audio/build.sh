#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output_dir=${1:-"$source_dir"}
mkdir -p -- "$output_dir"
"${CXX:-x86_64-w64-mingw32-g++}" -std=c++17 -O2 -s -Wall -Wextra -Wpedantic \
  -DUNICODE -D_UNICODE -D_WIN32_WINNT=0x0A00 -municode -static -static-libgcc -static-libstdc++ \
  -Wl,--nxcompat,--dynamicbase,--high-entropy-va \
  "$source_dir/rooms-windows-audio.cpp" -o "$output_dir/rooms-windows-audio.exe" \
  -lole32 -luuid -lpropsys -lmmdevapi -lbcrypt
