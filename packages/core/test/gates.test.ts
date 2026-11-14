import { describe, expect, it } from 'vitest';
import { extractGates } from '../src/gates.js';
import { loadCiYaml } from '../src/yaml/load.js';
import { normalizeConfig } from '../src/normalize/index.js';

const gates = (y: string) => extractGates(normalizeConfig(loadCiYaml(y)));

describe('gate variable extraction', () => {
  const yml = `
variables: {DEPLOY: "no"}
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_BRANCH
a:
  script: x
  rules:
    - if: $DEPLOY == "yes" && $CI_COMMIT_BRANCH =~ /^release\\//
    - if: $DEPLOY == "maybe"
b:
  script: x
  only: {variables: ['$FORCE']}
`;
  it('collects every variable with usage and suggestions', () => {
    const g = gates(yml);
    const byName = Object.fromEntries(g.map((x) => [x.name, x]));
    expect(Object.keys(byName).sort()).toEqual(['CI_COMMIT_BRANCH', 'CI_PIPELINE_SOURCE', 'DEPLOY', 'FORCE']);
    expect(byName.DEPLOY).toMatchObject({ predefined: false, yamlValue: 'no', values: ['yes', 'maybe'], usedBy: ['a'] });
    expect(byName.CI_COMMIT_BRANCH).toMatchObject({ predefined: true, patterns: ['/^release\\//'], usedBy: ['workflow', 'a'] });
    expect(byName.CI_PIPELINE_SOURCE!.values).toEqual(['merge_request_event']);
    expect(byName.FORCE).toMatchObject({ truthiness: true, usedBy: ['b'] });
  });
  it('lists custom gates before predefined ones', () => {
    expect(gates(yml).map((x) => x.predefined)).toEqual([false, false, true, true]);
  });
});
