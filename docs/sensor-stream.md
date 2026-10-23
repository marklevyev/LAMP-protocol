# Sensor-stream contract: GPS and high-rate accelerometer sensors

This document defines how mindLAMP clients collect, encode, upload, store, and
read back five sensors:

| Sensor spec | Rate | Transport |
|---|---|---|
| `lamp.gps1m` | 1 fix per 60 s | JSON `POST /participant/{participant_id}/sensor_event` |
| `lamp.accelerometer10hz` | 10 Hz | Binary `POST /participant/{participant_id}/sensor-stream` |
| `lamp.accelerometer20hz` | 20 Hz | Binary sensor stream |
| `lamp.accelerometer50hz` | 50 Hz | Binary sensor stream |
| `lamp.accelerometer100hz` | 100 Hz | Binary sensor stream |

Every implementation (LAMP-server, LAMP-core-android, LAMP-core-ios,
LAMP-cortex, LAMP-raphe) tests against the golden vectors in
[`test-vectors/sensor-stream/`](../test-vectors/sensor-stream/). If this
document and a vector disagree, fix whichever one is wrong in the same change.

## Accelerometer record

A record is exactly 20 bytes, little-endian, with no padding:

| Offset | Type | Field | Meaning |
|---|---|---|---|
| 0 | `int64` | `timestamp` | Sample time, Unix epoch milliseconds |
| 8 | `float32` | `x` | Acceleration along the device x axis, m/s² |
| 12 | `float32` | `y` | Acceleration along the device y axis, m/s² |
| 16 | `float32` | `z` | Acceleration along the device z axis, m/s² |

The NumPy equivalent is:

```python
np.dtype([("timestamp", "<i8"), ("x", "<f4"), ("y", "<f4"), ("z", "<f4")])
```

### Timestamps

- `timestamp` is `floor(epoch_ns / 1_000_000)`. Compute it from the sensor
  event's own clock, not from the time your code received the event:
  - Android: `SensorEvent.timestamp` (nanoseconds since boot) plus a boot-to-epoch
    offset.
  - iOS: `CMLogItem.timestamp` (seconds since boot) plus a boot-to-epoch offset.
- Capture the boot-to-epoch offset once, when a collection session starts, and
  reuse it for every sample in that session. Don't recompute it per batch.
- If the wall clock and the session offset drift apart by more than 1,000 ms
  (for example after an NTP or manual clock change), close the open frame and
  start a new session with a fresh offset. Never rewrite timestamps that you
  already packed.
- Two records can share a timestamp, because 100 Hz is close to millisecond
  resolution and devices can deliver faster than requested. Readers must not
  assume unique timestamps.

### Units and axes

All values are m/s² in the Android sensor coordinate system: with the device
lying face up on a table, the record is approximately `(0, 0, +9.80665)`.

- Android: write `SensorEvent.values[0..2]` from `Sensor.TYPE_ACCELEROMETER`
  unchanged.
- iOS: `CMAccelerometerData.acceleration` is in g with the opposite sign
  (face up reads `(0, 0, -1)`). Convert every axis with `value_ms2 = value_g *
  -9.80665`.

The vector `edge_cases.json` → `units_at_rest` pins this conversion.

## Frames

A frame holds the records of one participant, one sensor spec, and one
5-minute wall-clock window. The window index of a record is
`k = floor(timestamp / 300000)`; window `k` covers `[k * 300000, (k + 1) * 300000)`.

- Records in a frame are sorted by `timestamp`, non-decreasing (sort each frame
  stably before packing).
- `start_timestamp` is the first record's timestamp, and `end_timestamp` is the
  last record's timestamp. Both are inclusive, and both are in the same window.
- A frame holds at least one record.
- **A window can have more than one frame.** This happens after a collector
  restart, after a process death, or when a late hardware batch arrives after
  its window was closed. Readers merge every frame of a window.
