import { evaluatePipeline, type NormalizedConfig, type PresetKind, type PresetOptions } from '@gce/core';
import { useMemo } from 'react';
import { toScenario, type UiScenario } from './App';
import { whenClass } from './PipelineView';

interface Props { cfg: NormalizedConfig; ui: UiScenario; onPick: (kind: PresetKind, opts: PresetOptions, job: string) => void }

export function MatrixView({ cfg, ui, onPick }: Props) {
  const o = ui.opts;
  const def = o.defaultBranch || 'main';
  const feature = o.branch && o.branch !== def ? o.branch : 'feature/x';
  const cols = useMemo((): [string, PresetKind, PresetOptions][] => [
    [`push ${def}`, 'push', { ...o, branch: def, openMr: false }],
    [`push ${feature}`, 'push', { ...o, branch: feature, openMr: false }],
    [`push ${feature} + open MR`, 'push', { ...o, branch: feature, openMr: true }],
    ['merge request', 'merge_request_event', o],
    [`tag ${o.tag || 'v1.0.0'}`, 'tag', o],
    ['schedule', 'schedule', { ...o, branch: def }],
    ['web', 'web', { ...o, branch: def }],
  ], [o, def, feature]);
  const results = useMemo(() => cols.map(([, k, op]) => evaluatePipeline(cfg, toScenario(ui, k, op))), [cols, cfg, ui]);
  const names = cfg.jobs.map((j) => j.name);

  return (
    <div className="matrix-wrap">
      <table className="matrix">
        <thead>
          <tr>
            <th>job</th>
            {cols.map(([n], i) => (
              <th key={n} className={results[i]!.created ? '' : 'nopipe'} title={results[i]!.errors.join('\n') || results[i]!.workflow.reason}>
                {n}{results[i]!.created ? '' : ' ✗'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {names.map((name) => (
            <tr key={name}>
              <th>{name}</th>
              {results.map((r, i) => {
                const j = r.jobs.find((x) => x.name === name)!;
                return (
                  <td key={i}>
                    <button className={`cell ${whenClass(j)}`} title={j.reason} onClick={() => onPick(cols[i]![1], cols[i]![2], name)}>
                      {j.included ? j.when.replace('on_success', '●') : '·'}{j.blocking ? ' !' : ''}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">✗ = no pipeline for that type (hover for reason). Click a cell to open that scenario. Gate variables and file lists from the panel apply to every column.</p>
    </div>
  );
}
