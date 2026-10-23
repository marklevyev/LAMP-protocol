# LAMP-protocol
The LAMP Protocol.

## Sensor streams

The high-rate accelerometer and 1-minute GPS sensors (`lamp.accelerometer10hz`,
`lamp.accelerometer20hz`, `lamp.accelerometer50hz`, `lamp.accelerometer100hz`,
and `lamp.gps1m`) are specified in [`docs/sensor-stream.md`](docs/sensor-stream.md):
the 20-byte record layout, framing, OpenZL and zstd codecs, and the
`/participant/{participant_id}/sensor-stream` upload and read operations. Golden
test vectors are in [`test-vectors/sensor-stream/`](test-vectors/sensor-stream/),
and [`tools/validate_openzl_roundtrip.py`](tools/validate_openzl_roundtrip.py)
checks that a Python OpenZL install decodes them.

`openapi.yml` in this repository documents the protocol. The live server's spec is
[`src/utils/OpenAPISchema.json`](https://github.com/BIDMCDigitalPsychiatry/LAMP-server/blob/master/src/utils/OpenAPISchema.json)
in LAMP-server; when the two disagree, the server's spec describes what's deployed.

## Validate the spec

Use Node 22 or later:

```sh
npm ci
npm test
```

`npm test` runs `redocly lint` on `openapi.yml` and then the schema tests in
`test/`. Lint fails on any problem, warning or error, that isn't already
recorded in `.redocly.lint-ignore.yaml` (see `redocly.yaml`).
