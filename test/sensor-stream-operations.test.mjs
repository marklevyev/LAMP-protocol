// Tests for the three sensor-stream operations and the SensorStreamFrame
// schema that the list operation returns.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACCEL_SPECS,
  INVALID_METADATA_MUTATIONS,
  UPLOAD_TEXT_FIELDS,
  assertInvalid,
  assertValid,
  createAjv,
  loadOpenApi,
  requireExample,
  requireOperation,
  requireSchema,
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

  test('the 200 body requires data.id, and duplicate is a boolean', () => {
    const validate = validatorAt(ajv, ['paths', COLLECTION, 'post', 'responses', '200', 'content', 'application/json', 'schema']);
    assertValid(validate, { data: { id: '6718a0c2e4b0a1b2c3d4e5f6' } }, 'stored');
    assertValid(validate, { data: { id: '6718a0c2e4b0a1b2c3d4e5f6', duplicate: true } }, 'duplicate');
    for (const [label, bad] of Object.entries({
      'no data': {},
      'data without id': { data: { duplicate: true } },
      'a numeric id': { data: { id: 5 } },
      "duplicate 'true'": { data: { id: '6718a0c2e4b0a1b2c3d4e5f6', duplicate: 'true' } },
    })) {
      assertInvalid(validate, bad, `200 body with ${label}`);
    }
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

  test('takes from and to as non-negative integer epoch milliseconds', () => {
    for (const name of ['from', 'to']) {
      const index = requireOperation(doc, COLLECTION, 'get').parameters.findIndex((p) => resolveRef(doc, p).name === name);
      const validate = validatorAt(ajv, ['paths', COLLECTION, 'get', 'parameters', index, 'schema']);
      assertValid(validate, 0, `${name} 0`);
      assertValid(validate, 1790000100000, `${name} epoch ms`);
      for (const bad of [-1, 1.5, '1790000100000']) assertInvalid(validate, bad, `${name} ${JSON.stringify(bad)}`);
    }
  });

  test('documents the 400 and 403 responses', () => {
    const op = requireOperation(doc, COLLECTION, 'get');
    for (const code of ['400', '403']) assert.ok(op.responses?.[code], `response ${code} is missing`);
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

describe('security schemes', () => {
  test('ApiKeyAuth is the x-api-key header', () => {
    const { type, in: where, name } = doc.components.securitySchemes.ApiKeyAuth;
    assert.deepEqual({ type, in: where, name }, { type: 'apiKey', in: 'header', name: 'x-api-key' });
  });

  test('MobileToken is the Authorization header', () => {
    const { type, in: where, name } = doc.components.securitySchemes.MobileToken;
    assert.deepEqual({ type, in: where, name }, { type: 'apiKey', in: 'header', name: 'Authorization' });
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
    ...INVALID_METADATA_MUTATIONS,
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

// The contract amendments that clients and readers can observe on the wire.
describe('sensor-stream contract amendments', () => {
  const ERROR_SLUGS = {
    [`POST ${COLLECTION}`]: {
      400: [
        'codec-mismatch',
        'expected-multipart-form-data',
        'frame-before-fields',
        'invalid-fields',
        'malformed-multipart',
        'missing-frame',
        'sha256-mismatch',
        'too-many-fields',
        'unexpected-file-part',
      ],
      409: ['frame-conflict'],
      413: ['frame-too-large'],
    },
    [`GET ${COLLECTION}`]: { 400: ['invalid-cursor', 'invalid-query'] },
    [`GET ${ITEM}`]: { 404: ['frame-not-found'] },
  };
  const OPERATIONS = { [`POST ${COLLECTION}`]: [COLLECTION, 'post'], [`GET ${COLLECTION}`]: [COLLECTION, 'get'], [`GET ${ITEM}`]: [ITEM, 'get'] };

  test('SensorStreamError requires an error of the form <status>.<slug>', () => {
    const validate = schemaValidator(ajv, doc, 'SensorStreamError');
    assertValid(validate, { error: '409.frame-conflict' }, '409.frame-conflict');
    assertValid(validate, { error: '400.invalid-fields', detail: 'sample_count: too big' }, 'error with detail');
    for (const bad of [{}, { message: '403.no-such-credentials' }, { error: 'frame-conflict' }, { error: '409' }, { error: 409 }]) {
      assertInvalid(validate, bad, `error body ${JSON.stringify(bad)}`);
    }
  });

  for (const [label, [path, method]] of Object.entries(OPERATIONS)) {
    test(`${label} documents every error response with SensorStreamError and its status`, () => {
      const op = requireOperation(doc, path, method);
      for (const [code, response] of Object.entries(op.responses)) {
        if (code === '200' || code === 'default') continue;
        const media = response.content?.['application/json'];
        assert.equal(media?.schema?.$ref, '#/components/schemas/SensorStreamError', `${label} ${code} schema`);
        const validate = schemaValidator(ajv, doc, 'SensorStreamError');
        for (const [name, example] of Object.entries(media.examples ?? {})) {
          assertValid(validate, example.value, `${label} ${code} example ${name}`);
          assert.ok(example.value.error.startsWith(`${code}.`), `${label} ${code} example ${name} has status ${example.value.error}`);
        }
      }
    });

    for (const [code, slugs] of Object.entries(ERROR_SLUGS[label])) {
      test(`${label} ${code} lists the server's slugs as examples`, () => {
        const op = requireOperation(doc, path, method);
        const examples = op.responses?.[code]?.content?.['application/json']?.examples ?? {};
        const errors = Object.values(examples).map((example) => example.value?.error).sort();
        assert.deepEqual(errors, slugs.map((slug) => `${code}.${slug}`));
      });
    }
  }

  test('the upload 400 names the sha256 and codec magic-number checks', () => {
    const { description } = requireOperation(doc, COLLECTION, 'post').responses['400'];
    assert.match(description, /sha256/);
    assert.match(description, /magic number/);
  });

  test('the upload says to retry 5xx and any other unlisted status with backoff', () => {
    const { description } = requireOperation(doc, COLLECTION, 'post').responses.default;
    assert.match(description, /5xx/);
    assert.match(description, /any other/i);
    assert.match(description, /exponential backoff/);
  });

  test('the upload 401 and 403 say to refresh the session and back off; 403 covers expired tokens', () => {
    const { responses } = requireOperation(doc, COLLECTION, 'post');
    for (const code of ['401', '403']) {
      assert.match(responses[code].description, /refresh/i, `${code} description`);
      assert.match(responses[code].description, /backoff/, `${code} description`);
    }
    assert.match(responses['403'].description, /expired/);
  });

  test('the frame part accepts any filename', () => {
    assert.match(requireSchema(doc, 'SensorStreamUpload').properties.frame.description, /any filename/);
  });

  test('participant_id documents the me alias', () => {
    const param = resolveRef(doc, { $ref: '#/components/parameters/SensorStreamParticipantId' });
    assert.match(param.description, /`me`/);
  });

  test("the download's ETag is the quoted sha256", () => {
    const etag = requireOperation(doc, ITEM, 'get').responses['200'].headers.ETag;
    assert.match(etag.description, /quoted/);
    assert.match(etag.description, /hash/);
    const validate = validatorAt(ajv, ['paths', ITEM, 'get', 'responses', '200', 'headers', 'ETag', 'schema']);
    const sha = 'a8ee18c33e9953a183864eea00deacfc3bfa6a300470a05741f6ece8003c15b6';
    assertValid(validate, `"${sha}"`, 'quoted sha256');
    assertInvalid(validate, sha, 'bare sha256');
    assertInvalid(validate, `W/"${sha}"`, 'weak ETag');
  });

  test("SensorStreamFrame.sha256 says the ETag quotes it, not that they're equal", () => {
    const { description } = requireSchema(doc, 'SensorStreamFrame').properties.sha256;
    assert.doesNotMatch(description, /same value/);
    assert.match(description, /quoted/);
  });
});
