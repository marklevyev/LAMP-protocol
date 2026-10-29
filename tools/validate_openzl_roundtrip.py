"""Validates the OpenZL Python round trip against the sensor-stream contract.

This is the gate that runs before any loader or client work: if it fails, the
Python decoders in LAMP-cortex and Cortex-2.0 can't be trusted.

Usage:
    python3 tools/validate_openzl_roundtrip.py [--vectors DIR]

Checks:
  1. openzl==0.3.0 compresses and decompresses 20 * N-byte record buffers
     losslessly for N = 1, 2, 30000 and 66000 (all four fields compared).
  2. The C-generated golden frames (split-by-struct graph, format version 24)
     decode to exactly frame.bin / frame_single.bin, with one output and a
     magic number that encodes format version 24.
  3. A truncated frame raises an error instead of returning data.
  4. zstd frames decode with and without the content-size flag.

Exits with status 0 when every check passes, 1 otherwise.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
from pathlib import Path

import numpy as np
import openzl.ext as zl
import zstandard

ACCEL_DTYPE = np.dtype([("timestamp", "<i8"), ("x", "<f4"), ("y", "<f4"), ("z", "<f4")])
OPENZL_MAGIC_BASE = 0xD7B1A5C0
FORMAT_VERSION = 24
DEFAULT_VECTORS = Path(__file__).resolve().parents[1] / "test-vectors" / "sensor-stream"


def openzl_compress(raw: bytes) -> bytes:
    """Compresses one serial buffer with the generic graph at format version 24."""
    compressor = zl.Compressor()
    graph = zl.graphs.Compress()(compressor)
    compressor.select_starting_graph(graph)
    cctx = zl.CCtx()
    cctx.ref_compressor(compressor)
    cctx.set_parameter(zl.CParam.FormatVersion, FORMAT_VERSION)
    return cctx.compress([zl.Input(zl.Type.Serial, raw)])


def openzl_decompress(blob: bytes) -> bytes:
    """Decompresses a frame that must have exactly one output."""
    outputs = zl.DCtx().decompress(blob)
    if len(outputs) != 1:
        raise ValueError(f"expected 1 output, got {len(outputs)}")
    return outputs[0].content.as_bytes()


def format_version(blob: bytes) -> int:
    """Reads the OpenZL format version from the frame's magic number."""
    return struct.unpack("<I", blob[:4])[0] - OPENZL_MAGIC_BASE


def synthetic(n: int) -> np.ndarray:
    """Returns n deterministic records at 100 Hz with duplicate timestamps."""
    records = np.zeros(n, dtype=ACCEL_DTYPE)
    index = np.arange(n)
    records["timestamp"] = 1_790_000_100_000 + (index * 10) - (index % 7 == 3)
    records["x"] = np.sin(index / 11.0).astype("<f4")
    records["y"] = np.cos(index / 17.0).astype("<f4")
    records["z"] = (9.80665 + 0.01 * (index % 3)).astype("<f4")
    return records


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--vectors", type=Path, default=DEFAULT_VECTORS)
    args = parser.parse_args()
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
        if not ok:
            failures.append(name)

    for n in (1, 2, 30_000, 66_000):
        records = synthetic(n)
        raw = records.tobytes()
        blob = openzl_compress(raw)
        back = np.frombuffer(openzl_decompress(blob), dtype=ACCEL_DTYPE)
        same = back.shape == records.shape and all(
            np.array_equal(back[f], records[f]) for f in ACCEL_DTYPE.names
        )
        check(
            f"python round trip N={n}",
            same and format_version(blob) == FORMAT_VERSION,
            f"{len(raw)} -> {len(blob)} B",
        )

    vectors = args.vectors
    meta = json.loads((vectors / "meta.json").read_text())
    for frame, raw_name in (("frame.openzl", "frame.bin"), ("frame_single.openzl", "frame_single.bin")):
        blob = (vectors / frame).read_bytes()
        raw = (vectors / raw_name).read_bytes()
        try:
            decoded = openzl_decompress(blob)
        except Exception as exc:  # noqa: BLE001 - report any decoder failure
            check(f"decode C golden {frame}", False, repr(exc))
            continue
        records = np.frombuffer(decoded, dtype=ACCEL_DTYPE)
        check(
            f"decode C golden {frame}",
            decoded == raw
            and len(decoded) % 20 == 0
            and len(records) == meta[frame]["sample_count"]
            and format_version(blob) == meta[frame]["codec_format_version"] == FORMAT_VERSION
            and int(records["timestamp"][0]) == meta[frame]["start_timestamp"]
            and int(records["timestamp"][-1]) == meta[frame]["end_timestamp"],
        )

    expected = json.loads((vectors / "records.json").read_text())
    golden = np.frombuffer(openzl_decompress((vectors / "frame.openzl").read_bytes()), dtype=ACCEL_DTYPE)
    check(
        "golden values equal records.json",
        len(golden) == len(expected)
        and all(
            int(g["timestamp"]) == e["timestamp"]
            and np.float32(e["x"]) == g["x"]
            and np.float32(e["y"]) == g["y"]
            and np.float32(e["z"]) == g["z"]
            for g, e in zip(golden, expected)
        ),
    )

    blob = (vectors / "frame.openzl").read_bytes()
    try:
        openzl_decompress(blob[: len(blob) // 2])
        check("truncated frame raises", False, "decoder returned data")
    except Exception:  # noqa: BLE001 - any error is the expected outcome
        check("truncated frame raises", True)

    raw = (vectors / "frame.bin").read_bytes()
    dctx = zstandard.ZstdDecompressor()
    for name in ("frame.zstd", "frame_nosize.zstd"):
        data = dctx.decompress((vectors / name).read_bytes(), max_output_size=meta[name]["sample_count"] * 20)
        check(f"zstd {name}", data == raw)

    print(f"\n{'ALL CHECKS PASSED' if not failures else f'{len(failures)} CHECK(S) FAILED'}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