- A frame holds at most 66,000 records (the server's `sample_count` limit). If a
  window collects more, close the frame and continue the window in a new frame.

### Which sensors run together

A study can configure more than one accelerometer sensor. Clients resolve the
configuration like this:
- If more than one `lamp.accelerometer*hz` tier is configured, collect only the
  fastest one.
- If any tier is configured, don't collect the legacy 5 Hz `lamp.accelerometer`
  JSON stream. `lamp.device_motion` is unaffected.
- `lamp.gps1m` runs alongside `lamp.gps` when both are configured; each emits
  its own `sensor` name.

### Splitting and closing frames

1. Split each delivered batch of samples by window, record by record. One batch
   can contain samples from two windows.
2. Close the frame for window `k` when the first of these happens:
   - A record with a timestamp in a later window arrives.
   - The wall clock reaches `(k + 1) * 300000 + 15000` ms (5 s maximum report
     latency plus 10 s margin).
   - The collector stops. On Android, wait for `onFlushCompleted` first; on iOS,
     drain the motion buffer first.
3. If a record arrives for a window whose frame is already closed, start a new
   partial frame for that window. Never drop it or move it to another window.
4. Append raw records to local storage as they arrive, so that a crash loses at
   most one drain interval (5 s).

The vector `edge_cases.json` → `window_split` pins rules 1 and 3.

## Compression

Each frame is compressed once, as a whole, and the compressed bytes are stored
on the device. Retries resend those exact bytes; never recompress a frame.

### OpenZL (`codec = "openzl"`)

- Library: OpenZL `v0.3.0`, vendored from source (see
  [`tools/openzl/`](../tools/openzl/)).
- Input: one serial buffer of `20 * N` bytes.
- Graph: `ZL_Compressor_registerSplitByStructGraph` with field sizes
  `{8, 4, 4, 4}`. The timestamp field goes through little-endian integer
  interpretation, then delta, then field LZ. Each axis goes through a byte-plane
  transpose, then zstd. The C implementation is
  [`tools/openzl/lamp_ozl.c`](../tools/openzl/lamp_ozl.c); every platform compiles
  that same file.
- Format version: always set explicitly to `24`, and send it as
  `codec_format_version`. OpenZL v0.3.0 defaults to `27`, which OpenZL v0.2.0
  readers can't decode.
- Any OpenZL v0.2.0 or later decoder can read these frames, because the decoder
  doesn't need the compression graph.

To read the format version without the C API (the Python binding doesn't expose
it), read the first 4 bytes as a little-endian `uint32` magic number:
`format_version = magic - 0xD7B1A5C0`.

### zstd (`codec = "zstd"`)

Use zstd only where OpenZL is unavailable (32-bit Android ABIs).
- Compress the frame in one shot, with the content-size flag set (for example,
  `Zstd.compress(byte[])` in zstd-jni, or `ZSTD_compress` in C), at level 3.
- Send `codec_format_version = 0`.
- Readers still pass `max_output_size = sample_count * 20`, so a frame without a
  content size decodes too.

### Merging frames

When a reader combines frames, it drops a record only when an identical record
(all four fields equal) appears in a *different* frame of the same window, for
example after a client re-sent a partial frame. Identical records inside one
frame are real samples that share a millisecond; keep them.

### Decoder checks

A decoder must check each frame in this order, and reject the frame on the
first failure:

1. OpenZL only: the frame has exactly one output.
2. The decompressed length is a multiple of 20.
3. The decompressed length divided by 20 equals `sample_count`.
4. OpenZL only: the frame's format version equals `codec_format_version`.
5. The first and last decoded timestamps equal `start_timestamp` and
   `end_timestamp`.

## Upload: `POST /participant/{participant_id}/sensor-stream`

The request body is `multipart/form-data`. Send all text fields **before** the
file part. The server rejects a request whose file part arrives before every
required field.

| Field | Type | Rule |
|---|---|---|
| `sensor_spec` | text | One of the four `lamp.accelerometer*hz` specs |
| `start_timestamp` | text, integer | Epoch ms; first record's timestamp |
| `end_timestamp` | text, integer | Epoch ms; last record's timestamp; `start <= end`, same window |
| `sample_count` | text, integer | `1` to `66000` (300 s × 200 Hz × 1.1), and `sample_count * 20 <= 4194304` |
| `codec` | text | `openzl` or `zstd` |
| `codec_format_version` | text, integer | `24` for `openzl`, `0` for `zstd` |
| `platform` | text | `android` or `ios` |
| `unit` | text | `m/s^2` |
| `sha256` | text | Lowercase hex SHA-256 of the compressed bytes |
| `frame` | file | Compressed frame, `application/octet-stream`, at most 4 MiB; clients name it `frame.<codec>`, and the server accepts any filename |

The server never decompresses a frame. Besides the field rules, it checks that
the frame bytes hash to `sha256` and that the frame starts with the codec's magic
number: for `openzl`, the little-endian `uint32` minus `0xD7B1A5C0` equals
`codec_format_version`; for `zstd`, the first bytes are `28 B5 2F FD`. You can
pass `me` as `participant_id` to mean the authenticated participant.

### Authentication

The upload route authenticates exactly like `POST .../sensor_event`:
- iOS sends `Authorization: Bearer <mobile token>`.
- Android sends the same `Authorization` header its existing `sensor_event`
  uploads send. On LAMP-server `master`, that legacy Basic header needs
  LAMP-server PR #307 with `ALLOW_LEGACY_MOBILE_TOKENS=true`.

### Responses and client actions

| Response | Meaning | Client action |
|---|---|---|
| `200 {"data": {"id": "<file id>"}}` | Stored | Delete the local frame |
| `200 {"data": {"id": "<file id>", "duplicate": true}}` | Same participant, spec, `start_timestamp`, and `sha256` already stored | Delete the local frame |
| `409` | Same participant, spec, and `start_timestamp` already stored with a different `sha256` | Move the frame to quarantine; don't retry |
| `400` | A field is missing or invalid | Move the frame to quarantine; don't retry |
| `401`, `403` | Not authenticated or not authorized | Keep the frame; retry after the session is refreshed |
| `413` | Frame larger than 4 MiB | Move the frame to quarantine; never retry |
| `5xx` or network error | Transient failure | Keep the frame; retry with exponential backoff |
| Any other status (for example `404` or `429`) | Unexpected | Keep the frame; retry with exponential backoff |

Error bodies have the form `{"error": "<status>.<slug>"}`, for example
`{"error": "409.frame-conflict"}`.

Two concurrent uploads with the same participant, spec, and `start_timestamp`
but different `sha256` values can both be stored, because the unique index
includes `sha256`. Readers merge them like any other frames of the window.

## Read

Both read routes use the `x-api-key` header (API keys need the `STANDARD`
access level, the same as `GET .../sensor_event`). They don't accept Basic auth.

### `GET /participant/{participant_id}/sensor-stream`

Lists frame metadata. Query parameters:

| Parameter | Required | Meaning |
|---|---|---|
| `sensor_spec` | Yes | One of the four accelerometer specs |
| `from` | No | Epoch ms; default `0` |
| `to` | No | Epoch ms, exclusive; default now |
| `limit` | No | 1 to 1000; default 1000 |
| `cursor` | No | The `next` value from the previous page |

A frame matches when it overlaps `[from, to)`: `end_timestamp >= from` and
`start_timestamp < to`. Results are sorted by `start_timestamp`, then `id`.
The server's range is half-open. Each Python loader documents its own range
convention: LAMP-cortex treats `end` as inclusive (its raw-feature convention),
and LAMP-raphe uses half-open `[start_ms, end_ms)`.

```json
{
  "data": [
    {
      "id": "6718a0c2e4b0a1b2c3d4e5f6",
      "sensor_spec": "lamp.accelerometer50hz",
      "start_timestamp": 1790000100000,
      "end_timestamp": 1790000109980,
      "sample_count": 500,
      "codec": "openzl",
      "codec_format_version": 24,
      "platform": "android",
      "unit": "m/s^2",
      "byte_length": 4188,
      "sha256": "a8ee18c33e9953a183864eea00deacfc3bfa6a300470a05741f6ece8003c15b6",
      "upload_date": "2026-10-23T12:00:00.000Z"
    }
  ],
  "next": null
}
```

### `GET /participant/{participant_id}/sensor-stream/{file_id}`

Returns the compressed frame bytes as `application/octet-stream`, with an
`ETag` of the quoted `sha256` (`"<sha256>"`, as RFC 9110 requires). Readers
verify integrity by hashing the bytes they received. Returns `404` when the file
doesn't belong to the participant.

## Storage

LAMP-server stores frames in the GridFS bucket `accelerometer_telemetry` with
`chunkSizeBytes = 261120` and read preference `primary`. Each file's metadata
is:

```json
{
  "participant_id": "U1234567890",
  "sensor_spec": "lamp.accelerometer50hz",
  "start_timestamp": 1790000100000,
  "end_timestamp": 1790000109980,
  "sample_count": 500,
  "codec": "openzl",
  "codec_format_version": 24,
  "platform": "android",
  "unit": "m/s^2",
  "byte_length": 4188,
  "sha256": "a8ee18c33e9953a183864eea00deacfc3bfa6a300470a05741f6ece8003c15b6"
}
```

Indexes:

| Collection | Keys | Options |
|---|---|---|
| `accelerometer_telemetry.files` | `{"metadata.participant_id": 1, "metadata.sensor_spec": 1, "uploadDate": -1}` | |
| `accelerometer_telemetry.files` | `{"metadata.participant_id": 1, "metadata.sensor_spec": 1, "metadata.start_timestamp": 1, "metadata.sha256": 1}` | unique (deduplication and range queries) |
| `accelerometer_telemetry.chunks` | `{"files_id": 1, "n": 1}` | unique |

On Amazon DocumentDB, GridFS needs an instance-based cluster (elastic clusters
don't support it). Connect with `tls=true` and the Amazon CA bundle. Set
`retryWrites=false` on engine versions earlier than 8.0.2.

## GPS: `lamp.gps1m`

`lamp.gps1m` uses the existing JSON `sensor_event` route. Each event has the
same `data` shape as `lamp.gps`:

```json
{
  "timestamp": 1790000160000,
  "sensor": "lamp.gps1m",
  "data": {"latitude": 42.3389, "longitude": -71.1066, "altitude": 12.5, "accuracy": 4.8}
}
```

- Android requests `PRIORITY_HIGH_ACCURACY` updates with a 60,000 ms interval
  and a 60,000 ms fastest interval.
- iOS uses `kCLLocationAccuracyBest` with continuous background updates and
  keeps at most one fix per 60 s.
- Both platforms treat 60 s as a target, not a guarantee.

## Golden vectors

[`tools/generate_vectors.py`](../tools/generate_vectors.py) produces the
vectors, and [`tools/validate_openzl_roundtrip.py`](../tools/validate_openzl_roundtrip.py)
checks them:

| File | Contents |
|---|---|
| `records.json` | The 500 records of the main frame (50 Hz, 10 s) |
| `frame.bin` | Those records packed: 10,000 bytes |
| `frame.openzl` | `frame.bin` compressed by `lamp_ozl.c` at format version 24 |
| `frame.zstd` | `frame.bin` compressed by zstd level 3, with content size |
| `frame_nosize.zstd` | The same, without content size (decoders must still read it) |
| `frame_single.bin`, `frame_single.openzl` | A one-record frame |
| `meta.json` | The multipart fields for `frame.openzl` and `frame.zstd` |
| `edge_cases.json` | Duplicate timestamps, window splitting, and unit conversion cases |
