import { yaml } from '@codemirror/lang-yaml';
import CodeMirror from '@uiw/react-codemirror';
import {
  evaluatePipeline, extractGates, loadCiYaml, makeScenario, normalizeConfig,
  type PresetKind, type PresetOptions, type Scenario,
} from '@gce/core';
import { useEffect, useMemo, useState } from 'react';
import { Inspector } from './Inspector';
import { MatrixView } from './MatrixView';
import { NeedsGraph } from './NeedsGraph';
import { PipelineView } from './PipelineView';
import { SAMPLES } from './samples';
import { ScenarioPanel } from './ScenarioPanel';

export interface UiScenario {
  kind: PresetKind;
  opts: PresetOptions;
  userVars: Record<string, string>;
  changed: string;
  files: string;
}

const lines = (s: string) => {
  const l = s.split('\n').map((x) => x.trim()).filter(Boolean);
  return l.length ? l : undefined;
};

export function toScenario(u: UiScenario, kind = u.kind, opts: PresetOptions = u.opts): Scenario {
  return { ...makeScenario(kind, opts), userVariables: u.userVars, changedFiles: lines(u.changed), repoFiles: lines(u.files) };
}

function useDark(): boolean {
  const q = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined;
  const [dark, setDark] = useState(q?.matches ?? false);
  useEffect(() => {
    if (!q) return;
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, [q]);
  return dark;
}

export function App() {
  const [text, setText] = useState(SAMPLES[0]!.text);
  const [ui, setUi] = useState<UiScenario>({
    kind: 'push', opts: { branch: 'main', defaultBranch: 'main', tag: 'v1.0.0', mrSource: 'feature/x', mrTarget: 'main' },
    userVars: {}, changed: '', files: '',
  });
  const [tab, setTab] = useState<'stages' | 'graph' | 'matrix'>('stages');
  const [selected, setSelected] = useState<string | undefined>();
  const [showExcluded, setShowExcluded] = useState(true);
  const dark = useDark();

  const cfg = useMemo(() => normalizeConfig(loadCiYaml(text)), [text]);
  const gates = useMemo(() => extractGates(cfg), [cfg]);
  const scenario = useMemo(() => toScenario(ui), [ui]);
  const result = useMemo(() => evaluatePipeline(cfg, scenario), [cfg, scenario]);
  const job = result.jobs.find((j) => j.name === selected);
  const unresolved = result.includes.filter((i) => !i.resolved);

  const onFile = (f: File | undefined) => { if (f) void f.text().then(setText); };

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">CI Pipeline Explorer</strong>
        <select aria-label="Sample" onChange={(e) => { const s = SAMPLES[Number(e.target.value)]; if (s) setText(s.text); }} defaultValue="0">
          {SAMPLES.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
        </select>
        <label className="btn">Open .gitlab-ci.yml…
          <input type="file" accept=".yml,.yaml" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <span className="spacer" />
        <span className={`pill ${result.created ? 'ok' : 'bad'}`}>
          {result.created ? 'Pipeline created' : 'No pipeline'}
        </span>
        <span className="muted reason">{result.invalidConfig ? 'invalid configuration' : result.workflow.reason}</span>
      </header>

      {unresolved.length > 0 && (
        <div className="banner" role="status">
          ⚠ <b>Standalone mode</b> — no GitLab access. {unresolved.length} include(s) not resolved; jobs and templates
          from them are missing: <code>{unresolved.map((i) => `${i.type}:${i.target}`).join(', ')}</code>
        </div>
      )}

      <main className="panes">
        <section className="pane editor">
          <CodeMirror value={text} onChange={setText} extensions={[yaml()]} theme={dark ? 'dark' : 'light'} height="100%" />
        </section>

        <section className="pane center">
          <nav className="tabs">
            <button className={tab === 'stages' ? 'active' : ''} onClick={() => setTab('stages')}>Stages</button>
            <button className={tab === 'graph' ? 'active' : ''} onClick={() => setTab('graph')}>Needs graph</button>
            <button className={tab === 'matrix' ? 'active' : ''} onClick={() => setTab('matrix')}>Matrix (jobs × pipeline types)</button>
            <span className="spacer" />
            {tab === 'stages' && (
              <label className="check"><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> show excluded</label>
            )}
          </nav>
          {tab === 'stages' && <PipelineView result={result} selected={selected} onSelect={setSelected} showExcluded={showExcluded} />}
          {tab === 'graph' && <NeedsGraph result={result} selected={selected} onSelect={setSelected} dark={dark} />}
          {tab === 'matrix' && <MatrixView cfg={cfg} ui={ui} onPick={(kind, opts, name) => { setUi({ ...ui, kind, opts }); setSelected(name); setTab('stages'); }} />}
          {(result.errors.length > 0 || result.warnings.length > 0) && (
            <div className="messages">
              {result.errors.map((e, i) => <pre key={`e${i}`} className="msg err">✗ {e}</pre>)}
              {result.warnings.map((w, i) => <pre key={`w${i}`} className="msg warn">! {w}</pre>)}
            </div>
          )}
        </section>

        <aside className="pane side">
          <ScenarioPanel ui={ui} setUi={setUi} gates={gates} scenario={scenario} />
          <Inspector job={job} workflow={result.workflow} />
        </aside>
      </main>
    </div>
  );
}
