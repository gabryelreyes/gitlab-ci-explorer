// Compare two evaluated pipelines (same config, different scenarios): which jobs run differently.
import type { PipelineResult } from './evaluate/index.js';
import type { When } from './model.js';

export interface JobState {
  /** Runs in that pipeline (job included AND the pipeline is created). */
  included: boolean;
  when: When;
  blocking: boolean;
  allowFailure: boolean;
  /** Local needs; undefined = stage order. */
  needs?: string[];
  startIn?: string;
}

export type JobField = 'included' | 'when' | 'blocking' | 'allowFailure' | 'needs' | 'startIn';

export interface JobDiff {
  name: string;
  stage: string;
  a?: JobState;
  b?: JobState;
  changes: JobField[];
}

export interface PipelineDiff {
  created: [boolean, boolean];
  jobs: JobDiff[];
  /** Number of jobs with at least one change. */
  changed: number;
}

const stateOf = (r: PipelineResult, name: string): JobState | undefined => {
  const j = r.jobs.find((x) => x.name === name);
  if (!j) return undefined;
  return {
    included: r.created && j.included,
    when: j.when,
    blocking: j.blocking,
    allowFailure: j.allowFailure,
    needs: j.needs?.filter((n) => !n.pipeline && !n.project).map((n) => n.job),
    startIn: j.startIn,
  };
};

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

export function diffPipelines(a: PipelineResult, b: PipelineResult): PipelineDiff {
  const names = [...new Set([...a.jobs, ...b.jobs].map((j) => j.name))];
  const jobs = names.map((name): JobDiff => {
    const sa = stateOf(a, name);
    const sb = stateOf(b, name);
    const changes: JobField[] = [];
    if (!!sa?.included !== !!sb?.included) changes.push('included');
    else if (sa?.included && sb?.included) {
      for (const f of ['when', 'blocking', 'allowFailure', 'needs', 'startIn'] as const) if (!same(sa[f], sb[f])) changes.push(f);
    }
    const stage = (a.jobs.find((j) => j.name === name) ?? b.jobs.find((j) => j.name === name))!.stage;
    return { name, stage, a: sa, b: sb, changes };
  });
  return { created: [a.created, b.created], jobs, changed: jobs.filter((j) => j.changes.length).length };
}
