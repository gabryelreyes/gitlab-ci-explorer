import { describe, expect, it } from 'vitest';
import { toScenario, type UiScenario } from '../src/App';
import { uploadPath } from '../src/IncludesPanel';

const ui: UiScenario = { kind: 'schedule', opts: { branch: 'main', defaultBranch: 'main', tag: 'v1.0.0' }, userVars: {}, changed: '', files: '' };

describe('toScenario', () => {
  it('ignores the inactive tag option for branch presets', () => {
    const sc = toScenario(ui);
    expect(sc.refType).toBe('branch');
    expect(sc.variables.CI_COMMIT_BRANCH).toBe('main');
    expect(sc.variables.CI_COMMIT_TAG).toBeUndefined();
  });
  it('keeps the tag for the tag preset', () => {
    expect(toScenario({ ...ui, kind: 'tag' }).variables.CI_COMMIT_TAG).toBe('v1.0.0');
  });
  it('preserves an explicit unprotected default branch', () => {
    expect(toScenario(ui).variables.CI_COMMIT_REF_PROTECTED).toBe('true');
    expect(toScenario({ ...ui, opts: { ...ui.opts, protected: false } }).variables.CI_COMMIT_REF_PROTECTED).toBe('false');
  });
});

describe('uploadPath', () => {
  it('strips the selected folder from folder uploads', () => {
    expect(uploadPath({ name: 'b.yml', webkitRelativePath: 'repo/ci/b.yml' })).toBe('ci/b.yml');
    expect(uploadPath({ name: 'b.yml', webkitRelativePath: '' })).toBe('b.yml');
  });
});
