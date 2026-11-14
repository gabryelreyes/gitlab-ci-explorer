// CLI harness (node only). `gce <file.yml> [options]` — see USAGE.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { evaluatePipeline, type ClauseTrace, type JobResult, type PipelineResult, type RuleTrace } from './evaluate/index.js';
import { extractGates } from './gates.js';
import type { NormalizedConfig } from './model.js';
import { normalizeConfig } from './normalize/index.js';
import { makeScenario, PRESET_KINDS, type PresetKind, type PresetOptions, type Scenario } from './scenario/presets.js';
import { loadCiYaml } from './yaml/load.js';

const USAGE = `usage: gce <.gitlab-ci.yml> [options]
  -p, --preset <kind>     ${PRESET_KINDS.join('|')} (alias: mr)   [push]
  -b, --branch <name>     branch (push/schedule/web/...)              [default branch]
  -t, --tag <name>        tag name
      --default-branch    CI_DEFAULT_BRANCH                           [main]
      --mr-source/--mr-target <branch>, --mr-labels a,b
      --open-mr           branch has an open MR (CI_OPEN_MERGE_REQUESTS)
      --protected / --new-branch
  -s, --set KEY=VALUE     project/pipeline variable (repeatable)
      --changed a,b       changed files for changes: (default: assume changed)
      --files a,b         repo files for exists: (default: assume exist)
      --override ID=bool  force a clause, e.g. unit-tests#2.changes=false
      --trace             show rule traces
      --gates             list gate variables
      --matrix            jobs × presets overview
      --json              machine-readable output`;

export interface CliResult { code: number; out: string }

const list = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const kv = (arr: string[] | undefined, what: string) => Object.fromEntries((arr ?? []).map((s) => {
  const i = s.indexOf('=');
  if (i <= 0) throw new Error(`${what}: expected KEY=VALUE, got "${s}"`);
  return [s.slice(0, i), s.slice(i + 1)];
}));

export function runCli(argv: string[]): CliResult {
  let a;
  try {
    a = parseArgs({
      args: argv, allowPositionals: true,
      options: {
        preset: { type: 'string', short: 'p', default: 'push' },
        branch: { type: 'string', short: 'b' }, tag: { type: 'string', short: 't' },
        'default-branch': { type: 'string' }, 'mr-source': { type: 'string' }, 'mr-target': { type: 'string' },
        'mr-labels': { type: 'string' }, 'open-mr': { type: 'boolean' }, protected: { type: 'boolean' },
        'new-branch': { type: 'boolean' }, set: { type: 'string', short: 's', multiple: true },
        changed: { type: 'string' }, files: { type: 'string' }, override: { type: 'string', multiple: true },
        trace: { type: 'boolean' }, gates: { type: 'boolean' }, matrix: { type: 'boolean' }, json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    return { code: 2, out: `${(e as Error).message}\n${USAGE}` };
  }
  const { values: o, positionals } = a;
  if (o.help) return { code: 0, out: USAGE };
  if (positionals.length !== 1) return { code: 2, out: USAGE };

  let text: string;
  try { text = readFileSync(positionals[0]!, 'utf8'); } catch (e) { return { code: 2, out: (e as Error).message }; }
  const cfg = normalizeConfig(loadCiYaml(text, positionals[0]));

  const kind = (o.preset === 'mr' ? 'merge_request_event' : o.preset) as PresetKind;
  if (!PRESET_KINDS.includes(kind)) return { code: 2, out: `unknown preset ${o.preset}\n${USAGE}` };
  const opts: PresetOptions = {
    branch: o.branch, tag: o.tag, defaultBranch: o['default-branch'], mrSource: o['mr-source'], mrTarget: o['mr-target'],
    mrLabels: list(o['mr-labels']), openMr: o['open-mr'], protected: o.protected, newBranch: o['new-branch'],
  };
  let scenario: Scenario;
  try {
    scenario = {
      ...makeScenario(kind, opts),
      userVariables: kv(o.set, '--set'),
      changedFiles: list(o.changed),
      repoFiles: list(o.files),
      overrides: Object.fromEntries(Object.entries(kv(o.override, '--override')).map(([k, v]) => [k, v === 'true'])),
    };
  } catch (e) {
    return { code: 2, out: (e as Error).message };
  }

  if (o.gates) return { code: 0, out: renderGates(cfg) };
  if (o.matrix) return { code: 0, out: renderMatrix(cfg, opts, scenario) };
  const result = evaluatePipeline(cfg, scenario);
  if (o.json) return { code: 0, out: JSON.stringify({ scenario, result }, null, 2) };
  return { code: 0, out: renderResult(result, scenario, !!o.trace) };
}

// ---------------------------------------------------------------------------- rendering

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

function table(rows: string[][]): string {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : pad(c, w[i]!))).join('  ').trimEnd()).join('\n');
}

function sortJobs(jobs: JobResult[], stages: string[]): JobResult[] {
  return [...jobs].sort((x, y) => stages.indexOf(x.stage) - stages.indexOf(y.stage));
}

function notes(j: JobResult): string {
  if (!j.included) return `excluded: ${j.reason}`;
  const n: string[] = [];
  if (j.blocking) n.push('blocking');
  else if (j.allowFailure) n.push('allow_failure');
  if (j.startIn) n.push(`start_in ${j.startIn}`);
  if (j.needs) n.push(j.needs.length ? `needs ${j.needs.map((x) => x.job).join(',')}` : 'needs []');
  if (j.trigger) n.push(`trigger ${j.trigger.kind}${j.trigger.dynamic ? ' (dynamic)' : ''}`);
  n.push(j.reason);
  return n.join(' · ');
}

