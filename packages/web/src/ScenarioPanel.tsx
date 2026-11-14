import { PRESET_KINDS, type Gate, type InputSpec, type PresetKind, type Scenario } from '@gce/core';
import type { UiScenario } from './App';

const KIND_LABEL: Record<PresetKind, string> = {
  push: 'Branch push', tag: 'Tag push', merge_request_event: 'Merge request', schedule: 'Schedule', web: 'Web (Run pipeline)',
  api: 'API', trigger: 'Trigger token', pipeline: 'Multi-project', parent_pipeline: 'Child pipeline', chat: 'ChatOps', external: 'External CI',
};

interface Props { ui: UiScenario; setUi: (u: UiScenario) => void; gates: Gate[]; scenario: Scenario; inputSpecs?: Record<string, InputSpec | null> }

export function ScenarioPanel({ ui, setUi, gates, scenario, inputSpecs }: Props) {
  const o = ui.opts;
  const setOpt = (k: keyof typeof o, v: unknown) => setUi({ ...ui, opts: { ...o, [k]: v } });
  const setVar = (name: string, value: string | undefined) => {
    const next = { ...ui.userVars };
    if (value === undefined) delete next[name]; else next[name] = value;
    setUi({ ...ui, userVars: next });
  };
  const isMr = ui.kind === 'merge_request_event';
  const isTag = ui.kind === 'tag';
  // Effective protection; an explicit choice is kept only while it differs from GitLab's default for the ref.
  const isProtected = scenario.variables.CI_COMMIT_REF_PROTECTED === 'true';
  const defaultProtected = scenario.refType === 'branch' && scenario.ref === scenario.variables.CI_DEFAULT_BRANCH;

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

  const setInput = (name: string, v: string) => setUi({ ...ui, inputs: { ...ui.inputs, [name]: v } });
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const inputRow = ([name, spec]: [string, InputSpec | null]) => {
    const s = spec ?? {};
    const type = s.type ?? 'string';
    const v = ui.inputs?.[name] ?? '';
    const def = s.default === undefined ? undefined : show(s.default);
    const opts = type === 'boolean' ? ['true', 'false'] : Array.isArray(s.options) && type !== 'array' ? s.options.map(show) : undefined;
    return (
      <label key={name} title={s.description}>
        <span><code>{name}</code> <span className="small muted">{type}{def === undefined ? ' · required' : ''}{s.regex ? ` · /${s.regex}/` : ''}</span></span>
        {opts ? (
          <select value={v} onChange={(e) => setInput(name, e.target.value)}>
            <option value="">{def === undefined ? '— not set —' : `default (${def})`}</option>
            {opts.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input value={v} placeholder={def === undefined ? 'required' : `default: ${def}`} onChange={(e) => setInput(name, e.target.value)} />
        )}
      </label>
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
        <label className="check"><input type="checkbox" checked={isProtected} onChange={(e) => setOpt('protected', e.target.checked === defaultProtected ? undefined : e.target.checked)} /> protected ref</label>
        {ui.kind === 'push' && (
          <label className="check"><input type="checkbox" checked={!!o.newBranch} onChange={(e) => setOpt('newBranch', e.target.checked)} /> new branch</label>
        )}
      </div>

      {inputSpecs && Object.keys(inputSpecs).length > 0 && (
        <>
          <h3>Pipeline inputs <span className="muted small">(spec:inputs; arrays as JSON)</span></h3>
          <div className="inputs-grid">{Object.entries(inputSpecs).map(inputRow)}</div>
        </>
      )}

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
