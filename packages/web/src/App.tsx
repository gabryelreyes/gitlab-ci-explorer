import { yaml } from '@codemirror/lang-yaml';
import CodeMirror from '@uiw/react-codemirror';
import {
  buildConfig, evaluatePipeline, extractGates, loadCiYaml, makeScenario,
  type InputSpec, type NormalizedConfig, type PresetKind, type PresetOptions, type Scenario,
} from '@gce/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CompareView } from './CompareView';
import { IncludesPanel } from './IncludesPanel';
import { Inspector } from './Inspector';
import { MatrixView } from './MatrixView';
import { NeedsGraph } from './NeedsGraph';
import { PipelineView } from './PipelineView';
import { SAMPLES } from './samples';
import { ScenarioPanel } from './ScenarioPanel';
import { decodeState, encodeState, type AppState } from './urlState';

export interface UiScenario {
  kind: PresetKind;
  opts: PresetOptions;
  userVars: Record<string, string>;
  changed: string;
  files: string;
  /** Pipeline inputs (spec:inputs of the main file), raw text; empty = default. */
  inputs?: Record<string, string>;
}

type Tab = 'stages' | 'graph' | 'matrix' | 'compare' | 'includes';
const TABS: [Tab, string][] = [['stages', 'Stages'], ['graph', 'Needs graph'], ['matrix', 'Matrix'], ['compare', 'Compare A/B'], ['includes', 'Includes']];

const lines = (s: string) => {
  const l = s.split('\n').map((x) => x.trim()).filter(Boolean);
  return l.length ? l : undefined;
};

export function toScenario(u: UiScenario, kind = u.kind, opts: PresetOptions = u.opts): Scenario {
  const inputs = Object.fromEntries(Object.entries(u.inputs ?? {}).filter(([, v]) => v !== ''));
  return { ...makeScenario(kind, opts), userVariables: u.userVars, changedFiles: lines(u.changed), repoFiles: lines(u.files), inputs };
}

export function scenarioLabel(u: UiScenario): string {
  const o = u.opts;
  const base = u.kind === 'tag' ? `tag ${o.tag ?? ''}`
    : u.kind === 'merge_request_event' ? `MR ${o.mrSource ?? ''} → ${o.mrTarget ?? ''}`
      : `${u.kind} ${o.branch ?? ''}${o.openMr ? ' + open MR' : ''}`;
  const vars = Object.entries(u.userVars).map(([k, v]) => `${k}=${v}`);
  return [base.trim(), ...vars].join(' · ');
}

const DEFAULT_UI: UiScenario = {
  kind: 'push', opts: { branch: 'main', defaultBranch: 'main', tag: 'v1.0.0', mrSource: 'feature/x', mrTarget: 'main' },
  userVars: {}, changed: '', files: '',
};
const DEFAULT_UI_B: UiScenario = { ...DEFAULT_UI, kind: 'merge_request_event' };

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

const HASH_KEY = '#s=';

