// ozl_compress_file: compresses a packed-record file with lamp_ozl.
//
// Usage: ozl_compress_file <in.bin> <out.openzl>
// Prints "<raw_bytes> <compressed_bytes> <format_version>" on success.
// Used only to generate the golden test vectors.

#include <stdio.h>
#include <stdlib.h>

#include "lamp_ozl.h"

static unsigned char* read_all(const char* path, size_t* size) {
  FILE* f = fopen(path, "rb");
  if (f == NULL) return NULL;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  unsigned char* buf = malloc(n > 0 ? (size_t)n : 1);
  if (buf != NULL && fread(buf, 1, (size_t)n, f) != (size_t)n) {
    free(buf);
    buf = NULL;
  }
  fclose(f);
  *size = (size_t)n;
  return buf;
}

int main(int argc, char** argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: %s <in.bin> <out.openzl>\n", argv[0]);
    return 2;
  }
  size_t raw_size = 0;
  unsigned char* raw = read_all(argv[1], &raw_size);
  if (raw == NULL) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 1;
  }
  size_t cap = lamp_ozl_compress_bound(raw_size);
  unsigned char* out = malloc(cap);
  int64_t n = lamp_ozl_compress_accel(raw, raw_size, out, cap);
  if (n < 0) {
    fprintf(stderr, "compress failed: %lld\n", (long long)n);
    return 1;
  }
  // Self-check: the frame must decode back to the exact input.
  unsigned char* back = malloc(raw_size);
  int64_t m = lamp_ozl_decompress(out, (size_t)n, back, raw_size);
  for (size_t i = 0; m == (int64_t)raw_size && i < raw_size; i++) {
    if (back[i] != raw[i]) m = -100;
  }
  if (m != (int64_t)raw_size) {
    fprintf(stderr, "round trip failed: %lld\n", (long long)m);
    return 1;
  }
  FILE* f = fopen(argv[2], "wb");
  if (f == NULL || fwrite(out, 1, (size_t)n, f) != (size_t)n) return 1;
  fclose(f);
  printf("%zu %lld %lld\n", raw_size, (long long)n,
         (long long)lamp_ozl_frame_format_version(out, (size_t)n));
  free(raw);
  free(out);
  free(back);
  return 0;
}
