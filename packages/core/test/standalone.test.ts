import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli-lib.js';
import { normalizeConfig } from '../src/normalize/index.js';
import { loadCiYaml } from '../src/yaml/load.js';

describe('standalone mode (no GitLab access)', () => {
  const yml = `
include:
  - local: ci/build.yml
  - project: grp/templates
    ref: v2
    file: [a.yml, b.yml]
  - remote: https://example.com/x.yml
  - template: Security/SAST.gitlab-ci.yml
  - component: $CI_SERVER_FQDN/grp/comp/lint@1.0
  - extra.yml
j: {script: x}
`;
  it('lists every include as unresolved', () => {
    const c = normalizeConfig(loadCiYaml(yml));
    expect(c.includes.map((i) => `${i.type}:${i.target}`)).toEqual([
      'local:ci/build.yml', 'project:grp/templates@v2:a.yml', 'project:grp/templates@v2:b.yml',
      'remote:https://example.com/x.yml', 'template:Security/SAST.gitlab-ci.yml',
      'component:$CI_SERVER_FQDN/grp/comp/lint@1.0', 'local:extra.yml',
    ]);
    expect(c.warnings.join()).toMatch(/standalone mode.*7 include/i);
  });
  it('the CLI shows a visible banner', () => {
    const f = fileURLToPath(new URL('./fixtures/with-includes.yml', import.meta.url));
    const out = runCli([f]).out;
    expect(out.split('\n')[0]).toMatch(/⚠ standalone mode/i);
  });
});

describe('broken YAML reporting', () => {
  const flat = readFileSync(fileURLToPath(new URL('../../../realtest/.gitlab-ci.yml', import.meta.url)), 'utf8');
  it('caps cascading YAML errors and hints at flattened indentation', () => {
    const d = loadCiYaml(flat);
    expect(d.errors.length).toBeLessThanOrEqual(4);
    expect(d.errors.join('\n')).toMatch(/indentation/i);
  });
  it('CLI headline says the config is invalid', () => {
    const out = runCli([fileURLToPath(new URL('../../../realtest/.gitlab-ci.yml', import.meta.url))]).out;
    expect(out.split('\n')[0]).toMatch(/NOT CREATED — invalid configuration/);
  });
});
