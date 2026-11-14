import type { ClauseTrace, JobResult, RuleTrace, WorkflowResult } from '@gce/core';

function Clause({ c }: { c: ClauseTrace }) {
  return (
    <div className={`clause ${c.result ? 'yes' : 'no'}`}>
      <span className="kind">{c.kind}</span> <code>{c.source}</code>
      {c.expanded && c.expanded !== c.source && <div className="expanded">⇒ <code>{c.expanded}</code></div>}
      <span className="res">{String(c.result)}</span>
      {c.note && <div className="note">{c.note}</div>}
      {c.error && <div className="note err">{c.error}</div>}
      {c.warnings?.map((w) => <div key={w} className="note warn">{w}</div>)}
    </div>
  );
}

function Rules({ rules }: { rules: RuleTrace[] }) {
  return (
    <ol className="rules" start={0}>
      {rules.map((r) => (
        <li key={r.index} className={!r.evaluated ? 'skipped' : r.matched ? 'matched' : 'failed'}>
          <span className="mark">{!r.evaluated ? '·' : r.matched ? '✓' : '✗'}</span>
          {r.evaluated && r.clauses.length ? r.clauses.map((c, i) => <Clause key={i} c={c} />) : <code className="muted">{r.text}</code>}
          {r.when && <span className="badge soft">when: {r.when}</span>}
        </li>
      ))}
    </ol>
  );
}

function Vars({ title, vars, open = false }: { title: string; vars: [string, string][]; open?: boolean }) {
  if (!vars.length) return null;
  return (
    <details open={open}>
      <summary>{title} ({vars.length})</summary>
      <table className="vars"><tbody>
        {vars.map(([k, v]) => <tr key={k}><td><code>{k}</code></td><td><code>{v}</code></td></tr>)}
      </tbody></table>
    </details>
  );
}

function Extra({ job }: { job: JobResult }) {
  const p = job.parallel;
  const d = job.downstream;
  const fwd = job.trigger?.forward;
  return (
    <>
      {p && (
        <p className="small">
          parallel instance <b>{p.instance}/{p.total}</b> of <code>{p.group}</code>
          {p.matrix && <> · matrix {Object.entries(p.matrix).map(([k, v]) => <code key={k}> {k}={v}</code>)}</>}
        </p>
      )}
      {job.trigger?.kind === 'child' && (
        <div className="small">
          <b>Child pipeline</b>{' '}
          {d?.error ? <span className="note err">{d.error}</span>
            : d?.result ? <span>{d.result.created ? 'created' : 'not created'} — {d.result.invalidConfig ? 'invalid configuration' : d.result.workflow.reason}</span>
              : <span className="muted">evaluated only when this job runs</span>}
          {job.yamlVariables && (
            <Vars
              title={fwd?.yaml_variables === false ? 'YAML variables (not forwarded)' : 'Forwarded YAML variables'}
              vars={Object.entries(job.yamlVariables)}
            />
          )}
          {fwd?.pipeline_variables && <p className="muted">pipeline variables forwarded too (forward:pipeline_variables)</p>}
        </div>
      )}
      {job.trigger?.kind === 'multi-project' && <p className="small muted">Multi-project trigger ({job.trigger.project}) — other projects are not evaluated.</p>}
    </>
  );
}

export function Inspector({ job, path, workflow }: { job?: JobResult; path?: string; workflow: WorkflowResult }) {
  const customVars = job ? Object.entries(job.variables).filter(([k]) => !/^(CI|GITLAB_CI)$|^CI_/.test(k)) : [];
  return (
    <div className="panel">
      <h2>Why?</h2>
      <details open={!job}>
        <summary>workflow:rules — {workflow.reason}</summary>
        {workflow.rules.length ? <Rules rules={workflow.rules} /> : <p className="muted small">No workflow:rules — every pipeline type creates a pipeline.</p>}
        {workflow.name && <p className="small">name: <code>{workflow.name}</code></p>}
      </details>
      {!job && <p className="muted">Click a job to see its rule trace.</p>}
      {job && (
        <>
          <h3>{job.name} <span className={`badge ${job.included ? '' : 'soft'}`}>{job.included ? job.when : 'excluded'}</span></h3>
          {path && path !== job.name && <p className="small muted">in child pipeline: {path}</p>}
          <p className="small">{job.reason}{job.blocking ? ' · blocking manual job' : ''}</p>
          <Extra job={job} />
          {job.trace.mode === 'rules' ? <Rules rules={job.trace.rules} /> : (
            <div>
              {job.trace.only?.length === 0 && job.trace.except?.length === 0 && <p className="small muted">No rules, no only/except.</p>}
              {job.trace.only?.map((c, i) => <div key={`o${i}`}><b className="small">only{job.trace.defaultOnly ? ' (default)' : ''}</b><Clause c={c} /></div>)}
              {job.trace.except?.map((c, i) => <div key={`x${i}`}><b className="small">except</b><Clause c={c} /></div>)}
            </div>
          )}
          <Vars title="Variables" vars={customVars} />
        </>
      )}
    </div>
  );
}
