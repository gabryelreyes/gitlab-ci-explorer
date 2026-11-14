// YAML → plain JS for a single CI file: anchors, `<<` merge keys, `!reference`, `spec:` header split.
import { isMap, isNode, isSeq, LineCounter, parseAllDocuments, type Document, type YAMLSeq } from 'yaml';

/** Unresolved `!reference [job, key, ...]` tag. Resolved later by normalize/reference.ts. */
export class ReferenceTag {
  constructor(readonly path: string[]) {}
  toString(): string {
    return `!reference [${this.path.join(', ')}]`;
  }
}
export const isReference = (v: unknown): v is ReferenceTag => v instanceof ReferenceTag;

const referenceTag = {
  tag: '!reference',
  collection: 'seq' as const,
  resolve(seq: YAMLSeq, onError: (msg: string) => void) {
    const items = seq.items.map((n) => (isNode(n) ? n.toJSON() : n));
    if (items.length === 0 || items.some((x) => typeof x !== 'string')) {
      onError('!reference must be a non-empty sequence of strings');
    }
    return new ReferenceTag(items.map(String));
  },
};

/** Psych booleans: yes/true/on, no/false/off (any case) — but NOT y/n like the YAML 1.1 spec. */
const psychBool = {
  identify: (v: unknown) => typeof v === 'boolean',
  default: true,
  tag: 'tag:yaml.org,2002:bool',
  test: /^(?:yes|true|on|no|false|off)$/i,
  resolve: (s: string) => /^(?:yes|true|on)$/i.test(s),
};
const BOOL_TAG = 'tag:yaml.org,2002:bool';

export interface LoadedYaml {
  /** First document when it contains `spec:` (the header). */
  header?: Record<string, unknown>;
  body: Record<string, unknown>;
  /** 1-based line of each top-level key of the body. */
  lines: Record<string, number>;
  errors: string[];
  warnings: string[];
  file?: string;
}

const MAX_ALIASES = 10_000;
const MAX_YAML_ERRORS = 2;

/** Heuristic: most indented lines have exactly one leading space (runs of spaces collapsed). */
function looksFlattened(text: string): boolean {
  const indents = text.split('\n').filter((l) => l.trim() && /^ /.test(l)).map((l) => l.match(/^ */)![0].length);
  return indents.length >= 10 && indents.filter((n) => n === 1).length / indents.length > 0.6;
}

export function loadCiYaml(text: string, file?: string): LoadedYaml {
  const lineCounter = new LineCounter();
  const out: LoadedYaml = { body: {}, lines: {}, errors: [], warnings: [], file };
  const where = file ? `${file}: ` : '';
  let docs: Document.Parsed[];
  try {
    docs = parseAllDocuments(text, {
      version: '1.1', // GitLab parses with Psych (YAML 1.1)
      merge: true,
      uniqueKeys: false, // Psych: last duplicate key wins
      customTags: (tags) => [psychBool, ...tags.filter((t) => typeof t === 'string' || t.tag !== BOOL_TAG), referenceTag],
      lineCounter,
      prettyErrors: true,
    }) as Document.Parsed[];
  } catch (e) {
    out.errors.push(`${where}${(e as Error).message}`);
    return out;
  }
  if (!Array.isArray(docs)) docs = [docs];
  const yamlErrors = docs.flatMap((d) => d.errors.map((e) => `${where}${e.message}`));
  for (const d of docs) out.warnings.push(...d.warnings.map((e) => `${where}${e.message}`));
  if (yamlErrors.length) {
    // The first error is the real one; the rest usually cascade from it.
    out.errors.push(...yamlErrors.slice(0, MAX_YAML_ERRORS));
    if (yamlErrors.length > MAX_YAML_ERRORS) out.errors.push(`${where}(+${yamlErrors.length - MAX_YAML_ERRORS} more YAML errors)`);
    if (looksFlattened(text)) {
      out.errors.unshift(`${where}invalid YAML: indentation looks flattened (nested keys and block scalars have ` +
        'only 0–1 leading spaces). Were leading spaces lost when copying the file?');
    }
    return out;
  }

  const toJs = (d: Document.Parsed): unknown => d.toJS({ maxAliasCount: MAX_ALIASES });
  let bodyDoc: Document.Parsed | undefined;
  if (docs.length >= 2) {
    const first = toJs(docs[0]!);
    if (first && typeof first === 'object' && 'spec' in first) out.header = first as Record<string, unknown>;
    else out.errors.push(`${where}multiple YAML documents are only allowed after a spec: header`);
    bodyDoc = docs[1];
    if (docs.length > 2) out.errors.push(`${where}only one document is allowed after the spec: header`);
  } else {
    bodyDoc = docs[0];
  }
  if (!bodyDoc || bodyDoc.contents === null) return out;

  if (!isMap(bodyDoc.contents)) {
    out.errors.push(`${where}${isSeq(bodyDoc.contents) ? 'root must be a mapping, not a sequence' : 'root must be a mapping'}`);
    return out;
  }
  for (const pair of bodyDoc.contents.items) {
    const k = isNode(pair.key) ? (pair.key as { value?: unknown }).value : pair.key;
    const range = isNode(pair.key) ? pair.key.range : undefined;
    if (range) out.lines[String(k)] = lineCounter.linePos(range[0]).line;
  }
  try {
    out.body = (toJs(bodyDoc) ?? {}) as Record<string, unknown>;
  } catch (e) {
    out.errors.push(`${where}${(e as Error).message}`);
  }
  if (!out.header && 'spec' in out.body) {
    out.errors.push(`${where}spec: must be in its own document, followed by ---`);
    delete out.body.spec;
  }
  return out;
}
