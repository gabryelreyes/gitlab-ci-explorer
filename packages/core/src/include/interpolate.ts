// spec:inputs validation + `$[[ inputs.x | fn ]]` interpolation (GitLab Ci::Config::Interpolation / Ci::Inputs).
import { evaluateExpression } from '../expr/index.js';
import { translateRegex } from '../expr/regex.js';
import { isPlainObject } from '../util/merge.js';
import { expandString } from '../vars/expand.js';
import { ReferenceTag } from '../yaml/load.js';

export interface InputSpec {
  type?: string;
  default?: unknown;
  options?: unknown[];
  regex?: string;
  description?: string;
  rules?: { if?: string; options?: unknown[]; default?: unknown }[];
}

const INPUT_KEYS = new Set(['default', 'description', 'options', 'regex', 'type', 'rules']);
const SPEC_KEYS = new Set(['inputs', 'include', 'component', 'description']);
const TYPES = ['array', 'boolean', 'number', 'string'];
const MAX_FUNCTIONS = 3;
const MAX_ERRORS = 3;

export interface InterpolationContext {
  /** Config variables (predefined + user) for `expand_vars`. */
  variables: Record<string, string>;
  /** `$[[ component.* ]]` values, when included as a component. */
  component?: Record<string, string>;
}

/** Header errors in GitLab's `header:spec:…` format. */
function validateHeader(header: Record<string, unknown>, errors: string[], warnings: string[]): Record<string, InputSpec | null> {
  const spec = header.spec;
  if (!isPlainObject(spec)) { errors.push('header:spec config should be a hash'); return {}; }
  const extra = Object.keys(spec).filter((k) => !SPEC_KEYS.has(k));
  if (extra.length) errors.push(`header:spec config contains unknown keys: ${extra.join(', ')}`);
  if (spec.include !== undefined) warnings.push('spec:include is not supported offline; inputs from those files are ignored');
  const inputs = spec.inputs ?? {};
  if (!isPlainObject(inputs)) { errors.push('header:spec:inputs config should be a hash'); return {}; }
  const out: Record<string, InputSpec | null> = {};
  for (const [name, s] of Object.entries(inputs)) {
    const w = `header:spec:inputs:${name}`;
    if (s === null || s === undefined) { out[name] = null; continue; }
    if (!isPlainObject(s)) { errors.push(`${w} config should be a hash`); continue; }
    const unknown = Object.keys(s).filter((k) => !INPUT_KEYS.has(k));
    if (unknown.length) errors.push(`${w} config contains unknown keys: ${unknown.join(', ')}`);
    if (s.type !== undefined && !TYPES.includes(String(s.type))) errors.push(`${w} input type unknown value: ${String(s.type)}`);
    if (s.rules !== undefined && (s.options !== undefined || s.default !== undefined)) {
      errors.push(`${w} config these keys cannot be used together: rules, ${s.options !== undefined ? 'options' : 'default'}`);
    }
    if (Array.isArray(s.options) && s.options.length > 50) errors.push(`${w} config cannot define more than 50 options`);
    out[name] = s as InputSpec;
  }
  return out;
}

/** Ci::Inputs::BaseInput#coerced_value: non-string types accept JSON text ("5", "true", '["a"]'). */
function coerce(type: string, v: unknown): unknown {
  if (type === 'string') return typeof v === 'string' ? v : rubyToS(v);
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

const isType = (type: string, v: unknown) =>
  type === 'number' ? typeof v === 'number' : type === 'boolean' ? typeof v === 'boolean' : type === 'array' ? Array.isArray(v) : true;

/** Validate given inputs against the spec; returns the final input values. Errors are GitLab texts. */
export function validateInputs(
  header: Record<string, unknown>, given: Record<string, unknown>, errors: string[], warnings: string[] = [],
): Record<string, unknown> {
  const specs = validateHeader(header, errors, warnings);
  if (errors.length) return {};
  const values: Record<string, unknown> = {};
  const unknown = Object.keys(given).filter((k) => !(k in specs));
  for (const [name, spec] of Object.entries(specs)) {
    const s = spec ?? {};
    const type = String(s.type ?? 'string');
    let options = s.options;
    let def = s.default;
    if (Array.isArray(s.rules)) {
      const hit = s.rules.find((r) => r.if === undefined || evaluateExpression(r.if, {}, { ...given, ...values }).result);
      if (hit) { options = hit.options; def = hit.default; }
    }
    const provided = name in given;
    const raw = provided ? given[name] : def;
    const e = (msg: string) => errors.push(`\`${name}\` input: ${msg}`);
    if (raw === undefined) { e('required value has not been provided'); continue; }
    const v = coerce(type, raw);
    if (!isType(type, v)) { e(`${provided ? 'provided' : 'default'} value is not ${type === 'array' ? 'an' : 'a'} ${type}`); continue; }
    if (options !== undefined) {
      if (type === 'boolean') e('Options can only be used with string, number, and array inputs');
      else {
        const allowed = options.map((o) => (type === 'string' ? rubyToS(o) : o));
        const vals = type === 'array' ? (v as unknown[]) : [v];
        if (!vals.every((x) => allowed.some((a) => JSON.stringify(a) === JSON.stringify(x)))) {
          if (type === 'array') e(`${(v as unknown[]).map(rubyToS).join(', ')} cannot be used because it is not in the list of allowed options`);
          else e(`\`${rubyToS(v)}\` cannot be used because it is not in the list of ${type === 'number' ? 'the ' : ''}allowed options`);
        }
      }
    }
    if (s.regex !== undefined) {
      if (type !== 'string') e('RegEx validation can only be used with string inputs');
      else {
        const t = translateRegex(String(s.regex), '');
        if (!t.re) e('invalid regular expression');
        else if (!t.re.test(String(v))) e('provided value does not match required RegEx pattern');
      }
    }
    values[name] = v;
  }
  if (unknown.length) errors.push(`unknown input arguments: ${unknown.join(', ')}`);
  return values;
}

/** Ruby #to_s as used by string interpolation. */
function rubyToS(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return `[${v.map(rubyInspect).join(', ')}]`;
  if (isPlainObject(v)) return `{${Object.entries(v).map(([k, x]) => `"${k}" => ${rubyInspect(x)}`).join(', ')}}`;
  return String(v);
}
function rubyInspect(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null || v === undefined) return 'nil';
  return rubyToS(v);
}

