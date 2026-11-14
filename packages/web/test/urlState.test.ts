import { describe, expect, it } from 'vitest';
import { decodeState, encodeState } from '../src/urlState';

const state = {
  v: 1 as const,
  text: 'stages: [build]\nbuild:\n  script: [make]\n  rules:\n    - if: $CI_COMMIT_BRANCH == "main"\n',
  ui: { kind: 'push' as const, opts: { branch: 'main', defaultBranch: 'main' }, userVars: { RUN_HIL: 'true' }, changed: 'src/a.c', files: '' },
  tab: 'graph',
  selected: 'build',
};

describe('URL state', () => {
  it('round-trips the state', async () => {
    expect(await decodeState(await encodeState(state))).toEqual(state);
  });

  it('produces URL-safe text', async () => {
    expect(await encodeState(state)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('compresses large configs', async () => {
    const big = { ...state, text: state.text.repeat(200) };
    expect((await encodeState(big)).length).toBeLessThan(big.text.length / 10);
  });

  it('rejects garbage and foreign versions', async () => {
    expect(await decodeState('not-valid!!')).toBeUndefined();
    expect(await decodeState(await encodeState({ ...state, v: 2 } as never))).toBeUndefined();
  });

  it('rejects incomplete or malformed scenarios', async () => {
    const enc = (s: unknown) => encodeState(s as never);
    expect(await decodeState(await enc({ v: 1, text: '', ui: { kind: 'push' } }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, ui: { ...state.ui, kind: 'bogus' } }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, ui: { ...state.ui, opts: { branch: 1 } } }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, uiB: { kind: 'push' } }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, files: { a: 1 } }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, tab: 3 }))).toBeUndefined();
    expect(await decodeState(await enc({ ...state, uiB: state.ui, files: { 'local:a.yml': 'x' } }))).toBeTruthy();
  });
});
