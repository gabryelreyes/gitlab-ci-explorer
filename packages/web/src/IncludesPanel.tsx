import type { IncludeRef } from '@gce/core';
import { useState } from 'react';

interface Props {
  includes: IncludeRef[];
  files: Record<string, string>;
  setFiles: (f: Record<string, string>) => void;
  onPasteMerged: () => void;
}

const readAll = (list: FileList | null) =>
  Promise.all([...(list ?? [])].map(async (f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, text: await f.text() })));

/** Best match of an uploaded path to an unresolved local/project include (longest path suffix). */
function matchKey(path: string, open: IncludeRef[]): string | undefined {
  const p = path.replace(/^\/+/, '');
  let best: IncludeRef | undefined;
  for (const i of open) {
    const t = i.file.replace(/^\/+/, '');
    if (t === p || t.endsWith(`/${p}`) || p.endsWith(`/${t}`)) if (!best || t.length > best.file.length) best = i;
  }
  return best?.key;
}

function Row({ inc, files, setFiles }: { inc: IncludeRef; files: Record<string, string>; setFiles: Props['setFiles'] }) {
  const [paste, setPaste] = useState(false);
  const [draft, setDraft] = useState('');
  const set = (text: string | undefined) => {
    const next = { ...files };
    if (text === undefined) delete next[inc.key]; else next[inc.key] = text;
    setFiles(next);
  };
  const status = inc.skipped ? 'skip' : inc.resolved ? 'ok' : 'missing';
  return (
    <li className={`inc ${status}`}>
      <div className="inc-head">
        <span className="mark">{status === 'ok' ? '✓' : status === 'skip' ? '–' : '✗'}</span>
        <code className="inc-target">{inc.type}: {inc.target}</code>
        {inc.from !== 'main' && <span className="muted small">from {inc.from}</span>}
        <span className="spacer" />
        {inc.wildcard ? <span className="muted small">wildcard — upload the matching files</span> : !inc.skipped && (
          <>
            <label className="btn small">{inc.resolved ? 'Replace…' : 'Attach…'}
              <input type="file" hidden onChange={(e) => void readAll(e.target.files).then((f) => f[0] && set(f[0].text))} />
            </label>
            <button className="btn small" onClick={() => setPaste(!paste)}>Paste</button>
            {files[inc.key] !== undefined && <button className="btn small" onClick={() => set(undefined)}>Remove</button>}
          </>
        )}
      </div>
      {inc.skipped && <div className="small muted">{inc.skipped}</div>}
      {inc.error && <div className="small note err">{inc.error}</div>}
      {inc.inputs && <div className="small muted">inputs: <code>{JSON.stringify(inc.inputs)}</code></div>}
      {paste && (
        <div className="inc-paste">
          <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`content of ${inc.file}`} />
          <button className="btn small" onClick={() => { set(draft); setPaste(false); setDraft(''); }}>Use</button>
        </div>
      )}
    </li>
  );
}

export function IncludesPanel({ includes, files, setFiles, onPasteMerged }: Props) {
  const open = includes.filter((i) => !i.resolved && !i.skipped);
  const known = new Set(includes.map((i) => i.key));
  const orphans = Object.keys(files).filter((k) => !known.has(k));
  const [note, setNote] = useState('');

  const upload = async (list: FileList | null) => {
    const got = await readAll(list);
    const next = { ...files };
    const unmatched: string[] = [];
    for (const f of got) {
      const key = matchKey(f.path, open) ?? `local:${f.path.replace(/^\/+/, '')}`;
      if (!matchKey(f.path, open)) unmatched.push(f.path);
      next[key] = f.text;
    }
    setFiles(next);
    setNote(unmatched.length ? `Stored as local files (no include matched yet): ${unmatched.join(', ')}` : `${got.length} file(s) attached.`);
  };

  return (
    <div className="incs">
      <p className="small">
        No GitLab access: provide included files manually, or paste the <b>full merged configuration</b>{' '}
        (pipeline editor → <i>Full configuration</i>) into the editor. Files are matched by path; nothing leaves the browser.
      </p>
      <div className="row">
        <label className="btn">Upload files…<input type="file" multiple hidden onChange={(e) => void upload(e.target.files)} /></label>
        <label className="btn">Upload folder…<input type="file" hidden onChange={(e) => void upload(e.target.files)} {...{ webkitdirectory: '' }} /></label>
        <button className="btn" onClick={onPasteMerged}>Paste merged config…</button>
      </div>
      {note && <p className="small muted">{note}</p>}
      {includes.length === 0 ? <p className="muted">This configuration has no <code>include:</code>.</p> : (
        <ul className="inc-list">
          {includes.map((i) => <Row key={`${i.from}|${i.key}`} inc={i} files={files} setFiles={setFiles} />)}
        </ul>
      )}
      {orphans.length > 0 && (
        <details>
          <summary className="small">Uploaded but unused ({orphans.length})</summary>
          <ul className="small">
            {orphans.map((k) => (
              <li key={k}><code>{k}</code> <button className="chip clear" onClick={() => { const n = { ...files }; delete n[k]; setFiles(n); }}>remove</button></li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
