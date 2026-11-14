// Scenario = what GitLab knows when it creates a pipeline: source, ref, predefined variables, and
// the answers for things we can't detect (changed files, repo files).

export type PresetKind =
  | 'push' | 'tag' | 'merge_request_event' | 'schedule' | 'web' | 'api' | 'trigger'
  | 'pipeline' | 'parent_pipeline' | 'chat' | 'external';

export const PRESET_KINDS: readonly PresetKind[] = [
  'push', 'tag', 'merge_request_event', 'schedule', 'web', 'api', 'trigger', 'pipeline', 'parent_pipeline', 'chat', 'external',
];

export type RefType = 'branch' | 'tag' | 'mr';

export interface Scenario {
  kind: PresetKind;
  /** CI_PIPELINE_SOURCE */
  source: string;
  refType: RefType;
  /** Branch / tag name; for MR pipelines the source branch. */
  ref: string;
  /** Predefined variables. */
  variables: Record<string, string>;
  /** Project/group/pipeline variables: override anything defined in YAML. */
  userVariables?: Record<string, string>;
  /** undefined => every `changes:` clause is assumed true. */
  changedFiles?: string[];
  /** undefined => every `exists:` clause is assumed true. */
  repoFiles?: string[];
  /** Forced clause results, keyed `<job|workflow>#<ruleIndex>.<changes|exists>` or `<job>#only.changes`. */
  overrides?: Record<string, boolean>;
  inputs?: Record<string, unknown>;
  /** Child pipelines: the parent's source, which decides whether `changes:` has a diff. */
  diffSource?: string;
}

export interface PresetOptions {
  branch?: string;
  tag?: string;
  defaultBranch?: string;
  mrSource?: string;
  mrTarget?: string;
  mrIid?: string;
  mrLabels?: string[];
  mrTitle?: string;
  /** Branch pipeline while an MR is open for the branch (CI_OPEN_MERGE_REQUESTS). */
  openMr?: boolean;
  /** Ref is protected. Default: true for the default branch only. */
  protected?: boolean;
  /** First push of a new branch (changes: always true). */
  newBranch?: boolean;
  projectPath?: string;
  commitMessage?: string;
}

export function refSlug(ref: string): string {
  return ref.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 63).replace(/^-+|-+$/g, '');
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
const FAKE_SHA = '1111111111111111111111111111111111111111';
const BEFORE_SHA = '2222222222222222222222222222222222222222';

const SOURCE: Record<PresetKind, string> = {
  push: 'push', tag: 'push', merge_request_event: 'merge_request_event', schedule: 'schedule', web: 'web',
  api: 'api', trigger: 'trigger', pipeline: 'pipeline', parent_pipeline: 'parent_pipeline', chat: 'chat', external: 'external',
};

export function makeScenario(kind: PresetKind, o: PresetOptions = {}): Scenario {
  const defaultBranch = o.defaultBranch ?? 'main';
  const projectPath = o.projectPath ?? 'group/project';
  const source = SOURCE[kind];
  const refType: RefType = kind === 'merge_request_event' ? 'mr' : kind === 'tag' || (o.tag && kind !== 'push') ? 'tag' : 'branch';
  const ref = refType === 'mr' ? (o.mrSource ?? 'feature') : refType === 'tag' ? (o.tag ?? 'v1.0.0') : (o.branch ?? defaultBranch);
  // Default branch is protected by default in GitLab; tags only if a protected-tag rule exists.
  const isProtected = o.protected ?? (refType === 'branch' && ref === defaultBranch);
  const message = o.commitMessage ?? 'Commit message';

  const v: Record<string, string> = {
    CI: 'true',
    GITLAB_CI: 'true',
    CI_PIPELINE_SOURCE: source,
    CI_DEFAULT_BRANCH: defaultBranch,
    CI_PROJECT_PATH: projectPath,
    CI_PROJECT_NAMESPACE: projectPath.split('/').slice(0, -1).join('/'),
    CI_PROJECT_NAME: projectPath.split('/').pop()!,
    CI_COMMIT_REF_NAME: ref,
    CI_COMMIT_REF_SLUG: refSlug(ref),
    CI_COMMIT_REF_PROTECTED: String(isProtected),
    CI_COMMIT_SHA: FAKE_SHA,
    CI_COMMIT_SHORT_SHA: FAKE_SHA.slice(0, 8),
    CI_COMMIT_BEFORE_SHA: kind === 'push' && !o.newBranch ? BEFORE_SHA : ZERO_SHA,
    CI_COMMIT_MESSAGE: message,
    CI_COMMIT_TITLE: message.split('\n')[0]!,
  };
  if (refType === 'branch') v.CI_COMMIT_BRANCH = ref;
  if (refType === 'tag') { v.CI_COMMIT_TAG = ref; v.CI_COMMIT_TAG_MESSAGE = ''; }
  if (refType === 'branch' && o.openMr) v.CI_OPEN_MERGE_REQUESTS = `${projectPath}!${o.mrIid ?? '1'}`;
  if (kind === 'trigger') v.CI_PIPELINE_TRIGGERED = 'true';
  if (refType === 'mr') {
    Object.assign(v, {
      CI_MERGE_REQUEST_ID: '1001',
      CI_MERGE_REQUEST_IID: o.mrIid ?? '1',
      CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: ref,
      CI_MERGE_REQUEST_TARGET_BRANCH_NAME: o.mrTarget ?? defaultBranch,
      CI_MERGE_REQUEST_EVENT_TYPE: 'detached',
      CI_MERGE_REQUEST_DRAFT: 'false',
      CI_OPEN_MERGE_REQUESTS: `${projectPath}!${o.mrIid ?? '1'}`,
      CI_MERGE_REQUEST_TITLE: o.mrTitle ?? 'Merge request',
      CI_MERGE_REQUEST_PROJECT_PATH: projectPath,
      CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: projectPath,
      CI_MERGE_REQUEST_REF_PATH: `refs/merge-requests/${o.mrIid ?? '1'}/head`,
      CI_MERGE_REQUEST_DIFF_BASE_SHA: BEFORE_SHA,
      CI_MERGE_REQUEST_SOURCE_BRANCH_PROTECTED: String(o.protected ?? false),
      CI_MERGE_REQUEST_TARGET_BRANCH_PROTECTED: String((o.mrTarget ?? defaultBranch) === defaultBranch),
    });
    if (o.mrLabels?.length) v.CI_MERGE_REQUEST_LABELS = o.mrLabels.join(',');
  }
  return { kind, source, refType, ref, variables: v };
}
