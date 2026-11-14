// Translate a GitLab pattern into a JS RegExp. GitLab (UntrustedRegexp::RubySyntax) prepends the
// flags as RE2 inline flags `(?ismU)`, so: i = case-insensitive, m = ^/$ at line breaks,
// s = dot-all, U = ungreedy. Anything we can't map faithfully is a warning; RE2-unsupported
// syntax is an error, because GitLab rejects such patterns.

export interface TranslatedRegex {
  re?: RegExp;
  warnings: string[];
  error?: string;
}

const POSIX: Record<string, string> = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z',
  space: '\\s', xdigit: '0-9A-Fa-f', word: '\\w', punct: '!-\\/:-@\\[-`{-~', blank: ' \\t',
};

/** RubySyntax::PATTERN `^/(.*)/([ismU]*)$` (greedy) — for values held in variables / only:refs. */
export function parseSlashPattern(s: string): [source: string, flags: string] | null {
  const m = s.match(/^\/(.*)\/([ismU]*)$/s);
  return m ? [m[1]!, m[2]!] : null;
}

export function translateRegex(source: string, flags: string): TranslatedRegex {
  const warnings: string[] = [];
  if (/\(\?<?[=!]/.test(source)) return { warnings, error: 'RE2 does not support lookaround; GitLab rejects this pattern' };
  if (/\\[1-9]/.test(source)) return { warnings, error: 'RE2 does not support backreferences; GitLab rejects this pattern' };
  if (/\\Z/.test(source)) return { warnings, error: 'RE2 does not support \\Z; GitLab rejects this pattern' };

  let src = source;
  let all = flags;
  const lead = src.match(/^\(\?([imsU]+)\)/);
  if (lead) { src = src.slice(lead[0].length); all += lead[1]; }
  let jsFlags = '';
  for (const f of new Set(all)) {
    if (f === 'i' || f === 'm' || f === 's') jsFlags += f;
    else if (f === 'U') warnings.push('flag U (ungreedy) has no JS equivalent; ignored');
  }
  if (/\(\?[imsU-]+[):]/.test(src)) warnings.push('inline flag groups may behave differently in JS');
  if (/\\Q|\\E/.test(src)) warnings.push('\\Q...\\E literal quoting not supported in JS');
  src = src
    .replace(/\\A/g, '(?<![\\s\\S])')
    .replace(/\\z/g, '(?![\\s\\S])')
    .replace(/\[:(\w+):\]/g, (all, name: string) => POSIX[name] ?? all);
  if (/\\[pP]\{/.test(src)) jsFlags += 'u';
  try {
    return { re: new RegExp(src, jsFlags), warnings };
  } catch (e) {
    return { warnings, error: `invalid regex /${source}/${flags}: ${(e as Error).message}` };
  }
}
