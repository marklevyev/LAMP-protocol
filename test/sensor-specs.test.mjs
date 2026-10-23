// Tests for the documented SensorSpec and SensorEvent examples of the five
// sensor-stream specs, and for the operations that document them.
//
// LAMP-server seeds the five specs at startup (`POST /sensor_spec` reserves the
// `lamp.` prefix), so their examples document `GET /sensor_spec/{id}` responses:
// `{data: [<SensorSpec>]}`.

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
  requireOperation,
  resolveRef,
  schemaValidator,
  validatorAt,
} from './helpers.mjs';

const doc = loadOpenApi();
const ajv = createAjv(doc);
const records = readJson('test-vectors/sensor-stream/records.json');

const SPEC_PATH = '/sensor_spec';
const SPEC_ITEM_PATH = '/sensor_spec/{id}';
const SPEC_RESPONSE = ['paths', SPEC_ITEM_PATH, 'get', 'responses', '200', 'content', 'application/json'];
const EVENT_PATH = '/participant/{id}/sensor_event';
const EVENT_REQUEST = ['paths', EVENT_PATH, 'post', 'requestBody', 'content', 'application/json'];

/** Returns the node at a path of segments inside the document. */
function nodeAt(segments) {
  return segments.reduce((acc, key) => acc?.[key], doc);
}

/** Returns an examples map with each `$ref` resolved to its example object. */
function resolvedExamples(examples) {
  return Object.fromEntries(Object.entries(examples ?? {}).map(([key, ex]) => [key, resolveRef(doc, ex)]));
}

/**
 * Returns the SensorSpec inside the `GET /sensor_spec/{id}` response example
 * `components.examples[name]`, which must hold exactly one spec.
 */
function requireSpecExample(name) {
  const response = requireExample(doc, name);
  assert.ok(Array.isArray(response.data), `${name} has no data array`);
  assert.equal(response.data.length, 1, `${name} must hold exactly one SensorSpec`);
  return response.data[0];
}

/** Compiles a JSON Schema taken from an example with a fresh Ajv instance. */
function compileEmbedded(schema) {
  return createAjv(doc).compile(schema);
}

for (const spec of ALL_SPECS) {
  describe(`SensorSpec example for ${spec}`, () => {
    test('validates against SensorSpec and names this spec', () => {
      const validate = schemaValidator(ajv, doc, 'SensorSpec');
      const example = requireSpecExample(`SensorSpec.${spec}`);
      assert.equal(example.id, spec);
      assertValid(validate, example, `SensorSpec.${spec}`);
    });

    test('has settings_schema and data_schema that compile as JSON Schema', () => {
      const example = requireSpecExample(`SensorSpec.${spec}`);
      assert.equal(typeof example.settings_schema, 'object');
      assert.equal(typeof example.data_schema, 'object');
      compileEmbedded(example.settings_schema);
      compileEmbedded(example.data_schema);
    });

    test('settings_schema accepts empty settings and rejects unknown settings', () => {
      const example = requireSpecExample(`SensorSpec.${spec}`);
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
      const validate = compileEmbedded(requireSpecExample(`SensorSpec.${spec}`).data_schema);
      assertValid(validate, record, `${spec} decoded record`);
    });

    for (const [label, bad] of Object.entries({
      'a string x': { ...record, x: '0.1' },
      'a missing z': { timestamp, x, y },
      'a fractional timestamp': { ...record, timestamp: timestamp + 0.5 },
    })) {
      test(`a record with ${label} is invalid`, () => {
        const validate = compileEmbedded(requireSpecExample(`SensorSpec.${spec}`).data_schema);
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
    const validate = compileEmbedded(requireSpecExample(`SensorSpec.${GPS_SPEC}`).data_schema);
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
      const validate = compileEmbedded(requireSpecExample(`SensorSpec.${GPS_SPEC}`).data_schema);
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
      const validate = compileEmbedded(requireSpecExample(`SensorSpec.${GPS_SPEC}`).data_schema);
      assertValid(validate, valid, `${GPS_SPEC} baseline data`);
      assertInvalid(validate, bad, `${GPS_SPEC} data with ${label}`);
    });
  }
});

describe(`GET ${SPEC_ITEM_PATH} examples`, () => {
  test('document exactly the five seeded specs, keyed by name', () => {
    const examples = nodeAt([...SPEC_RESPONSE, 'examples']);
    assert.ok(examples, `GET ${SPEC_ITEM_PATH} 200 has no examples`);
    assert.deepEqual(Object.keys(examples).sort(), [...ALL_SPECS].sort());
  });

  for (const spec of ALL_SPECS) {
    test(`the ${spec} example is a valid response for that spec`, () => {
      requireOperation(doc, SPEC_ITEM_PATH, 'get');
      const example = resolvedExamples(nodeAt([...SPEC_RESPONSE, 'examples']))[spec];
      assert.ok(example && 'value' in example, `GET ${SPEC_ITEM_PATH} has no ${spec} example value`);
      assertValid(validatorAt(ajv, [...SPEC_RESPONSE, 'schema']), example.value, `GET ${SPEC_ITEM_PATH} ${spec}`);
      assert.equal(example.value.data.length, 1);
      const [item] = example.value.data;
      assert.equal(item.id, spec);
      assertValid(schemaValidator(ajv, doc, 'SensorSpec'), item, `GET ${SPEC_ITEM_PATH} ${spec} item`);
      compileEmbedded(item.settings_schema);
      compileEmbedded(item.data_schema);
    });
  }
});

describe(`POST ${SPEC_PATH} examples`, () => {
  test('document no spec with the reserved lamp. prefix', () => {
    const op = requireOperation(doc, SPEC_PATH, 'post');
    const examples = resolvedExamples(op.requestBody?.content?.['application/json']?.examples);
    for (const [key, example] of Object.entries(examples)) {
      assert.ok(!String(example?.value?.id ?? key).startsWith('lamp.'), `POST ${SPEC_PATH} example ${key} uses lamp.`);
    }
  });
});

describe(`POST ${EVENT_PATH} examples`, () => {
  test(`include ${GPS_SPEC}`, () => {
    requireOperation(doc, EVENT_PATH, 'post');
    assert.ok(nodeAt([...EVENT_REQUEST, 'examples'])?.[GPS_SPEC], `POST ${EVENT_PATH} has no ${GPS_SPEC} example`);
  });

  test('are valid request bodies, and gps1m data matches its data_schema', () => {
    const validate = validatorAt(ajv, [...EVENT_REQUEST, 'schema']);
    const gpsData = compileEmbedded(requireSpecExample(`SensorSpec.${GPS_SPEC}`).data_schema);
    const examples = resolvedExamples(nodeAt([...EVENT_REQUEST, 'examples']));
    for (const [key, example] of Object.entries(examples)) {
      assert.ok(example && 'value' in example, `POST ${EVENT_PATH} example ${key} has no value`);
      assertValid(validate, example.value, `POST ${EVENT_PATH} example ${key}`);
      for (const event of [example.value].flat()) {
        if (event.sensor === GPS_SPEC) assertValid(gpsData, event.data, `POST ${EVENT_PATH} example ${key} data`);
      }
    }
  });
});
