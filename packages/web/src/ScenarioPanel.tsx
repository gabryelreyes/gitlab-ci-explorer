import { PRESET_KINDS, type Gate, type PresetKind, type Scenario } from '@gce/core';
import type { UiScenario } from './App';

const KIND_LABEL: Record<PresetKind, string> = {
  push: 'Branch push', tag: 'Tag push', merge_request_event: 'Merge request', schedule: 'Schedule', web: 'Web (Run pipeline)',
  api: 'API', trigger: 'Trigger token', pipeline: 'Multi-project', parent_pipeline: 'Child pipeline', chat: 'ChatOps', external: 'External CI',
};

interface Props { ui: UiScenario; setUi: (u: UiScenario) => void; gates: Gate[]; scenario: Scenario }

export function ScenarioPanel({ ui, setUi, gates, scenario }: Props) {
  const o = ui.opts;
  const setOpt = (k: keyof typeof o, v: unknown) => setUi({ ...ui, opts: { ...o, [k]: v } });
  const setVar = (name: string, value: string | undefined) => {
    const next = { ...ui.userVars };
    if (value === undefined) delete next[name]; else next[name] = value;
    setUi({ ...ui, userVars: next });
  };
  const isMr = ui.kind === 'merge_request_event';
  const isTag = ui.kind === 'tag';

  const gateRow = (g: Gate) => {
    const override = ui.userVars[g.name];
    const effective = override ?? scenario.variables[g.name] ?? g.yamlValue;
    return (
      <div key={g.name} className="gate">
        <div className="gate-head">
          <code>${g.name}</code>
          <span className={`val ${effective === undefined ? 'unset' : ''}`}>{effective === undefined ? 'unset' : JSON.stringify(effective)}</span>
        </div>
        <div className="chips">
          {g.values.map((v) => (
            <button key={v} className={`chip ${override === v ? 'on' : ''}`} onClick={() => setVar(g.name, v)}>{JSON.stringify(v)}</button>
          ))}
          {g.patterns.map((p) => <span key={p} className="chip pattern" title="compared with =~ / !~">{p}</span>)}
          {g.comparedWith.map((v) => <span key={v} className="chip pattern">== ${v}</span>)}
          <input
            className="chip-input" placeholder="value…" value={override ?? ''}
            onChange={(e) => setVar(g.name, e.target.value === '' ? undefined : e.target.value)}
          />
          {override !== undefined && <button className="chip clear" onClick={() => setVar(g.name, undefined)}>reset</button>}
        </div>
        <div className="muted small">used by {g.usedBy.join(', ')}</div>
      </div>
    );
  };

  const custom = gates.filter((g) => !g.predefined);
  const predefined = gates.filter((g) => g.predefined);

  return (
    <div className="panel">
      <h2>Scenario</h2>
      <label>Pipeline type
        <select value={ui.kind} onChange={(e) => setUi({ ...ui, kind: e.target.value as PresetKind })}>
          {PRESET_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      <div className="grid2">
        {isMr ? (
          <>
            <label>Source branch<input value={o.mrSource ?? ''} onChange={(e) => setOpt('mrSource', e.target.value)} /></label>
            <label>Target branch<input value={o.mrTarget ?? ''} onChange={(e) => setOpt('mrTarget', e.target.value)} /></label>
          </>
        ) : isTag ? (
          <label>Tag<input value={o.tag ?? ''} onChange={(e) => setOpt('tag', e.target.value)} /></label>
        ) : (
          <label>Branch<input value={o.branch ?? ''} onChange={(e) => setOpt('branch', e.target.value)} /></label>
        )}
        <label>Default branch<input value={o.defaultBranch ?? ''} onChange={(e) => setOpt('defaultBranch', e.target.value)} /></label>
      </div>
      <div className="row">
        {ui.kind === 'push' && (
          <label className="check"><input type="checkbox" checked={!!o.openMr} onChange={(e) => setOpt('openMr', e.target.checked)} /> open MR for branch</label>
        )}
        <label className="check"><input type="checkbox" checked={!!o.protected} onChange={(e) => setOpt('protected', e.target.checked || undefined)} /> protected ref</label>
        {ui.kind === 'push' && (
          <label className="check"><input type="checkbox" checked={!!o.newBranch} onChange={(e) => setOpt('newBranch', e.target.checked)} /> new branch</label>
        )}
      </div>

      <h3>Gate variables <span className="muted small">(project / pipeline variables override YAML)</span></h3>
      {custom.length === 0 && <p className="muted small">No custom variables used in rules.</p>}
      {custom.map(gateRow)}
      {predefined.length > 0 && (
        <details>
          <summary>Predefined variables used in rules ({predefined.length})</summary>
          {predefined.map(gateRow)}
        </details>
      )}

      <h3>changes: / exists:</h3>
      <label>Changed files <span className="muted small">(one per line; empty = assume changed)</span>
        <textarea rows={3} value={ui.changed} onChange={(e) => setUi({ ...ui, changed: e.target.value })} placeholder="src/main.c" />
      </label>
      <label>Repository files <span className="muted small">(empty = assume exists)</span>
        <textarea rows={2} value={ui.files} onChange={(e) => setUi({ ...ui, files: e.target.value })} placeholder="Cargo.toml" />
      </label>
    </div>
  );
}