export function App() {
  const [text, setText] = useState(SAMPLES[0]!.text);
  const [ui, setUi] = useState<UiScenario>(DEFAULT_UI);
  const [uiB, setUiB] = useState<UiScenario>(DEFAULT_UI_B);
  const [edit, setEdit] = useState<'A' | 'B'>('A');
  const [tab, setTab] = useState<Tab>('stages');
  const [selected, setSelected] = useState<string | undefined>();
  const [showExcluded, setShowExcluded] = useState(true);
  const [loaded, setLoaded] = useState(!location.hash.startsWith(HASH_KEY));
  const [copied, setCopied] = useState(false);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [pasting, setPasting] = useState<string | undefined>();
  const dark = useDark();

  // URL hash → state (on load and when a different link is pasted into this tab).
  const lastHash = useRef('');
  useEffect(() => {
    const apply = async () => {
      if (!location.hash.startsWith(HASH_KEY) || location.hash === lastHash.current) { setLoaded(true); return; }
      const s = await decodeState(location.hash.slice(HASH_KEY.length));
      if (s) {
        lastHash.current = location.hash;
        setText(s.text); setUi(s.ui); if (s.uiB) setUiB(s.uiB); setFiles(s.files ?? {});
        if (s.tab && TABS.some(([t]) => t === s.tab)) setTab(s.tab as Tab);
        setSelected(s.selected);
      }
      setLoaded(true);
    };
    void apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  // state → URL hash (debounced, no history entries).
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      const s: AppState = { v: 1, text, ui, uiB, tab, selected, files };
      void encodeState(s).then((h) => {
        lastHash.current = HASH_KEY + h;
        history.replaceState(null, '', HASH_KEY + h);
      });
    }, 300);
    return () => clearTimeout(t);
  }, [loaded, text, ui, uiB, tab, selected, files]);

  // Includes, include:rules and pipeline inputs depend on the scenario → one config per scenario.
  const cfgFor = useMemo(() => (sc: Scenario): NormalizedConfig => buildConfig(text, { files, scenario: sc }), [text, files]);
  const inputSpecs = useMemo(() => {
    const spec = loadCiYaml(text).header?.spec as { inputs?: Record<string, InputSpec | null> } | undefined;
    return spec?.inputs && typeof spec.inputs === 'object' ? spec.inputs : undefined;
  }, [text]);
  const scenario = useMemo(() => toScenario(ui), [ui]);
  const scenarioB = useMemo(() => toScenario(uiB), [uiB]);
  const cfg = useMemo(() => cfgFor(scenario), [cfgFor, scenario]);
  const cfgB = useMemo(() => cfgFor(scenarioB), [cfgFor, scenarioB]);
  const gates = useMemo(() => extractGates(cfg), [cfg]);
  const result = useMemo(() => evaluatePipeline(cfg, scenario), [cfg, scenario]);
  const resultB = useMemo(() => evaluatePipeline(cfgB, scenarioB), [cfgB, scenarioB]);
  const editingB = tab === 'compare' && edit === 'B';
  const shown = editingB ? resultB : result;
  const job = shown.jobs.find((j) => j.name === selected);
  const unresolved = shown.includes.filter((i) => !i.resolved && !i.skipped && !i.error);
  const sampleIx = SAMPLES.findIndex((s) => s.text === text);

  const onFile = (f: File | undefined) => { if (f) void f.text().then(setText); };
  const copyLink = async () => {
    const h = HASH_KEY + await encodeState({ v: 1, text, ui, uiB, tab, selected, files });
    history.replaceState(null, '', h);
    await navigator.clipboard?.writeText(location.href).catch(() => undefined);
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };

  if (!loaded) return <div className="empty">Loading…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <strong className="brand">CI Pipeline Explorer</strong>
        <select aria-label="Sample" value={sampleIx < 0 ? 'custom' : String(sampleIx)}
          onChange={(e) => { const s = SAMPLES[Number(e.target.value)]; if (s) { setText(s.text); setFiles(s.files ?? {}); setUi({ ...ui, inputs: {} }); setUiB({ ...uiB, inputs: {} }); } }}>
          {sampleIx < 0 && <option value="custom">— custom config —</option>}
          {SAMPLES.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}
        </select>
        <label className="btn">Open .gitlab-ci.yml…
          <input type="file" accept=".yml,.yaml" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
        <button className="btn" onClick={() => void copyLink()} title="Link contains the config and scenarios (nothing is sent anywhere)">
          {copied ? 'Link copied ✓' : 'Copy link'}
        </button>
        <span className="spacer" />
        <span className={`pill ${shown.created ? 'ok' : 'bad'}`}>
          {editingB ? 'B: ' : ''}{shown.created ? 'Pipeline created' : 'No pipeline'}
        </span>
        <span className="muted reason">{shown.invalidConfig ? 'invalid configuration' : shown.workflow.reason}</span>
      </header>

      {unresolved.length > 0 && (
        <div className="banner" role="status">
          ⚠ <b>Standalone mode</b> — no GitLab access. {unresolved.length} include(s) not provided; jobs and templates
          from them are missing: <code>{unresolved.map((i) => `${i.type}:${i.target}`).join(', ')}</code>
          {tab !== 'includes' && <button className="btn small" onClick={() => setTab('includes')}>Provide files →</button>}
        </div>
      )}

      <main className="panes">
        <section className="pane editor">
          <CodeMirror value={text} onChange={setText} extensions={[yaml()]} theme={dark ? 'dark' : 'light'} height="100%" />
        </section>

        <section className="pane center">
          <nav className="tabs">
            {TABS.map(([t, label]) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {label}{t === 'includes' && shown.includes.length > 0 && <span className={`count ${unresolved.length ? 'bad' : ''}`}>{shown.includes.filter((i) => i.resolved).length}/{shown.includes.length}</span>}
              </button>
            ))}
            <span className="spacer" />
            {tab === 'stages' && (
              <label className="check"><input type="checkbox" checked={showExcluded} onChange={(e) => setShowExcluded(e.target.checked)} /> show excluded</label>
            )}
          </nav>
          {tab === 'stages' && <PipelineView result={result} selected={selected} onSelect={setSelected} showExcluded={showExcluded} />}
          {tab === 'graph' && <NeedsGraph result={result} selected={selected} onSelect={setSelected} dark={dark} />}
          {tab === 'includes' && <IncludesPanel includes={shown.includes} files={files} setFiles={setFiles} onPasteMerged={() => setPasting('')} />}
          {tab === 'matrix' && <MatrixView cfgFor={cfgFor} ui={ui} onPick={(kind, opts, name) => { setUi({ ...ui, kind, opts }); setSelected(name); setTab('stages'); }} />}
          {tab === 'compare' && (
            <CompareView
              a={result} b={resultB} uiA={ui} uiB={uiB} selected={selected} onSelect={setSelected}
              onSwap={() => { setUi(uiB); setUiB(ui); }} onCopyAtoB={() => setUiB(ui)}
            />
          )}
          {(shown.errors.length > 0 || shown.warnings.length > 0) && (
            <div className="messages">
              {shown.errors.map((e, i) => <pre key={`e${i}`} className="msg err">✗ {e}</pre>)}
              {shown.warnings.map((w, i) => <pre key={`w${i}`} className="msg warn">! {w}</pre>)}
            </div>
          )}
        </section>

        <aside className="pane side">
          {tab === 'compare' && (
            <nav className="tabs ab">
              <span className="muted small">Edit scenario</span>
              <button className={edit === 'A' ? 'active' : ''} onClick={() => setEdit('A')}>A</button>
              <button className={edit === 'B' ? 'active' : ''} onClick={() => setEdit('B')}>B</button>
            </nav>
          )}
          {editingB
            ? <ScenarioPanel ui={uiB} setUi={setUiB} gates={gates} scenario={scenarioB} inputSpecs={inputSpecs} />
            : <ScenarioPanel ui={ui} setUi={setUi} gates={gates} scenario={scenario} inputSpecs={inputSpecs} />}
          <Inspector job={job} workflow={shown.workflow} />
        </aside>
      </main>

      {pasting !== undefined && (
        <div className="dialog" role="dialog" aria-label="Paste merged configuration">
          <div>
            <b>Paste the full merged configuration</b>
            <span className="small muted">GitLab → Build → Pipeline editor → <i>Full configuration</i> tab. It already contains every include.</span>
            <textarea value={pasting} onChange={(e) => setPasting(e.target.value)} autoFocus />
            <div className="row">
              <button className="btn" disabled={!pasting.trim()} onClick={() => { setText(pasting); setPasting(undefined); setTab('stages'); }}>Replace editor content</button>
              <button className="btn" onClick={() => setPasting(undefined)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
