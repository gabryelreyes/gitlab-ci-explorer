// Smoke test: every fixture × every preset evaluates without throwing and without config errors.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, makeScenario, PRESET_KINDS } from '../src/index.js';

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

describe.each(files)('corpus: %s', (file) => {
  const text = readFileSync(dir + file, 'utf8');
  it.each(PRESET_KINDS)('%s', (kind) => {
    const r = analyze(text, makeScenario(kind), file);
    expect(r.jobs.length).toBeGreaterThan(0);
    expect(r.errors.filter((e) => !/needs|prevented any jobs|filtered out by workflow/.test(e))).toEqual([]);
  });
});
