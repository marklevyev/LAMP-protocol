"""Generates the sensor-stream golden test vectors.

The vectors pin the wire contract in docs/sensor-stream.md. Every mindLAMP
repo that encodes or decodes accelerometer frames tests against them.

Usage:
    python3 tools/generate_vectors.py --compressor /path/to/ozl_compress_file

The OpenZL frames come from the C shim (tools/openzl/lamp_ozl.c) through the
`ozl_compress_file` program, because the OpenZL Python binding can't build the
split-by-struct graph. Python is used only to pack records and to write zstd.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import zstandard

ACCEL_DTYPE = np.dtype([("timestamp", "<i8"), ("x", "<f4"), ("y", "<f4"), ("z", "<f4")])
WINDOW_MS = 300_000
GRAVITY = 9.80665
OPENZL_FORMAT_VERSION = 24
OPENZL_MAGIC_BASE = 0xD7B1A5C0

# Main frame: 500 samples at 50 Hz (20 ms apart), starting exactly on a window
# boundary. 1790000100000 = 300000 * 5966667.
MAIN_START_MS = 1_790_000_100_000
MAIN_COUNT = 500
MAIN_PERIOD_MS = 20

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "test-vectors" / "sensor-stream"


def main_records() -> np.ndarray:
    """Returns the deterministic records of the main frame."""
    records = np.zeros(MAIN_COUNT, dtype=ACCEL_DTYPE)
    index = np.arange(MAIN_COUNT)
    records["timestamp"] = MAIN_START_MS + index * MAIN_PERIOD_MS
    records["x"] = (0.3 * np.sin(index / 9.0)).astype("<f4")
    records["y"] = (0.2 * np.cos(index / 13.0)).astype("<f4")
    records["z"] = (GRAVITY + 0.05 * np.sin(index / 5.0)).astype("<f4")
    return records


def records_to_json(records: np.ndarray) -> list[dict]:
    """Converts records to JSON objects; floats are the exact float32 values."""
    return [
        {
            "timestamp": int(r["timestamp"]),
            "x": float(r["x"]),
            "y": float(r["y"]),
            "z": float(r["z"]),
        }
        for r in records
    ]


def compress_openzl(compressor: Path, raw: bytes) -> bytes:
    """Compresses packed records with the C shim and checks the format version."""
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.bin"
        dst = Path(tmp) / "out.openzl"
        src.write_bytes(raw)
        result = subprocess.run(
            [str(compressor), str(src), str(dst)], check=True, capture_output=True, text=True
        )
        raw_size, _, version = (int(v) for v in result.stdout.split())
        if raw_size != len(raw) or version != OPENZL_FORMAT_VERSION:
            raise RuntimeError(f"unexpected compressor output: {result.stdout!r}")
        blob = dst.read_bytes()
    magic = struct.unpack("<I", blob[:4])[0]
    if magic - OPENZL_MAGIC_BASE != OPENZL_FORMAT_VERSION:
        raise RuntimeError(f"frame magic {magic:#x} does not encode format version 24")
    return blob


def frame_meta(records: np.ndarray, blob: bytes, codec: str, spec: str, platform: str) -> dict:
    """Returns the multipart fields that accompany a compressed frame."""
    return {
        "sensor_spec": spec,
        "start_timestamp": int(records["timestamp"][0]),
        "end_timestamp": int(records["timestamp"][-1]),
        "sample_count": int(len(records)),
        "codec": codec,
        "codec_format_version": OPENZL_FORMAT_VERSION if codec == "openzl" else 0,
        "platform": platform,
        "unit": "m/s^2",
        "sha256": hashlib.sha256(blob).hexdigest(),
        "byte_length": len(blob),
    }


def stable_sort(records: list[tuple[int, float, float, float]]) -> list[tuple[int, float, float, float]]:
    """Sorts records by timestamp, keeping arrival order for equal timestamps."""
    return sorted(records, key=lambda r: r[0])


def split_into_frames(arrivals: list[list[tuple[int, float, float, float]]]) -> list[dict]:
    """Applies the frame rules of docs/sensor-stream.md to batches of arrivals.

    A frame closes when a record from a later window arrives. A record for a
    window that is already closed starts a new partial frame for that window.
    """
    frames: list[dict] = []
    open_window: int | None = None
    open_records: list = []
    closed: set[int] = set()

    def close() -> None:
        nonlocal open_window, open_records
        if open_window is not None and open_records:
            ordered = stable_sort(open_records)
            frames.append(
                {
                    "window": open_window,
                    "start_timestamp": ordered[0][0],
                    "end_timestamp": ordered[-1][0],
                    "timestamps": [r[0] for r in ordered],
                }
            )
            closed.add(open_window)
        open_window, open_records = None, []

    for batch in arrivals:
        for record in batch:
            window = record[0] // WINDOW_MS
            if open_window is None:
                open_window = window
            elif window > open_window:
                close()
                open_window = window
            elif window < open_window:
                # A late record for an earlier window: emit it as its own
                # partial frame so it is never dropped or re-windowed.
                frames.append(
                    {
                        "window": window,
                        "start_timestamp": record[0],
                        "end_timestamp": record[0],
                        "timestamps": [record[0]],
                        "late": True,
                    }
                )
                continue
            open_records.append(record)
    close()
    return frames


def edge_cases() -> dict:
    """Builds the edge-case vectors."""
    t0 = MAIN_START_MS
    boundary = (t0 // WINDOW_MS + 1) * WINDOW_MS

    duplicate_input = [(t0 + 10, 1.0, 0.0, 0.0), (t0, 2.0, 0.0, 0.0), (t0 + 10, 3.0, 0.0, 0.0), (t0 + 20, 4.0, 0.0, 0.0)]
    duplicate_sorted = stable_sort(duplicate_input)
    dup_records = np.array(duplicate_sorted, dtype=ACCEL_DTYPE)

    arrivals = [
        [(boundary - 40, 0.0, 0.0, GRAVITY), (boundary - 20, 0.0, 0.0, GRAVITY), (boundary, 0.0, 0.0, GRAVITY), (boundary + 20, 0.0, 0.0, GRAVITY)],
        [(boundary - 10, 0.0, 0.0, GRAVITY), (boundary + 40, 0.0, 0.0, GRAVITY)],
    ]

    def ios(g: tuple[float, float, float]) -> list[float]:
        return [float(np.float32(v * -GRAVITY)) for v in g]

    return {
        "duplicate_ms": {
            "description": "Records with equal timestamps are kept and stably sorted by timestamp.",
            "input": [list(r) for r in duplicate_input],
            "expected_sorted": [list(r) for r in duplicate_sorted],
            "expected_packed_hex": dup_records.tobytes().hex(),
        },
        "window_split": {
            "description": (
                "Two delivered batches. The first spans a window boundary and is split into two frames. "
                "The second holds a late record for the closed window (a new partial frame) and a record "
                "for the open window."
            ),
            "window_ms": WINDOW_MS,
            "arrivals": [[list(r) for r in batch] for batch in arrivals],
            "expected_frames": split_into_frames(arrivals),
        },
        "units_at_rest": {
            "description": "iOS acceleration in g converts to Android-convention m/s^2 with value * -9.80665, as float32. Compare numerically: -0.0 equals 0.0 (a zero g axis converts to -0.0).",
            "gravity": GRAVITY,
            "cases": [
                {"ios_g": [0.0, 0.0, -1.0], "expected_ms2": ios((0.0, 0.0, -1.0))},
                {"ios_g": [0.5, -0.25, -1.0], "expected_ms2": ios((0.5, -0.25, -1.0))},
                {"ios_g": [1.0, 0.0, 0.0], "expected_ms2": ios((1.0, 0.0, 0.0))},
            ],
            "android_at_rest_face_up_ms2": [0.0, 0.0, float(np.float32(GRAVITY))],
        },
        "sample_count_limits": {
            "description": "Server-side sample_count bounds; every tier shares them.",
            "min": 1,
            "max": 66000,
            "max_frame_bytes": 4 * 1024 * 1024,
            "nominal_per_window": {
                "lamp.accelerometer10hz": 3000,
                "lamp.accelerometer20hz": 6000,
                "lamp.accelerometer50hz": 15000,
                "lamp.accelerometer100hz": 30000,
            },
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--compressor", type=Path, required=True, help="path to ozl_compress_file")
    args = parser.parse_args()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    records = main_records()
    raw = records.tobytes()
    assert len(raw) == MAIN_COUNT * 20
    openzl_blob = compress_openzl(args.compressor, raw)
    zstd_blob = zstandard.ZstdCompressor(level=3, write_content_size=True).compress(raw)
    nosize_blob = zstandard.ZstdCompressor(level=3, write_content_size=False).compress(raw)

    single = records[:1]
    single_blob = compress_openzl(args.compressor, single.tobytes())

    (OUT_DIR / "records.json").write_text(json.dumps(records_to_json(records), indent=1) + "\n")
    (OUT_DIR / "frame.bin").write_bytes(raw)
    (OUT_DIR / "frame.openzl").write_bytes(openzl_blob)
    (OUT_DIR / "frame.zstd").write_bytes(zstd_blob)
    (OUT_DIR / "frame_nosize.zstd").write_bytes(nosize_blob)
    (OUT_DIR / "frame_single.bin").write_bytes(single.tobytes())
    (OUT_DIR / "frame_single.openzl").write_bytes(single_blob)
    meta = {
        "frame.openzl": frame_meta(records, openzl_blob, "openzl", "lamp.accelerometer50hz", "android"),
        "frame.zstd": frame_meta(records, zstd_blob, "zstd", "lamp.accelerometer50hz", "android"),
        "frame_nosize.zstd": frame_meta(records, nosize_blob, "zstd", "lamp.accelerometer50hz", "android"),
        "frame_single.openzl": frame_meta(single, single_blob, "openzl", "lamp.accelerometer100hz", "ios"),
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (OUT_DIR / "edge_cases.json").write_text(json.dumps(edge_cases(), indent=2) + "\n")
    print(
        f"raw {len(raw)} B, openzl {len(openzl_blob)} B, zstd {len(zstd_blob)} B, "
        f"single openzl {len(single_blob)} B -> {OUT_DIR}"
    )


if __name__ == "__main__":
    main()
