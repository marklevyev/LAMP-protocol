// Tests for `components.schemas.SensorStreamUpload`: the multipart fields of
// `POST /participant/{participant_id}/sensor-stream`.

import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  ACCEL_SPECS,
  INVALID_METADATA_MUTATIONS,
  UPLOAD_TEXT_FIELDS,
  assertInvalid,
  assertValid,
  createAjv,
  loadOpenApi,
  readJson,
  repoPath,
  requireExample,
  requireSchema,
  schemaValidator,
  sha256Of,
} from './helpers.mjs';

const doc = loadOpenApi();
const ajv = createAjv(doc);
const VECTOR_DIR = 'test-vectors/sensor-stream';
const meta = readJson(`${VECTOR_DIR}/meta.json`);

/** Stands in for the binary `frame` part when validating multipart fields as JSON. */
const FRAME_PLACEHOLDER = '<compressed frame bytes>';

/** Turns a `meta.json` entry into upload fields: drops the server-computed `byte_length`, adds `frame`. */
function uploadFromMeta(entry) {
  const { byte_length: _byteLength, ...fields } = entry;
  return { ...fields, frame: FRAME_PLACEHOLDER };
}

/** Invalid variants of a valid upload, each one rule broken. */
const INVALID_MUTATIONS = {
  ...INVALID_METADATA_MUTATIONS,
  ...Object.fromEntries(
    [...UPLOAD_TEXT_FIELDS, 'frame'].map((field) => [
      `a missing ${field}`,
      (u) => {
        const copy = { ...u };
        delete copy[field];
        return copy;
      },
    ]),
  ),
};

describe('SensorStreamUpload schema', () => {
  test('exists and lists the text fields before the frame part, in contract order', () => {
    const schema = requireSchema(doc, 'SensorStreamUpload');
    assert.deepEqual(Object.keys(schema.properties ?? {}), [...UPLOAD_TEXT_FIELDS, 'frame']);
    assert.deepEqual([...(schema.required ?? [])].sort(), [...UPLOAD_TEXT_FIELDS, 'frame'].sort());
    assert.equal(schema.properties.frame.type, 'string');
    assert.equal(schema.properties.frame.format, 'binary');
  });

  test('enumerates exactly the four accelerometer tiers', () => {
    const schema = requireSchema(doc, 'SensorStreamUpload');
    assert.deepEqual(schema.properties?.sensor_spec?.enum, ACCEL_SPECS);
  });
});

for (const spec of ACCEL_SPECS) {
  describe(`upload metadata for ${spec}`, () => {
    test('the documented example is valid and names this spec', () => {
      const validate = schemaValidator(ajv, doc, 'SensorStreamUpload');
      const example = requireExample(doc, `SensorStreamUpload.${spec}`);
      assert.equal(example.sensor_spec, spec);
      assertValid(validate, example, `SensorStreamUpload.${spec}`);
    });

    for (const codec of ['openzl', 'zstd']) {
      test(`a ${codec} upload is valid`, () => {
        const validate = schemaValidator(ajv, doc, 'SensorStreamUpload');
        const upload = uploadFromMeta({
          ...meta[`frame.${codec}`],
          sensor_spec: spec,
        });
        assertValid(validate, upload, `${spec} ${codec} upload`);
      });
    }

    for (const [label, mutate] of Object.entries(INVALID_MUTATIONS)) {
      test(`an upload with ${label} is invalid`, () => {
        const validate = schemaValidator(ajv, doc, 'SensorStreamUpload');
        const valid = uploadFromMeta({ ...meta['frame.openzl'], sensor_spec: spec });
        assertValid(validate, valid, `${spec} baseline upload`);
        assertInvalid(validate, mutate(valid), `${spec} upload with ${label}`);
      });
    }

    test('sample_count bounds 1 and 66000 are valid', () => {
      const validate = schemaValidator(ajv, doc, 'SensorStreamUpload');
      const base = uploadFromMeta({ ...meta['frame.openzl'], sensor_spec: spec });
      assertValid(validate, { ...base, sample_count: 1 }, 'sample_count 1');
      assertValid(validate, { ...base, sample_count: 66000 }, 'sample_count 66000');
    });
  });
}

describe('golden vector meta.json', () => {
  for (const [file, entry] of Object.entries(meta)) {
    test(`${file} metadata validates against SensorStreamUpload`, () => {
      const validate = schemaValidator(ajv, doc, 'SensorStreamUpload');
      assertValid(validate, uploadFromMeta(entry), `meta.json ${file}`);
    });

    test(`${file} byte_length and sha256 match the vector file`, () => {
      assert.equal(statSync(repoPath(`${VECTOR_DIR}/${file}`)).size, entry.byte_length);
      assert.equal(sha256Of(`${VECTOR_DIR}/${file}`), entry.sha256);
    });
  }
});
