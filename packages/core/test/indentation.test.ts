import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli-lib.js';
import { loadCiYaml } from '../src/yaml/load.js';

const ok = `build:
  stage: build
  script:
    - |
      echo start
      if [ -n "$X" ]; then
        echo x
      fi
test:
  stage: test
  script:
    - echo hi
`;

// Leading spaces lost when copying: everything at 0–1 spaces.
const flattened = `build:
 stage: build
 script:
 - |
 echo start
 if [ -n "$X" ]; then
echo x
 fi
test:
 stage: test
 script:
 - echo hi
deploy:
 stage: deploy
 script:
 - |
 echo deploy
curl --request POST \\
 --header "X: y" \\
"https://example.com/x"
`;

// One block scalar whose continuation lines dropped back to column 0.
const partial = ok.replace(/^ {6}(if|fi)/gm, '$1');

describe('bad indentation', () => {
  it('a correctly indented file has no errors', () => {
    expect(loadCiYaml(ok).errors).toEqual([]);
  });

  it('flattened file: error with an indentation hint', () => {
    const errors = loadCiYaml(flattened).errors;
    expect(errors[0]).toMatch(/indentation looks flattened/);
  });

  it('flattened file: cascading YAML errors are capped', () => {
    expect(loadCiYaml(flattened).errors.length).toBeLessThanOrEqual(4);
  });

  it('mis-indented block scalar: error points at the offending line', () => {
    const errors = loadCiYaml(partial).errors;
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/line 6, column 1/);
    expect(errors.join()).not.toMatch(/flattened/);
  });

  it('CLI headline says the config is invalid', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'gce-')), '.gitlab-ci.yml');
    writeFileSync(f, partial);
    expect(runCli([f]).out.split('\n')[0]).toMatch(/NOT CREATED — invalid configuration/);
  });
});
