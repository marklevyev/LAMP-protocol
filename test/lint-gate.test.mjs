// Tests that `npm run lint` fails on any new problem, warning or error, that
// `.redocly.lint-ignore.yaml` doesn't already record.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import { stringify } from 'yaml';

import { loadOpenApi, repoPath } from './helpers.mjs';

const REDOCLY = repoPath('node_modules/.bin/redocly');
let dir;

/** Writes `doc` as `openapi.yml` next to this repo's lint configuration and lints it. */
function lint(doc) {
  writeFileSync(join(dir, 'openapi.yml'), stringify(doc, { lineWidth: 0 }));
  return spawnSync(REDOCLY, ['lint', 'openapi.yml'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, REDOCLY_TELEMETRY: 'off', REDOCLY_SUPPRESS_UPDATE_NOTICE: 'true' },
  });
}

describe('npm run lint', () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'lamp-protocol-lint-'));
    for (const file of ['redocly.yaml', '.redocly.lint-ignore.yaml']) copyFileSync(repoPath(file), join(dir, file));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('passes on openapi.yml as committed', () => {
    const result = lint(loadOpenApi());
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('fails on a new warning-level problem (an unused component)', () => {
    const doc = loadOpenApi();
    doc.components.schemas.UnusedThing = { type: 'object' };
    const result = lint(doc);
    assert.notEqual(result.status, 0, `lint passed:\n${result.stdout}${result.stderr}`);
  });

  test('fails on a new operation without a 4xx response', () => {
    const doc = loadOpenApi();
    doc.paths['/lint-gate-probe'] = {
      get: {
        operationId: 'LintGate.probe',
        summary: 'Probe.',
        description: 'Probe.',
        tags: ['SensorStream'],
        security: [{ ApiKeyAuth: [] }],
        responses: { 200: { description: 'Success' } },
      },
    };
    const result = lint(doc);
    assert.notEqual(result.status, 0, `lint passed:\n${result.stdout}${result.stderr}`);
  });
});
