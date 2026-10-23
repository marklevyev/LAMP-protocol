// Shared helpers for the openapi.yml schema tests.
//
// The helpers load `openapi.yml`, register it with Ajv, and look up schemas
// and examples by name. A missing schema or example fails with an assertion
// that names the missing component, so a red run says what's absent.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const ROOT = new URL('../', import.meta.url);
const OPENAPI_ID = 'openapi.yml';

/** The four binary accelerometer tiers, in contract order. */
export const ACCEL_SPECS = [
  'lamp.accelerometer10hz',
  'lamp.accelerometer20hz',
  'lamp.accelerometer50hz',
  'lamp.accelerometer100hz',
];

/** The JSON GPS spec. */
export const GPS_SPEC = 'lamp.gps1m';

/** All five specs that the sensor-stream contract adds. */
export const ALL_SPECS = [GPS_SPEC, ...ACCEL_SPECS];

/** The multipart text fields, in the order clients must send them. */
export const UPLOAD_TEXT_FIELDS = [
  'sensor_spec',
  'start_timestamp',
  'end_timestamp',
  'sample_count',
  'codec',
  'codec_format_version',
  'platform',
  'unit',
  'sha256',
];

/**
 * Invalid variants of valid frame metadata, each with one rule broken. Both
 * `SensorStreamUpload` and `SensorStreamFrame` must reject every one.
 */
export const INVALID_METADATA_MUTATIONS = {
  'an unknown sensor_spec': (u) => ({ ...u, sensor_spec: 'lamp.accelerometer' }),
  'the gps1m spec (JSON only)': (u) => ({ ...u, sensor_spec: 'lamp.gps1m' }),
  'sample_count 0': (u) => ({ ...u, sample_count: 0 }),
  'sample_count 66001': (u) => ({ ...u, sample_count: 66001 }),
  'a non-integer sample_count': (u) => ({ ...u, sample_count: 1.5 }),
  "codec 'gzip'": (u) => ({ ...u, codec: 'gzip' }),
  'openzl with codec_format_version 0': (u) => ({ ...u, codec: 'openzl', codec_format_version: 0 }),
  'zstd with codec_format_version 24': (u) => ({ ...u, codec: 'zstd', codec_format_version: 24 }),
  "platform 'web'": (u) => ({ ...u, platform: 'web' }),
  "unit 'g'": (u) => ({ ...u, unit: 'g' }),
  'an uppercase sha256': (u) => ({ ...u, sha256: u.sha256.toUpperCase() }),
  'a short sha256': (u) => ({ ...u, sha256: u.sha256.slice(0, 63) }),
  'a negative start_timestamp': (u) => ({ ...u, start_timestamp: -1 }),
  'a negative end_timestamp': (u) => ({ ...u, end_timestamp: -1 }),
  'a string start_timestamp': (u) => ({ ...u, start_timestamp: String(u.start_timestamp) }),
};

/** Returns the absolute path of a file in this repository. */
export function repoPath(relative) {
  return fileURLToPath(new URL(relative, ROOT));
}

/** Parses a JSON file in this repository. */
export function readJson(relative) {
  return JSON.parse(readFileSync(repoPath(relative), 'utf8'));
}

/** Returns the lowercase hex SHA-256 digest of a file in this repository. */
export function sha256Of(relative) {
  return createHash('sha256').update(readFileSync(repoPath(relative))).digest('hex');
}

/** Parses `openapi.yml`. */
export function loadOpenApi() {
  return parse(readFileSync(repoPath('openapi.yml'), 'utf8'));
}

/**
 * Returns a deep copy of an OpenAPI 3.0 document with boolean
 * `exclusiveMinimum`/`exclusiveMaximum` (OpenAPI 3.0 and JSON Schema draft 4
 * style) rewritten to the numeric form that Ajv's draft-07 dialect expects.
 * Property schemas that happen to be named `exclusiveMinimum` are objects, not
 * booleans, so they're left alone.
 */