const mark = (r: RuleTrace) => (!r.evaluated ? '·' : r.matched ? '✓' : '✗');
const clause = (c: ClauseTrace) =>
  `${c.kind} ${c.source}${c.expanded && c.expanded !== c.source ? `  ⇒ ${c.expanded}` : ''} = ${c.result}` +
  `${c.note ? `  (${c.note})` : ''}${c.error ? `  [error: ${c.error}]` : ''}${c.warnings?.length ? `  [warn: ${c.warnings.join('; ')}]` : ''}`;

function ruleLines(rules: RuleTrace[], indent: string): string[] {
  return rules.map((r) => {
    const body = r.evaluated && r.clauses.length ? r.clauses.map(clause).join(' AND ') : r.text;
    return `${indent}#${r.index} ${mark(r)} ${body}${r.when ? `  → ${r.when}` : ''}`.trimEnd();
  });
}

function renderResult(r: PipelineResult, sc: Scenario, trace: boolean): string {
  const out: string[] = [];
  const ref = sc.refType === 'mr' ? `MR ${sc.ref} → ${sc.variables.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}` : `${sc.refType} ${sc.ref}`;
  const unresolved = r.includes.filter((i) => !i.resolved);
  if (unresolved.length) {
    out.push(`⚠ standalone mode: no GitLab access — ${unresolved.length} include(s) not resolved, results may miss jobs`);
  }
  const reason = r.invalidConfig ? 'invalid configuration' : r.workflow.reason;
  out.push(`Pipeline: ${r.created ? 'CREATED' : 'NOT CREATED'} — ${reason}   [${sc.source} · ${ref}]`);
  if (r.workflow.name) out.push(`Name: ${r.workflow.name}`);
  if (trace && r.workflow.rules.length) out.push('workflow:', ...ruleLines(r.workflow.rules, '  '));
  out.push('');
  const rows = [['STAGE', 'JOB', 'WHEN', 'NOTES']];
  for (const j of sortJobs(r.jobs, r.stages)) rows.push([j.stage, j.name, j.included ? j.when : '—', notes(j)]);
  out.push(table(rows));
  if (trace) {
    out.push('', 'Trace:');
    for (const j of sortJobs(r.jobs, r.stages)) {
      out.push(`  ${j.name}`);
      if (j.trace.mode === 'rules') out.push(...ruleLines(j.trace.rules, '    '));
      else {
        for (const c of j.trace.only ?? []) out.push(`    only${j.trace.defaultOnly ? ' (default)' : ''}: ${clause(c)}`);
        for (const c of j.trace.except ?? []) out.push(`    except: ${clause(c)}`);
      }
    }
  }
  if (r.errors.length) out.push('', 'Errors:', ...r.errors.map((e) => `  ✗ ${e}`));
  if (r.warnings.length) out.push('', 'Warnings:', ...r.warnings.map((w) => `  ! ${w}`));
  return out.join('\n');
}

function renderGates(cfg: NormalizedConfig): string {
  const rows = [['VARIABLE', 'KIND', 'YAML', 'COMPARED WITH', 'USED BY']];
  for (const g of extractGates(cfg)) {
    const cmp = [...g.values.map((v) => JSON.stringify(v)), ...g.patterns, ...g.comparedWith.map((v) => `$${v}`), ...(g.nullCompared ? ['null'] : []), ...(g.truthiness ? ['(set?)'] : [])];
    rows.push([g.name, g.predefined ? 'predef' : 'custom', g.yamlValue ?? '', cmp.join(' '), g.usedBy.join(', ')]);
  }
  return table(rows);
}

const CELL: Record<string, string> = { on_success: '●', manual: 'M', delayed: 'D', always: 'A', on_failure: 'F' };

function renderMatrix(cfg: NormalizedConfig, o: PresetOptions, base: Scenario): string {
  const def = o.defaultBranch ?? 'main';
  const cols: [string, Scenario][] = [
    [`push:${def}`, makeScenario('push', { ...o, branch: def })],
    ['push:feature', makeScenario('push', { ...o, branch: o.branch && o.branch !== def ? o.branch : 'feature/x' })],
    ['mr', makeScenario('merge_request_event', { ...o, mrSource: o.mrSource ?? 'feature/x' })],
    ['tag', makeScenario('tag', { ...o, tag: o.tag ?? 'v1.0.0' })],
    ['schedule', makeScenario('schedule', { ...o, branch: def })],
    ['web', makeScenario('web', { ...o, branch: def })],
  ];
  const results = cols.map(([, sc]) => evaluatePipeline(cfg, { ...sc, userVariables: base.userVariables, changedFiles: base.changedFiles, repoFiles: base.repoFiles, overrides: base.overrides }));
  const rows = [['JOB', ...cols.map(([n], i) => `${n}${results[i]!.created ? '' : '✗'}`)]];
  const order = sortJobs(results[0]!.jobs, cfg.stages).map((j) => j.name);
  for (const name of order) {
    rows.push([name, ...results.map((r) => {
      const j = r.jobs.find((x) => x.name === name)!;
      return j.included ? (CELL[j.when] ?? '?') + (j.blocking ? '!' : '') : '·';
    })]);
  }
  return `${table(rows)}\n\n● on_success  M manual (M! blocking)  D delayed  A always  F on_failure  · excluded  ✗ pipeline not created`;
}
