import { diffPipelines, type JobField, type JobState, type PipelineResult } from '@gce/core';
import { useMemo, useState } from 'react';
import { scenarioLabel, type UiScenario } from './App';

interface Props {
  a: PipelineResult;
  b: PipelineResult;
  uiA: UiScenario;
  uiB: UiScenario;
  selected?: string;
  onSelect: (name: string) => void;
  onSwap: () => void;
  onCopyAtoB: () => void;
}

const FIELD_LABEL: Record<JobField, string> = {
  included: 'runs', when: 'when', blocking: 'blocking', allowFailure: 'allow_failure', needs: 'needs', startIn: 'start_in',
};

function Cell({ s, other, changes }: { s?: JobState; other?: JobState; changes: JobField[] }) {
  if (!s?.included) return <span className="muted">· not in pipeline</span>;
  const hot = (f: JobField) => (changes.includes(f) && other?.included ? 'hot' : '');
  return (
    <span className={`state w-${s.when}`}>
      <span className={`badge ${hot('when')}`}>{s.when}</span>
      {s.blocking && <span className={`badge block ${hot('blocking')}`}>blocking</span>}
      {s.allowFailure && !s.blocking && <span className={`badge soft ${hot('allowFailure')}`}>allow_failure</span>}
      {s.startIn && <span className={`badge soft ${hot('startIn')}`}>{s.startIn}</span>}
      <span className={`small muted ${hot('needs')}`}>{s.needs ? (s.needs.length ? `needs: ${s.needs.join(', ')}` : 'needs: []') : ''}</span>
    </span>
  );
}

function Side({ name, ui, r }: { name: string; ui: UiScenario; r: PipelineResult }) {
  return (
    <div className="cmp-side">
      <b>{name}</b> <code>{scenarioLabel(ui)}</code>{' '}
      <span className={`pill ${r.created ? 'ok' : 'bad'}`}>{r.created ? 'created' : 'no pipeline'}</span>
      {!r.created && <div className="small muted">{r.errors[0] ?? r.workflow.reason}</div>}
    </div>
  );
}

export function CompareView({ a, b, uiA, uiB, selected, onSelect, onSwap, onCopyAtoB }: Props) {
  const [onlyChanged, setOnlyChanged] = useState(true);
  const d = useMemo(() => diffPipelines(a, b), [a, b]);
  const rows = d.jobs.filter((j) => !onlyChanged || j.changes.length);

  return (
    <div className="cmp">
      <div className="cmp-head">
        <Side name="A" ui={uiA} r={a} />
        <Side name="B" ui={uiB} r={b} />
      </div>
      <div className="cmp-bar">
        <span><b>{d.changed}</b> of {d.jobs.length} jobs differ</span>
        <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> only differences</label>
        <span className="spacer" />
        <button className="btn" onClick={onSwap}>Swap A ↔ B</button>
        <button className="btn" onClick={onCopyAtoB}>Copy A → B</button>
      </div>
      {rows.length === 0 ? <div className="empty">{d.jobs.length ? 'No differences.' : 'No jobs.'}</div> : (
        <table className="cmp-table">
          <thead><tr><th>job</th><th>stage</th><th>A</th><th>B</th><th>differs in</th></tr></thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.name} className={`${j.changes.length ? 'diff' : ''} ${selected === j.name ? 'sel' : ''}`} onClick={() => onSelect(j.name)}>
                <th>{j.name}</th>
                <td className="muted">{j.stage}</td>
                <td><Cell s={j.a} other={j.b} changes={j.changes} /></td>
                <td><Cell s={j.b} other={j.a} changes={j.changes} /></td>
                <td className="small">{j.changes.map((f) => FIELD_LABEL[f]).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Edit A or B in the scenario panel (A/B switch). Click a row for the rule trace of the scenario being edited.</p>
    </div>
  );
}
