// Tests for the documented SensorSpec and SensorEvent examples of the five
// sensor-stream specs.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCEL_SPECS,
  ALL_SPECS,
  GPS_SPEC,
  assertInvalid,
  assertValid,
  createAjv,
  loadOpenApi,
  readJson,
  requireExample,
  schemaValidator,
} from './helpers.mjs';

const doc = loadOpenApi();
const ajv = createAjv(doc);
const records = readJson('test-vectors/sensor-stream/records.json');

/** Compiles a JSON Schema taken from an example with a fresh Ajv instance. */
function compileEmbedded(schema) {
  return createAjv(doc).compile(schema);
}

for (const spec of ALL_SPECS) {
  describe(`SensorSpec example for ${spec}`, () => {
    test('validates against SensorSpec and names this spec', () => {
      const validate = schemaValidator(ajv, doc, 'SensorSpec');
      const example = requireExample(doc, `SensorSpec.${spec}`);
      assert.equal(example.id, spec);
      assertValid(validate, example, `SensorSpec.${spec}`);
    });

    test('has settings_schema and data_schema that compile as JSON Schema', () => {
      const example = requireExample(doc, `SensorSpec.${spec}`);
      assert.equal(typeof example.settings_schema, 'object');
      assert.equal(typeof example.data_schema, 'object');
      compileEmbedded(example.settings_schema);
      compileEmbedded(example.data_schema);
    });

    test('settings_schema accepts empty settings and rejects unknown settings', () => {
      const example = requireExample(doc, `SensorSpec.${spec}`);
      const validate = compileEmbedded(example.settings_schema);
      assertValid(validate, {}, `${spec} empty settings`);
      assertInvalid(validate, { frequency: 5 }, `${spec} settings with frequency`);
    });
  });
}

for (const spec of ACCEL_SPECS) {
  describe(`decoded record for ${spec}`, () => {
    const record = { ...records[0] };
    const { timestamp, x, y } = record;

    test('a decoded golden record is valid data', () => {
      const validate = compileEmbedded(requireExample(doc, `SensorSpec.${spec}`).data_schema);
      assertValid(validate, record, `${spec} decoded record`);
    });

    for (const [label, bad] of Object.entries({
      'a string x': { ...record, x: '0.1' },
      'a missing z': { timestamp, x, y },
      'a fractional timestamp': { ...record, timestamp: timestamp + 0.5 },
    })) {
      test(`a record with ${label} is invalid`, () => {
        const validate = compileEmbedded(requireExample(doc, `SensorSpec.${spec}`).data_schema);
        assertInvalid(validate, bad, `${spec} record with ${label}`);
      });
    }
  });
}

describe(`${GPS_SPEC} sensor_event`, () => {
  test('the documented SensorEvent example is valid and uses the lamp.gps data shape', () => {
    const validate = schemaValidator(ajv, doc, 'SensorEvent');
    const event = requireExample(doc, `SensorEvent.${GPS_SPEC}`);
    assert.equal(event.sensor, GPS_SPEC);
    assert.deepEqual(Object.keys(event.data).sort(), ['accuracy', 'altitude', 'latitude', 'longitude']);
    assertValid(validate, event, `SensorEvent.${GPS_SPEC}`);
  });

  test('the example data is valid against the spec data_schema', () => {
    const validate = compileEmbedded(requireExample(doc, `SensorSpec.${GPS_SPEC}`).data_schema);
    const event = requireExample(doc, `SensorEvent.${GPS_SPEC}`);
    assertValid(validate, event.data, `${GPS_SPEC} event data`);
  });

  const valid = { latitude: 42.3389, longitude: -71.1066, altitude: 12.5, accuracy: 4.8 };

  // Android omits `altitude` and `accuracy` when the fix lacks them, and iOS models
  // `altitude` as optional, so only the coordinates are required.
  for (const [label, good] of Object.entries({
    'a missing altitude': { latitude: 42.3389, longitude: -71.1066, accuracy: 4.8 },
    'a missing accuracy': { latitude: 42.3389, longitude: -71.1066, altitude: 12.5 },
    'only latitude and longitude': { latitude: 42.3389, longitude: -71.1066 },
  })) {
    test(`data with ${label} is valid`, () => {
      const validate = compileEmbedded(requireExample(doc, `SensorSpec.${GPS_SPEC}`).data_schema);
      assertValid(validate, good, `${GPS_SPEC} data with ${label}`);
    });
  }

  for (const [label, bad] of Object.entries({
    'a missing latitude': { longitude: -71.1066, altitude: 12.5, accuracy: 4.8 },
    'a missing longitude': { latitude: 42.3389, altitude: 12.5, accuracy: 4.8 },
    'a string altitude': { ...valid, altitude: '12.5' },
    'a string latitude': { ...valid, latitude: '42.3389' },
    'latitude 91': { ...valid, latitude: 91 },
    'longitude -181': { ...valid, longitude: -181 },
    'a negative accuracy': { ...valid, accuracy: -1 },
    'accelerometer data': { x: 0.1, y: 0.2, z: 9.8 },
  })) {
    test(`data with ${label} is invalid`, () => {
      const validate = compileEmbedded(requireExample(doc, `SensorSpec.${GPS_SPEC}`).data_schema);
      assertValid(validate, valid, `${GPS_SPEC} baseline data`);
      assertInvalid(validate, bad, `${GPS_SPEC} data with ${label}`);
    });
  }
});
