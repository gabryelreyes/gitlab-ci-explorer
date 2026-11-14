import type { JobResult, PipelineResult } from '@gce/core';

interface Props { result: PipelineResult; selected?: string; onSelect: (name: string) => void; showExcluded: boolean }

export const whenClass = (j: JobResult) => (j.included ? `w-${j.when}` : 'w-excluded');

export function PipelineView({ result, selected, onSelect, showExcluded }: Props) {
  const visible = result.jobs.filter((j) => showExcluded || j.included);
  const stages = result.stages.filter((s) => visible.some((j) => j.stage === s));
  if (!stages.length) return <div className="empty">No jobs to show.</div>;

  return (
    <div className="stages">
      {stages.map((s) => (
        <div key={s} className="stage">
          <div className="stage-name">{s}</div>
          {visible.filter((j) => j.stage === s).map((j) => (
            <button key={j.name} className={`job ${whenClass(j)} ${selected === j.name ? 'sel' : ''}`} onClick={() => onSelect(j.name)}>
              <div className="job-name">{j.name}</div>
              <div className="job-meta">
                <span className="badge">{j.included ? j.when : 'excluded'}</span>
                {j.blocking && <span className="badge block" title="manual and allow_failure: false — blocks later stages">blocking</span>}
                {j.included && !j.blocking && j.allowFailure && <span className="badge soft">allow_failure</span>}
                {j.startIn && <span className="badge soft">{j.startIn}</span>}
                {j.trigger && <span className="badge soft">trigger{j.trigger.dynamic ? ' (dynamic)' : ''}</span>}
              </div>
              {j.included && j.needs && (
                <div className="needs">{j.needs.length ? `needs: ${j.needs.map((n) => n.job).join(', ')}` : 'needs: [] — starts immediately'}</div>
              )}
              {!j.included && <div className="needs">{j.reason}</div>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