/** Shellwords.shellescape */
function shellescape(s: string): string {
  if (s === '') return "''";
  return s.replace(/[^A-Za-z0-9_\-.,:+/@\n]/g, '\\$&').replace(/\n/g, "'\n'");
}

const BLOCK = /\$\[\[\s*(\S.*?\S)\s*\]\]/g;

class InterpError extends Error {}

function evalBlock(data: string, inputs: Record<string, unknown>, ctx: InterpolationContext): unknown {
  if (data.length > 1024) throw new InterpError('maximum interpolation expression size exceeded');
  const [access, ...fns] = data.split('|').map((x) => x.trim());
  if (fns.length > MAX_FUNCTIONS) throw new InterpError('too many functions in interpolation block');
  const m = access!.match(/^(inputs|component)\.([\w-]+)((?:\[\d+\])*)$/);
  if (!m) throw new InterpError('invalid pattern used for interpolation. valid pattern is $[[ inputs.input ]]');
  const [, root, name, idx] = m;
  const scope: Record<string, unknown> = root === 'inputs' ? inputs : (ctx.component ?? {});
  if (!(name! in scope)) throw new InterpError(`unknown interpolation provided: \`${name}\` in \`${access}\``);
  let value = scope[name!];
  for (const [, n] of idx!.matchAll(/\[(\d+)\]/g)) {
    const arr = Array.isArray(value) ? value : [];
    const i = Number(n);
    if (i >= arr.length) throw new InterpError(`array index ${i} out of bounds (size: ${arr.length}) in \`${access}\``);
    value = arr[i];
  }
  fns.forEach((fn, i) => {
    const f = fn.match(/^(\w+)(?:\((.*)\))?$/);
    const name = f?.[1];
    const args = f?.[2];
    const noMatch = () => new InterpError(`no function matching \`${fn}\`: check that the function name, arguments, and types are correct`);
    if (typeof value !== 'string') throw noMatch();
    if (name === 'truncate' && args && /^\s*\d+\s*,\s*\d+\s*$/.test(args)) {
      const [off, len] = args.split(',').map(Number) as [number, number];
      value = (value as string).slice(off, off + len);
    } else if (name === 'posix_escape' && args === undefined) value = shellescape(value as string);
    else if (name === 'expand_vars' && args === undefined) value = expandString(value as string, ctx.variables);
    else if (name === 'split' && args && /^'.*'$/.test(args.trim()) && i === fns.length - 1) value = (value as string).split(args.trim().slice(1, -1));
    else throw noMatch();
  });
  return value;
}

/** Interpolate one string; a string that is exactly one block keeps the value's type. */
function interpString(s: string, inputs: Record<string, unknown>, ctx: InterpolationContext, errors: string[]): unknown {
  BLOCK.lastIndex = 0;
  const whole = s.match(/^\$\[\[\s*(\S.*?\S)\s*\]\]$/);
  try {
    if (whole) return evalBlock(whole[1]!, inputs, ctx);
    return s.replace(BLOCK, (_m, data: string) => rubyToS(evalBlock(data, inputs, ctx)));
  } catch (e) {
    if (e instanceof InterpError) { if (!errors.includes(e.message)) errors.push(e.message); return s; }
    throw e;
  }
}

function walk(v: unknown, inputs: Record<string, unknown>, ctx: InterpolationContext, errors: string[]): unknown {
  if (typeof v === 'string') return v.includes('$[[') ? interpString(v, inputs, ctx, errors) : v;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      const r = walk(item, inputs, ctx, errors);
      // A whole-block array item that yields an array is spliced into the parent.
      if (typeof item === 'string' && /^\$\[\[.*\]\]$/.test(item) && Array.isArray(r)) out.push(...r); else out.push(r);
    }
    return out;
  }
  if (v instanceof ReferenceTag) return v;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[String(walk(k, inputs, ctx, errors))] = walk(x, inputs, ctx, errors);
    return out;
  }
  return v;
}

/** Ci::Config::Interpolation::Interpolator for one file. Errors are capped at 3 and joined like GitLab. */
export function interpolateFile(
  header: Record<string, unknown> | undefined, body: Record<string, unknown>, given: Record<string, unknown> | undefined,
  ctx: InterpolationContext,
): { body: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const warnings: string[] = [];
  if (given !== undefined && !isPlainObject(given)) return { body, errors: ['Given inputs must be a hash'], warnings };
  if (!header) {
    if (given && Object.keys(given).length) return { body, errors: ['Given inputs not defined in the `spec` section of the included configuration file'], warnings };
    return { body, errors: [], warnings };
  }
  const errors: string[] = [];
  const inputs = validateInputs(header, given ?? {}, errors, warnings);
  if (errors.length) return { body, errors: [errors.slice(0, MAX_ERRORS).join(', ')], warnings };
  const out = walk(body, inputs, ctx, errors) as Record<string, unknown>;
  return { body: out, errors: errors.length ? [errors.slice(0, MAX_ERRORS).join(', ')] : [], warnings };
}
