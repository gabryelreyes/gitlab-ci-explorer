// include: resolution without GitLab access — files come from a user-provided store.
// Mirrors Gitlab::Ci::Config::External::{Processor,Mapper,Verifier}: per level the included files are
// deep-merged in order, then the including file on top; nested includes are merged into their file first.
import { evaluateRules, scopeOf } from '../evaluate/index.js';
import type { IncludeRef, IncludeType, PathsClause, Rule, When } from '../model.js';
import type { Scenario } from '../scenario/presets.js';
import { deepMerge, isPlainObject } from '../util/merge.js';
import { loadCiYaml, type LoadedYaml } from '../yaml/load.js';
import { interpolateFile } from './interpolate.js';

export const MAIN_FILE = '.gitlab-ci.yml';
const MAX_INCLUDES = 150;
const SUBKEYS = ['local', 'project', 'remote', 'template', 'artifact', 'component'] as const;
const RULE_KEYS = new Set(['if', 'exists', 'when', 'changes']);
const URL_RE = /^(https?|ssh|git):\/\/[^\s/]+/i;

export interface ResolveOptions {
  /** key → file content (see IncludeRef.key). */
  files?: Record<string, string>;
  /** Pipeline scenario: variables for include paths/rules, pipeline inputs, changed/repo files. */
  scenario?: Scenario;
  /** Name of the including config in IncludeRef.from (default `.gitlab-ci.yml`; the trigger job for child pipelines). */
  label?: string;
  /** Child pipeline: jobs of the parent pipeline that run and declare artifacts (for `include:artifact`). */
  parentJobs?: string[];
}

export type ResolvedYaml = LoadedYaml & { includes: IncludeRef[] };

interface Ctx {
  /** undefined = the pipeline's own project. */
  project?: string;
  /** false inside remote/template files: nested `local:` has no project. */
  hasProject: boolean;
  /** undefined = variables unknown (no scenario): paths are kept as written. */
  vars?: Record<string, string>;
  label: string;
}

class Abort extends Error {}

/** Local wildcard → RegExp (Repository#search_files_by_wildcard_path). */
function wildcardRe(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
  return new RegExp(`^${esc.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*?')
    .replace(/\u0001/g, '(.*?/)?').replace(/\u0002/g, '.*?')}$`);
}

const expandVars = (s: string, vars: Record<string, string> | undefined) =>
  vars ? s.replace(/\$(?:\{(\w+)\}|(\w+))|%(\w+)%/g, (_m, a, b, c) => vars[(a ?? b ?? c) as string] ?? '') : s;

const stripSlash = (s: string) => s.replace(/^\/+/, '');

function parseIncludeRules(v: unknown, errors: string[]): Rule[] | undefined {
  if (!Array.isArray(v) || v.length === 0) { errors.push("include:rules config can't be blank"); return undefined; }
  return v.map((r): Rule => {
    if (!isPlainObject(r)) { errors.push('include:rule config should be a hash'); return {}; }
    const unknown = Object.keys(r).filter((k) => !RULE_KEYS.has(k));
    if (unknown.length) errors.push(`include:rule config contains unknown keys: ${unknown.join(', ')}`);
    const rule: Rule = {};
    if (typeof r.if === 'string') rule.if = r.if;
    const paths = (x: unknown): PathsClause => {
      if (!isPlainObject(x)) return { paths: ([] as unknown[]).concat(x).map(String) };
      const c: PathsClause = { paths: ([] as unknown[]).concat(x.paths ?? []).map(String) };
      if (x.compare_to !== undefined) c.compareTo = String(x.compare_to);
      if (x.project !== undefined) c.project = String(x.project);
      if (x.ref !== undefined) c.ref = String(x.ref);
      return c;
    };
    if (r.exists !== undefined) rule.exists = paths(r.exists);
    if (r.changes !== undefined) rule.changes = paths(r.changes);
    if (r.when !== undefined) {
      if (r.when === 'never' || r.when === 'always') rule.when = r.when as When;
      else errors.push(`include:rule when unknown value: ${String(r.when)}`);
    }
    return rule;
  });
}

