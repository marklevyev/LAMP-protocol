// Tests for the three sensor-stream operations and the SensorStreamFrame
// schema that the list operation returns.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCEL_SPECS,
  UPLOAD_TEXT_FIELDS,
  assertInvalid,
  assertValid,
  createAjv,
  loadOpenApi,
  requireExample,
  requireOperation,
  resolveRef,
  schemaValidator,
  validatorAt,
} from './helpers.mjs';

const doc = loadOpenApi();
const ajv = createAjv(doc);
const COLLECTION = '/participant/{participant_id}/sensor-stream';
const ITEM = '/participant/{participant_id}/sensor-stream/{file_id}';

/** Returns the operation's parameters (resolving `$ref`s) keyed by name. */
function paramsByName(operation) {
  return Object.fromEntries((operation.parameters ?? []).map((p) => resolveRef(doc, p)).map((p) => [p.name, p]));
}

/** Returns the names of the security schemes an operation accepts. */
function securityNames(operation) {
  return (operation.security ?? []).flatMap((requirement) => Object.keys(requirement)).sort();
}

describe(`POST ${COLLECTION}`, () => {
  test('takes a multipart SensorStreamUpload body with the frame encoded as octet-stream', () => {
    const op = requireOperation(doc, COLLECTION, 'post');
    assert.equal(op.operationId, 'SensorStream.create');
    assert.equal(paramsByName(op).participant_id?.in, 'path');
    assert.equal(op.requestBody?.required, true);
    const media = op.requestBody?.content?.['multipart/form-data'];
    assert.ok(media, 'the request body has no multipart/form-data content');
    assert.equal(media.schema?.$ref, '#/components/schemas/SensorStreamUpload');
    assert.equal(media.encoding?.frame?.contentType, 'application/octet-stream');
  });

  test('has a documented example per accelerometer tier', () => {
    const op = requireOperation(doc, COLLECTION, 'post');
    const examples = op.requestBody?.content?.['multipart/form-data']?.examples ?? {};
    for (const spec of ACCEL_SPECS) {
      assert.equal(examples[spec]?.$ref, `#/components/examples/SensorStreamUpload.${spec}`);
    }
  });

  test('documents the 200, 400, 409, and 413 responses', () => {
    const op = requireOperation(doc, COLLECTION, 'post');
    for (const code of ['200', '400', '401', '403', '409', '413']) {
      assert.ok(op.responses?.[code], `response ${code} is missing`);
    }
    const ok = op.responses['200'].content['application/json'].schema;
    assert.deepEqual(Object.keys(ok.properties), ['data']);
    assert.deepEqual(Object.keys(ok.properties.data.properties).sort(), ['duplicate', 'id']);
  });

  test('accepts a mobile token or the legacy Basic header', () => {
    const op = requireOperation(doc, COLLECTION, 'post');
    assert.deepEqual(securityNames(op), ['Authorization', 'MobileToken']);
    assert.ok(op['x-code-samples']?.length >= 1, 'x-code-samples are missing');
  });
});

describe(`GET ${COLLECTION}`, () => {
  test('takes sensor_spec, from, to, limit, and cursor query parameters', () => {
    const op = requireOperation(doc, COLLECTION, 'get');
    assert.equal(op.operationId, 'SensorStream.list');
    const params = paramsByName(op);
    assert.equal(params.participant_id?.in, 'path');
    for (const name of ['sensor_spec', 'from', 'to', 'limit', 'cursor']) {
      assert.equal(params[name]?.in, 'query', `query parameter ${name} is missing`);
    }
    assert.equal(params.sensor_spec.required, true);
    assert.deepEqual(params.sensor_spec.schema.enum, ACCEL_SPECS);
    assert.equal(params.limit.schema.minimum, 1);
    assert.equal(params.limit.schema.maximum, 1000);
    assert.equal(params.limit.schema.default, 1000);
  });

  test('returns {data: SensorStreamFrame[], next}', () => {
    const op = requireOperation(doc, COLLECTION, 'get');
    const schema = op.responses?.['200']?.content?.['application/json']?.schema;
    assert.ok(schema, 'the 200 response has no application/json schema');
    assert.equal(schema.properties?.data?.type, 'array');
    assert.equal(schema.properties.data.items?.$ref, '#/components/schemas/SensorStreamFrame');
    assert.equal(schema.properties?.next?.nullable, true);
    assert.deepEqual([...(schema.required ?? [])].sort(), ['data', 'next']);
  });

  test('the documented list example validates against the 200 response schema', () => {
    const op = requireOperation(doc, COLLECTION, 'get');
    const media = op.responses['200'].content['application/json'];
    assert.equal(media.examples?.frames?.$ref, '#/components/examples/SensorStreamFrameList');
    const validate = validatorAt(ajv, ['paths', COLLECTION, 'get', 'responses', '200', 'content', 'application/json', 'schema']);
    assertValid(validate, requireExample(doc, 'SensorStreamFrameList'), 'SensorStreamFrameList');
  });

  test('uses the x-api-key header only', () => {
    assert.deepEqual(securityNames(requireOperation(doc, COLLECTION, 'get')), ['ApiKeyAuth']);
  });
});

describe(`GET ${ITEM}`, () => {
  test('returns the compressed frame as application/octet-stream', () => {
    const op = requireOperation(doc, ITEM, 'get');
    assert.equal(op.operationId, 'SensorStream.view');
    const params = paramsByName(op);
    assert.equal(params.participant_id?.in, 'path');
    assert.equal(params.file_id?.in, 'path');
    const media = op.responses?.['200']?.content?.['application/octet-stream'];
    assert.ok(media, 'the 200 response has no application/octet-stream content');
    assert.equal(media.schema?.type, 'string');
    assert.equal(media.schema?.format, 'binary');
    assert.ok(op.responses['200'].headers?.ETag, 'the ETag header is missing');
    assert.ok(op.responses?.['404'], 'response 404 is missing');
    assert.deepEqual(securityNames(op), ['ApiKeyAuth']);
  });
});

describe('SensorStreamFrame schema', () => {
  const FRAME_FIELDS = ['id', ...UPLOAD_TEXT_FIELDS, 'byte_length', 'upload_date'];

  test('requires every metadata field the server returns', () => {
    const validate = schemaValidator(ajv, doc, 'SensorStreamFrame');
    const [frame] = requireExample(doc, 'SensorStreamFrameList').data;
    assert.deepEqual(Object.keys(frame).sort(), [...FRAME_FIELDS].sort());
    assertValid(validate, frame, 'list example frame');
    for (const field of FRAME_FIELDS) {
      const copy = { ...frame };
      delete copy[field];
      assertInvalid(validate, copy, `frame without ${field}`);
    }
  });

  for (const [label, mutate] of Object.entries({
    "codec 'gzip'": (f) => ({ ...f, codec: 'gzip' }),
    'openzl with codec_format_version 0': (f) => ({ ...f, codec: 'openzl', codec_format_version: 0 }),
    'sample_count 0': (f) => ({ ...f, sample_count: 0 }),
    'byte_length 0': (f) => ({ ...f, byte_length: 0 }),
    'byte_length over 4 MiB': (f) => ({ ...f, byte_length: 4194305 }),
    'a non-date upload_date': (f) => ({ ...f, upload_date: 'yesterday' }),
  })) {
    test(`a frame with ${label} is invalid`, () => {
      const validate = schemaValidator(ajv, doc, 'SensorStreamFrame');
      const [frame] = requireExample(doc, 'SensorStreamFrameList').data;
      assertInvalid(validate, mutate(frame), `frame with ${label}`);
    });
  }
});
