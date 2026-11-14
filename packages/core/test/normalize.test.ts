import { describe, expect, it } from 'vitest';
import { loadCiYaml } from '../src/yaml/load.js';
import { normalizeConfig } from '../src/normalize/index.js';

const norm = (src: string) => normalizeConfig(loadCiYaml(src));
const job = (src: string, name: string) => {
  const c = norm(src);
  const j = c.jobs.find((x) => x.name === name);
  if (!j) throw new Error(`no job ${name}; errors: ${c.errors.join('; ')}`);
  return j;
};

describe('yaml loading', () => {
  it('supports anchors and << merge keys', () => {
    const doc = loadCiYaml(`
.base: &base
  stage: build
  script: [echo]
a:
  <<: *base
  stage: deploy
`);
    expect(doc.errors).toEqual([]);
    expect((doc.body as any).a).toEqual({ stage: 'deploy', script: ['echo'] });
  });

  it('splits the spec header document', () => {
    const doc = loadCiYaml(`spec:\n  inputs:\n    env: {default: dev}\n---\nj:\n  script: x\n`);
    expect(doc.header).toEqual({ spec: { inputs: { env: { default: 'dev' } } } });
    expect(Object.keys(doc.body as object)).toEqual(['j']);
  });

  it('records the line of each top-level key', () => {
    const doc = loadCiYaml(`a:\n  script: x\n\nb:\n  script: y\n`);
    expect(doc.lines).toEqual({ a: 1, b: 4 });
  });

  it('uses YAML 1.1 scalars like Psych (yes/no booleans, 0-prefixed octal)', () => {
    const doc = loadCiYaml('a: {x: yes, y: off, z: 0755, v: 1.10}\n');
    expect((doc.body as any).a).toEqual({ x: true, y: false, z: 493, v: 1.1 });
  });

  it('reports YAML syntax errors instead of throwing', () => {
    const doc = loadCiYaml('a: [1, 2\n');
    expect(doc.errors.length).toBeGreaterThan(0);
  });
});

describe('extends', () => {
  it('deep-merges hashes, replaces arrays, job wins', () => {
    const j = job(`
.base:
  variables: {A: "1", B: "1"}
  script: [one]
  rules: [{if: '$X'}]
j:
  extends: .base
  variables: {B: "2"}
  script: [two]
`, 'j');
    expect(j.raw.variables).toEqual({ A: '1', B: '2' });
    expect(j.raw.script).toEqual(['two']);
    expect(j.rules).toEqual([{ if: '$X' }]);
  });

  it('multiple parents: later parent wins; multi-level chain', () => {
    const j = job(`
.a: {stage: build, script: [a]}
.b: {extends: .a, stage: deploy}
.c: {stage: test, tags: [c]}
j: {extends: [.b, .c]}
`, 'j');
    expect(j.stage).toBe('test');
    expect(j.raw.script).toEqual(['a']);
    expect(j.raw.tags).toEqual(['c']);
  });

  it('reports unknown and circular extends', () => {
    expect(norm('j: {extends: .nope, script: x}').errors.join()).toMatch(/\.nope/);
    expect(norm('.a: {extends: .b}\n.b: {extends: .a}\nj: {extends: .a, script: x}').errors.join()).toMatch(/circular/i);
  });
});

describe('!reference', () => {
  it('resolves into scalars and flattens into script/rules arrays', () => {
    const j = job(`
.setup:
  script: [s1, s2]
.r:
  rules:
    - if: '$A'
j:
  script:
    - !reference [.setup, script]
    - s3
  rules:
    - !reference [.r, rules]
    - when: never
`, 'j');
    expect(j.raw.script).toEqual(['s1', 's2', 's3']);
    expect(j.rules).toEqual([{ if: '$A' }, { when: 'never' }]);
  });

  it('sees keys merged through extends', () => {
    const j = job(`
.p: {variables: {X: "x"}}
.q: {extends: .p}
j: {script: x, variables: {Y: !reference [.q, variables, X]}}
`, 'j');
    expect(j.raw.variables).toEqual({ Y: 'x' });
  });

  it('reports missing references', () => {
    expect(norm('j: {script: !reference [.none, script]}').errors.join()).toMatch(/\.none/);
  });
});

describe('default, inherit, stages', () => {
  const src = `
stages: [build, deploy]
variables: {G1: g1, G2: g2}
default:
  image: alpine
  tags: [docker]
a: {stage: build, script: x}
b: {stage: deploy, script: x, image: debian, inherit: {default: [tags], variables: [G2]}}
c: {script: x}
.hidden: {script: x}
`;
  it('applies default keys unless the job defines them', () => {
    const c = norm(src);
    const a = c.jobs.find((j) => j.name === 'a')!;
    expect(a.raw.image).toBe('alpine');
    expect(a.raw.tags).toEqual(['docker']);
  });
  it('honours inherit:default and inherit:variables lists', () => {
    const b = norm(src).jobs.find((j) => j.name === 'b')!;
    expect(b.raw.image).toBe('debian');
    expect(b.raw.tags).toEqual(['docker']);
    expect(Object.keys(b.inheritedVariables)).toEqual(['G2']);
  });
  it('injects .pre/.post, defaults stage to test and errors on unknown stage', () => {
    const c = norm(src);
    expect(c.stages).toEqual(['.pre', 'build', 'deploy', '.post']);
    expect(c.errors.join()).toMatch(/c job: chosen stage test does not exist/);
  });
  it('drops hidden jobs', () => {
    expect(norm(src).jobs.map((j) => j.name)).toEqual(['a', 'b', 'c']);
  });
  it('uses the default stage list when stages is absent', () => {
    expect(norm('j: {script: x}').stages).toEqual(['.pre', 'build', 'test', 'deploy', '.post']);
  });
  it('normalizes needs and variables', () => {
    const j = job(`
a: {script: x}
b: {script: x, needs: [a, {job: c, optional: true}], variables: {V: {value: "1", description: d}, N: 5}}
`, 'b');
    expect(j.needs).toEqual([
      { job: 'a', optional: false, artifacts: true },
      { job: 'c', optional: true, artifacts: true },
    ]);
    expect(j.variables).toEqual({ V: { value: '1', expand: true }, N: { value: '5', expand: true } });
  });
  it('flags jobs without script or trigger', () => {
    expect(norm('j: {stage: test}').errors.join()).toMatch(/script/);
  });
});
