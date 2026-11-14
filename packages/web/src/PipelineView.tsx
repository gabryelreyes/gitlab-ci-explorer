import { pipelineGraph, relatives, type JobResult, type PipelineResult } from '@gce/core';
import { useMemo } from 'react';

interface Props { result: PipelineResult; selected?: string; onSelect: (name: string) => void; showExcluded: boolean }

export const whenClass = (j: JobResult) => (j.included ? `w-${j.when}` : 'w-excluded');

export function PipelineView({ result, selected, onSelect, showExcluded }: Props) {
  const graph = useMemo(() => pipelineGraph(result), [result]);
  const sel = result.jobs.find((j) => j.name === selected);
  const rel = useMemo(() => (sel?.included ? relatives(graph, sel.name) : undefined), [graph, sel]);
  const relOf = (n: string) => (!rel ? '' : n === selected ? 'rel-sel' : rel.up.has(n) ? 'rel-up' : rel.down.has(n) ? 'rel-down' : 'rel-dim');
  const visible = result.jobs.filter((j) => showExcluded || j.included);
  const stages = result.stages.filter((s) => visible.some((j) => j.stage === s));
  if (!stages.length) return <div className="empty">No jobs to show.</div>;

  return (
    <div className="stages">
      {stages.map((s) => (
        <div key={s} className="stage">
          <div className="stage-name">{s}</div>
          {visible.filter((j) => j.stage === s).map((j) => (
            <button key={j.name} className={`job ${whenClass(j)} ${selected === j.name ? 'sel' : ''} ${relOf(j.name)}`} onClick={() => onSelect(j.name)}>
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
              {rel && j.name !== selected && (rel.up.has(j.name) || rel.down.has(j.name)) && (
                <div className="chain-tag">{rel.up.has(j.name) ? `▲ upstream of ${selected}` : `▼ waits for ${selected}`}</div>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