export function resolveConfig(main: LoadedYaml, opts: ResolveOptions = {}): ResolvedYaml {
  const files = opts.files ?? {};
  const sc = opts.scenario;
  const configVars = sc ? { ...sc.variables, ...sc.userVariables } : undefined;
  const errors = [...main.errors];
  const warnings = [...main.warnings];
  const includes: IncludeRef[] = [];
  let count = 0;
  const out: ResolvedYaml = { ...main, includes, errors, warnings };
  if (main.errors.length) return out;

  /** Interpolate a file's content with its inputs; errors are prefixed with the file location. */
  const interp = (doc: LoadedYaml, inputs: Record<string, unknown> | undefined, location: string, component?: Record<string, string>) => {
    const r = interpolateFile(doc.header, doc.body, inputs, { variables: configVars ?? {}, component });
    errors.push(...r.errors.map((e) => `\`${location}\`: ${e}`));
    warnings.push(...r.warnings.map((w) => `\`${location}\`: ${w}`));
    return r.body;
  };

  const process = (values: Record<string, unknown>, ctx: Ctx): Record<string, unknown> => {
    if (!('include' in values)) return values;
    const { include, ...own } = values;
    let acc: Record<string, unknown> = {};
    const entries = ([] as unknown[]).concat(include ?? []).filter((e) => e !== null && e !== undefined);
    const err = (ref: IncludeRef | undefined, msg: string) => { errors.push(msg); if (ref) ref.error = msg; };

    for (const raw of entries) {
      // Normalizer: string → local / remote
      let e: Record<string, unknown>;
      if (typeof raw === 'string') {
        const s = expandVars(raw, ctx.vars);
        e = URL_RE.test(s) ? { remote: s } : { local: s };
      } else if (isPlainObject(raw)) e = raw;
      else { err(undefined, 'Each include must be a hash or a string'); continue; }

      // Matcher
      const keys = SUBKEYS.filter((k) => (k === 'project' ? e.project !== undefined && e.file !== undefined : e[k] !== undefined));
      if (keys.length === 0) {
        err(undefined, `\`${JSON.stringify(e)}\` does not have a valid subkey for include. Valid subkeys are: \`local\`, \`project\`, \`remote\`, \`template\`, \`artifact\`, \`component\``);
        continue;
      }
      if (keys.length > 1) { err(undefined, 'Each include must use only one of: `local`, `project`, `remote`, `template`, `artifact`, `component`'); continue; }
      const type = keys[0] as IncludeType;
      const inputs = isPlainObject(e.inputs) ? e.inputs : undefined;
      const str = (v: unknown) => expandVars(String(v), ctx.vars);

      // Location expansion (one ref per file)
      const refs: IncludeRef[] = [];
      let artifactJob = '';
      const mk = (file: string, key: string, target: string, extra: Partial<IncludeRef> = {}): IncludeRef =>
        ({ type, file, key, target, from: ctx.label, resolved: false, ...(inputs && { inputs }), ...extra });
      const localKey = (p: string) => (ctx.project ? `project:${ctx.project}:${p}` : `local:${p}`);
      if (type === 'local') {
        const p = stripSlash(str(e.local));
        if (p.includes('*')) {
          const re = wildcardRe(p);
          const prefix = localKey('');
          const hits = Object.keys(files).filter((k) => k.startsWith(prefix) && re.test(k.slice(prefix.length))).sort();
          if (!hits.length) refs.push(mk(p, localKey(p), p, { wildcard: true }));
          for (const k of hits) refs.push(mk(k.slice(prefix.length), k, k.slice(prefix.length), { wildcard: true }));
        } else refs.push(mk(p, localKey(p), p));
      } else if (type === 'project') {
        const proj = str(([] as unknown[]).concat(e.project)[0]);
        const ref = e.ref === undefined ? undefined : str(e.ref);
        for (const f of ([] as unknown[]).concat(e.file)) {
          const p = stripSlash(str(f));
          refs.push(mk(p, `project:${proj.toLowerCase()}:${p}`, `${proj}:${p}${ref ? `@${ref}` : ''}`));
        }
      } else if (type === 'remote') {
        const u = str(e.remote);
        refs.push(mk(u, `remote:${u}`, u));
      } else if (type === 'template') {
        const t = str(e.template);
        refs.push(mk(t, `template:${t}`, t));
      } else if (type === 'component') {
        const c = str(e.component);
        refs.push(mk(c, `component:${c}`, c));
      } else {
        const a = stripSlash(str(e.artifact));
        const j = artifactJob = e.job === undefined ? '' : str(e.job);
        refs.push(mk(a, `artifact:${j}:${a}`, j ? `${j}:${a}` : a));
      }

      // Filter (include:rules) — decided per entry, before loading.
      if (e.rules !== undefined) {
        const rules = parseIncludeRules(e.rules, errors);
        if (rules && sc) {
          const s = scopeOf(ctx.vars ?? {});
          const { matched } = evaluateRules(rules, 'include', s, { ...sc, inputs: sc.inputs });
          const skip = !matched ? 'include:rules — no rule matched' : matched.rule.when === 'never' ? `include:rules #${matched.index} → when: never` : undefined;
          if (skip) { for (const r of refs) { r.skipped = skip; includes.push(r); } continue; }
        }
      }

      for (const ref of refs) {
        includes.push(ref);
        if (ref.wildcard && !files[ref.key]) continue; // zero wildcard matches: no files, no error
        // Verifier
        count += 1;
        if (count > MAX_INCLUDES) { err(ref, `Maximum of ${MAX_INCLUDES} nested includes are allowed!`); throw new Abort(); }
        if (type === 'artifact') {
          const job = artifactJob; // not parsed from the key: job names may contain ':'
          if (!opts.parentJobs) { err(ref, 'Including configs from artifacts is only allowed when triggering child pipelines'); continue; }
          if (!job) { err(ref, 'Job must be provided when including configs from artifacts'); continue; }
          if (!opts.parentJobs.includes(job)) { err(ref, `Job \`${job}\` not found in parent pipeline or does not have artifacts!`); continue; }
        }
        if (type === 'template' && !ref.file.endsWith('.gitlab-ci.yml')) { err(ref, `Template file \`${ref.file}\` is not a valid location!`); continue; }
        if (type === 'remote' && !URL_RE.test(ref.file)) { err(ref, `Remote file \`${ref.file}\` does not have a valid address!`); continue; }
        if (type === 'component' && !/^[^/@]+\/.+\/[^/@]+@.+$/.test(ref.file)) { err(ref, `Component '${ref.file}' - the component path is not supported`); continue; }
        if (type !== 'component' && !/.+\.(yml|yaml)$/i.test(ref.file.split('/').pop() ?? '')) {
          err(ref, `Included file \`${ref.file}\` does not have YAML extension!`); continue;
        }
        if (type === 'local' && !ctx.hasProject) { err(ref, `Local file \`${ref.file}\` does not have project!`); continue; }
        const text = files[ref.key];
        if (text === undefined) continue; // standalone: not provided
        if (!text.trim()) {
          const kind = type === 'local' ? `Local file \`${ref.file}\`` : type === 'project' ? `Project \`${ref.target.split(':')[0]}\` file \`${ref.file}\``
            : type === 'artifact' ? `File \`${ref.file}\`` : `Included file \`${ref.file}\``;
          err(ref, `${kind} is empty!`); continue;
        }
        ref.resolved = true;
        const doc = loadCiYaml(text, ref.target);
        if (doc.errors.length) { for (const m of doc.errors) err(ref, m); continue; }
        warnings.push(...doc.warnings);
        if (!Object.keys(doc.body).length) { err(ref, `Included file \`${ref.file}\` contains no configuration!`); continue; }
        let component: Record<string, string> | undefined;
        if (type === 'component') {
          const [path, version] = ref.file.split('@') as [string, string];
          component = { name: path.split('/').pop()!, version, reference: version };
        }
        const body = interp(doc, inputs, ref.file, component);
        const nested: Ctx =
          type === 'local' || type === 'artifact' ? { ...ctx, label: ref.target }
            : type === 'project' ? { project: ref.key.split(':')[1], hasProject: true, vars: ctx.vars, label: ref.target }
              : type === 'component' ? { project: ref.file.split('@')[0]!.split('/').slice(1, -1).join('/').toLowerCase(), hasProject: true, vars: ctx.vars, label: ref.target }
                : { hasProject: false, vars: ctx.vars && {}, label: ref.target };
        acc = deepMerge(acc, process(body, nested)) as Record<string, unknown>;
      }
    }
    return deepMerge(acc, own) as Record<string, unknown>;
  };

  // The pipeline config itself is a local include of .gitlab-ci.yml carrying the pipeline inputs.
  const inputs = sc?.inputs && Object.keys(sc.inputs).length ? sc.inputs : undefined;
  const body = interp(main, inputs, MAIN_FILE);
  try {
    out.body = process(body, { hasProject: true, vars: configVars, label: opts.label ?? MAIN_FILE });
  } catch (e) {
    if (!(e instanceof Abort)) throw e;
  }
  const missing = includes.filter((i) => !i.resolved && !i.skipped && !i.error);
  if (missing.length) {
    warnings.unshift(`Standalone mode (no GitLab access): ${missing.length} include(s) not provided — ` +
      `jobs, templates and variables defined there are missing: ${missing.map((i) => `${i.type}:${i.target}`).join(', ')}`);
  }
  return out;
}
