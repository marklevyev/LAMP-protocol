#!/usr/bin/env bash
# Builds the vendored OpenZL tree + lamp_ozl shim without upstream CMake.
# Usage: flat-build.sh <vendored-dir> <shim-dir> <out-dir>
set -euo pipefail
V="$1"; SHIM="$2"; OUT="$3"
mkdir -p "$OUT"; rm -f "$OUT"/*.o
INC=(-I"$V/config" -I"$V/openzl" -I"$V/openzl/include" -I"$V/openzl/src" -I"$V/zstd" -I"$V/lz4" -I"$SHIM")
COMMON=(-std=gnu11 -O2 -D_GNU_SOURCE -D_REENTRANT -DZSTD_DISABLE_ASM=1 -DZSTD_LEGACY_SUPPORT=0 -DXXH_NAMESPACE=ZSTD_)
i=0
while IFS= read -r f; do i=$((i+1)); cc "${COMMON[@]}" "${INC[@]}" -c "$f" -o "$OUT/oz_$i.o"; done < <(find "$V/openzl/src" -name '*.c')
while IFS= read -r f; do i=$((i+1)); cc "${COMMON[@]}" -DXXH_NAMESPACE=ZSTD_ "${INC[@]}" -c "$f" -o "$OUT/zs_$i.o"; done < <(find "$V/zstd" -name '*.c')
for f in "$V/lz4/lz4.c" "$V/lz4/lz4hc.c"; do i=$((i+1)); cc "${COMMON[@]}" -DXXH_NAMESPACE=ZSTD_ "${INC[@]}" -c "$f" -o "$OUT/lz_$i.o"; done
cc "${COMMON[@]}" "${INC[@]}" -c "$SHIM/lamp_ozl.c" -o "$OUT/shim.o"
cc "${COMMON[@]}" "${INC[@]}" "$SHIM/ozl_compress_file.c" "$OUT"/*.o -lm -o "$OUT/ozl_compress_file"
echo "compiled $i library files"
