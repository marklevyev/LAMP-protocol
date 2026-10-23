# OpenZL tooling for the sensor stream

This directory holds the canonical copy of the C code that every mindLAMP
platform uses to compress accelerometer frames. The contract is in
[`docs/sensor-stream.md`](../../docs/sensor-stream.md).

| File | Purpose |
|---|---|
| `lamp_ozl.h`, `lamp_ozl.c` | The only OpenZL API that clients call. LAMP-core-android and LAMP-core-ios carry byte-identical copies. |
| `vendor-openzl.sh` | Creates the pruned OpenZL v0.3.0 source tree (OpenZL C sources, zstd, lz4) that the mobile apps vendor. |
| `flat-build.sh` | Builds that tree and `ozl_compress_file` with the host C compiler, without upstream CMake. |
| `ozl_compress_file.c` | Command-line compressor that the vector generator calls. It self-checks every frame by decompressing it. |

## Rebuild the golden vectors

```sh
tools/openzl/vendor-openzl.sh /tmp/openzl-vendored v0.3.0
tools/openzl/flat-build.sh /tmp/openzl-vendored tools/openzl /tmp/openzl-build
python3 tools/generate_vectors.py --compressor /tmp/openzl-build/ozl_compress_file
python3 tools/validate_openzl_roundtrip.py
```

`generate_vectors.py` and `validate_openzl_roundtrip.py` need Python 3.10 or
later with `numpy`, `zstandard`, and `openzl==0.3.0`.

## Update OpenZL

1. Run `vendor-openzl.sh` with the new tag into each mobile repo's vendored
   directory, and copy `lamp_ozl.c` and `lamp_ozl.h` from here.
2. Keep `LAMP_OZL_FORMAT_VERSION` at the oldest format that every deployed
   decoder (the Python loaders and the server-side tooling) can read. Raise it
   only after those decoders are upgraded.
3. Rebuild the vectors and run every repo's tests.
