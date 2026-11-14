import { PATH_SEP, pipelineGraph, relatives, type JobResult, type PipelineResult } from '@gce/core';
import { useMemo } from 'react';

interface Props {
  result: PipelineResult;
  selected?: string;
  onSelect: (path: string) => void;
  showExcluded: boolean;
  /** Path prefix of this (child) pipeline's jobs, e.g. `hil: [esp32] › `. */
  prefix?: string;
}

export const whenClass = (j: JobResult) => (j.included ? `w-${j.when}` : 'w-excluded');

/** Selected job name when it belongs to this pipeline level. */
export const localName = (selected: string | undefined, prefix: string) => {
  if (!selected?.startsWith(prefix)) return undefined;
  const rest = selected.slice(prefix.length);
  return rest.includes(PATH_SEP) ? undefined : rest;
};

export function ChildBadge({ j, compact = false }: { j: JobResult; compact?: boolean }) {
  const d = j.downstream;
  if (!j.trigger) return null;
  if (!d) return <span className="badge soft">trigger{j.trigger.dynamic ? ' (dynamic)' : ''}</span>;
  const ok = !!d.result?.created;
  const n = d.result?.jobs.filter((x) => x.included).length ?? 0;
  return <span className={`badge ${ok ? 'child' : 'block'}`} title={d.error ?? d.result?.errors.join('\n')}>child{compact ? '' : ok ? ` · ${n} job${n === 1 ? '' : 's'}` : ' ✗'}</span>;
}

export function PipelineView({ result, selected, onSelect, showExcluded, prefix = '' }: Props) {
  const graph = useMemo(() => pipelineGraph(result), [result]);
  const local = localName(selected, prefix);
  const sel = result.jobs.find((j) => j.name === local);
  const rel = useMemo(() => (sel?.included ? relatives(graph, sel.name) : undefined), [graph, sel]);
  const relOf = (n: string) => (!rel ? '' : n === local ? 'rel-sel' : rel.up.has(n) ? 'rel-up' : rel.down.has(n) ? 'rel-down' : 'rel-dim');
  const visible = result.jobs.filter((j) => showExcluded || j.included);
  const stages = result.stages.filter((s) => visible.some((j) => j.stage === s));
  const children = result.jobs.filter((j) => j.downstream);
  if (!stages.length) return <div className="empty">No jobs to show.</div>;

  return (
    <div className="pview">
      <div className="stages">
        {stages.map((s) => (
          <div key={s} className="stage">
            <div className="stage-name">{s}</div>
            {visible.filter((j) => j.stage === s).map((j) => (
              <button key={j.name} className={`job ${whenClass(j)} ${local === j.name ? 'sel' : ''} ${relOf(j.name)}`} onClick={() => onSelect(prefix + j.name)}>
                <div className="job-name">{j.name}</div>
                <div className="job-meta">
                  <span className="badge">{j.included ? j.when : 'excluded'}</span>
                  {j.blocking && <span className="badge block" title="manual and allow_failure: false — blocks later stages">blocking</span>}
                  {j.included && !j.blocking && j.allowFailure && <span className="badge soft">allow_failure</span>}
                  {j.startIn && <span className="badge soft">{j.startIn}</span>}
                  <ChildBadge j={j} />
                </div>
                {j.included && j.needs && (
                  <div className="needs">{j.needs.length ? `needs: ${j.needs.map((n) => n.job).join(', ')}` : 'needs: [] — starts immediately'}</div>
                )}
                {!j.included && <div className="needs">{j.reason}</div>}
                {rel && j.name !== local && (rel.up.has(j.name) || rel.down.has(j.name)) && (
                  <div className="chain-tag">{rel.up.has(j.name) ? `▲ upstream of ${local}` : `▼ waits for ${local}`}</div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      {children.map((j) => {
        const d = j.downstream!;
        const c = d.result;
        return (
          <section key={j.name} className="child-pl">
            <header>
              <span>▸ child pipeline of <b>{j.name}</b></span>
              <span className={`pill ${c?.created ? 'ok' : 'bad'}`}>{c?.created ? 'created' : 'not created'}</span>
              <span className="muted small">{d.error ?? (c?.invalidConfig ? 'invalid configuration' : c?.workflow.reason)}</span>
            </header>
            {c && c.errors.length > 0 && <div className="small note err">{c.errors.join(' · ')}</div>}
            {c && c.jobs.length > 0 && <PipelineView result={c} selected={selected} onSelect={onSelect} showExcluded={showExcluded} prefix={prefix + j.name + PATH_SEP} />}
          </section>
        );
      })}
    </div>
  );
}
