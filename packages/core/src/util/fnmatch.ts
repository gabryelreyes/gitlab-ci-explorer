// Ruby File.fnmatch(pattern, path, FNM_PATHNAME | FNM_DOTMATCH | FNM_EXTGLOB), as used by
// GitLab for changes:/exists:. `**/` matches zero or more directories; `**` not followed by `/`
// behaves like `*`; `{a,b}` alternation; `[...]`/`[!...]` classes; `\` escapes. No `!` negation.

const cache = new Map<string, RegExp>();
const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function translate(p: string, i: number, inBrace: boolean): [string, number] {
  let out = '';
  while (i < p.length) {
    const c = p[i]!;
    if (inBrace && (c === ',' || c === '}')) return [out, i];
    if (c === '\\' && i + 1 < p.length) { out += esc(p[i + 1]!); i += 2; continue; }
    if (c === '*') {
      if (p[i + 1] === '*' && p[i + 2] === '/' && (i === 0 || p[i - 1] === '/')) { out += '(?:[^/]*/)*'; i += 3; continue; }
      while (p[i] === '*') i++;
      out += '[^/]*';
      continue;
    }
    if (c === '?') { out += '[^/]'; i++; continue; }
    if (c === '[') {
      const end = p.indexOf(']', i + 2);
      if (end === -1) { out += '\\['; i++; continue; }
      let body = p.slice(i + 1, end);
      const neg = body[0] === '!' || body[0] === '^';
      if (neg) body = body.slice(1);
      out += `(?!/)[${neg ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/]/g, '\\]')}]`;
      i = end + 1;
      continue;
    }
    if (c === '{') {
      const alts: string[] = [];
      let j = i + 1;
      for (;;) {
        const [alt, k] = translate(p, j, true);
        alts.push(alt);
        if (k >= p.length) return [out + esc('{') + alts.join(','), k]; // unterminated: literal
        j = k + 1;
        if (p[k] === '}') break;
      }
      out += `(?:${alts.join('|')})`;
      i = j;
      continue;
    }
    out += esc(c);
    i++;
  }
  return [out, i];
}

export function fnmatch(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(`^${translate(pattern, 0, false)[0]}$`);
    cache.set(pattern, re);
  }
  return re.test(path);
}
