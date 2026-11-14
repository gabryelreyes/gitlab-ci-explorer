// Compile a GitLab pattern with RE2 semantics (re2js: linear time, no catastrophic backtracking —
// patterns and subjects can come from untrusted shared links). GitLab (UntrustedRegexp::RubySyntax)
// prepends the flags as RE2 inline flags `(?ismU)`, so: i = case-insensitive, m = ^/$ at line
// breaks, s = dot-all, U = ungreedy. RE2-unsupported syntax is an error, because GitLab rejects it.
import { RE2JS } from 're2js';

/** Unanchored match, like `UntrustedRegexp#match?`. */
export interface Matcher { test(s: string): boolean }

export interface TranslatedRegex {
  re?: Matcher;
  warnings: string[];
  error?: string;
}

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
  try {
    const re = RE2JS.compile(flags ? `(?${flags})${source}` : source);
    return { re: { test: (s) => re.matcher(s).find() }, warnings };
  } catch (e) {
    return { warnings, error: `invalid regex /${source}/${flags}: ${(e as Error).message}` };
  }
}
