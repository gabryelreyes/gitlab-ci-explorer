// Tokenizer mirroring gitlab/lib/gitlab/ci/pipeline/expression/lexer.rb (lexeme order matters).

export type Token =
  | { t: 'lparen' | 'rparen' | 'null' | 'and' | 'or' | 'not'; pos: number }
  | { t: 'eq' | 'ne' | 'match' | 'nomatch'; pos: number }
  | { t: 'var'; name: string; pos: number }
  | { t: 'input'; name: string; pos: number }
  | { t: 'str'; value: string; pos: number }
  | { t: 're'; source: string; flags: string; pos: number }
  | { t: 'bool'; value: boolean; pos: number };

export class ExprSyntaxError extends Error {
  constructor(msg: string, readonly pos?: number) {
    super(pos === undefined ? msg : `${msg} (at ${pos})`);
    this.name = 'ExprSyntaxError';
  }
}

const MAX_TOKENS = 100;

/** Scans a `/.../flags` literal starting at `i`; returns [source, flags, end] or null. */
export function scanPattern(src: string, i: number): [string, string, number] | null {
  if (src[i] !== '/') return null;
  let j = i + 1;
  let body = '';
  while (j < src.length) {
    const c = src[j]!;
    if (c === '\\' && j + 1 < src.length) {
      // GitLab unescapes \/ to / ; keep every other escape verbatim.
      body += src[j + 1] === '/' ? '/' : c + src[j + 1];
      j += 2;
      continue;
    }
    if (c === '/') break;
    body += c;
    j++;
  }
  // Pattern lexeme `^\/([^\/]|\\/)+[^\\]\/` needs at least 2 chars between the slashes.
  if (j >= src.length || j - (i + 1) < 2) return null;
  j++; // closing slash
  let flags = '';
  while (j < src.length && /[ismU]/.test(src[j]!)) flags += src[j++];
  return [body, flags, j];
}

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const rest = () => src.slice(i);
  // Same loop shape as lexer.rb: MAX_TOKENS iterations, so at most MAX_TOKENS - 1 tokens fit.
  for (let n = 0; n < MAX_TOKENS; n++) {
    while (i < src.length && /\s/.test(src[i]!)) i++;
    if (i >= src.length) return out;
    const pos = i;
    let m: RegExpMatchArray | null;
    const r = rest();
    if (r[0] === '(') { out.push({ t: 'lparen', pos }); i++; continue; }
    if (r[0] === ')') { out.push({ t: 'rparen', pos }); i++; continue; }
    if ((m = r.match(/^\$\[\[\s*inputs\.([\w-]+)\s*\]\]/))) {
      out.push({ t: 'input', name: m[1]!, pos }); i += m[0].length; continue;
    }
    if ((m = r.match(/^\$(\w+)/))) { out.push({ t: 'var', name: m[1]!, pos }); i += m[0].length; continue; }
    if ((m = r.match(/^"(.*?)"|^'(.*?)'/))) {
      out.push({ t: 'str', value: m[1] ?? m[2] ?? '', pos }); i += m[0].length; continue;
    }
    const p = scanPattern(src, i);
    if (p) { out.push({ t: 're', source: p[0], flags: p[1], pos }); i = p[2]; continue; }
    if (r.startsWith('null')) { out.push({ t: 'null', pos }); i += 4; continue; }
    if ((m = r.match(/^(true|false)\b/))) { out.push({ t: 'bool', value: m[1] === 'true', pos }); i += m[0].length; continue; }
    const ops: [string, Token['t']][] = [['==', 'eq'], ['=~', 'match'], ['!=', 'ne'], ['!~', 'nomatch'], ['&&', 'and'], ['||', 'or'], ['!', 'not']];
    const op = ops.find(([s]) => r.startsWith(s));
    if (op) { out.push({ t: op[1], pos } as Token); i += op[0].length; continue; }
    throw new ExprSyntaxError('Unknown lexeme found', pos);
  }
  throw new ExprSyntaxError('Too many tokens');
}