export function toJsonSchemaDialect(node) {
  if (Array.isArray(node)) return node.map(toJsonSchemaDialect);
  if (node === null || typeof node !== 'object') return node;
  const out = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, toJsonSchemaDialect(v)]));
  for (const [exclusive, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ]) {
    if (typeof out[exclusive] !== 'boolean') continue;
    if (out[exclusive] && typeof out[bound] === 'number') {
      out[exclusive] = out[bound];
      delete out[bound];
    } else {
      delete out[exclusive];
    }
  }
  return out;
}

/**
 * Creates an Ajv instance that knows the whole OpenAPI document, so that
 * `$ref: '#/components/schemas/...'` resolves inside it.
 *
 * `strict: false` lets Ajv ignore OpenAPI-only keywords such as `example`,
 * `x-*`, and `discriminator`. `ajv-formats` covers the standard formats; the
 * OpenAPI formats (`int32`, `int64`, `float`, `double`, `binary`) are
 * registered here when the installed `ajv-formats` lacks them.
 */
export function createAjv(doc) {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const openApiFormats = {
    int32: { type: 'number', validate: (n) => Number.isInteger(n) && n >= -(2 ** 31) && n < 2 ** 31 },
    int64: { type: 'number', validate: (n) => Number.isInteger(n) },
    float: { type: 'number', validate: () => true },
    double: { type: 'number', validate: () => true },
    binary: true,
  };
  for (const [name, format] of Object.entries(openApiFormats)) {
    if (!ajv.formats[name]) ajv.addFormat(name, format);
  }
  ajv.addSchema(toJsonSchemaDialect(doc), OPENAPI_ID);
  return ajv;
}

/** Returns `components.schemas[name]`, failing with a clear message if it's missing. */
export function requireSchema(doc, name) {
  const schema = doc?.components?.schemas?.[name];
  assert.ok(schema, `components.schemas.${name} is missing from openapi.yml`);
  return schema;
}

/** Returns a compiled validator for `components.schemas[name]`. */
export function schemaValidator(ajv, doc, name) {
  requireSchema(doc, name);
  const validate = ajv.getSchema(`${OPENAPI_ID}#/components/schemas/${name}`);
  assert.equal(typeof validate, 'function', `Ajv can't compile components.schemas.${name}`);
  return validate;
}

/**
 * Returns a compiled validator for the schema at a JSON pointer inside
 * `openapi.yml`, given as path segments, so its local `$ref`s resolve.
 */
export function validatorAt(ajv, segments) {
  const pointer = segments
    .map((s) => encodeURIComponent(String(s).replace(/~/g, '~0').replace(/\//g, '~1')))
    .join('/');
  const validate = ajv.getSchema(`${OPENAPI_ID}#/${pointer}`);
  assert.equal(typeof validate, 'function', `Ajv can't compile #/${segments.join('/')}`);
  return validate;
}

/** Returns `components.examples[name].value`, failing with a clear message if it's missing. */
export function requireExample(doc, name) {
  const example = doc?.components?.examples?.[name];
  assert.ok(example, `components.examples.${name} is missing from openapi.yml`);
  assert.ok('value' in example, `components.examples.${name} has no value`);
  return structuredClone(example.value);
}

/** Returns the operation at `paths[path][method]`, failing with a clear message if it's missing. */
export function requireOperation(doc, path, method) {
  const operation = doc?.paths?.[path]?.[method];
  assert.ok(operation, `${method.toUpperCase()} ${path} is missing from openapi.yml`);
  return operation;
}

/** Resolves a local `$ref` (`#/a/b/c`) against the document. */
export function resolveRef(doc, node) {
  if (!node || typeof node.$ref !== 'string') return node;
  return node.$ref
    .replace(/^#\//, '')
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((acc, key) => acc?.[key], doc);
}

/** Asserts that `validate` accepts `value`, printing Ajv's errors if not. */
export function assertValid(validate, value, label) {
  const ok = validate(value);
  assert.ok(ok, `${label} should be valid, but Ajv says: ${JSON.stringify(validate.errors)}`);
}

/** Asserts that `validate` rejects `value`. */
export function assertInvalid(validate, value, label) {
  assert.equal(validate(value), false, `${label} should be invalid, but Ajv accepted it`);
}
