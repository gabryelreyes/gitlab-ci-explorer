import { describe, expect, it } from 'vitest';
import { evaluateExpression, parseExpression } from '../src/expr/index.js';

const ev = (src: string, vars: Record<string, string> = {}) => evaluateExpression(src, vars).result;

describe('expression parsing', () => {
  it('rejects unknown lexemes', () => {
    expect(() => parseExpression('$A = "x"')).toThrow(/unknown lexeme/i);
  });
  it('rejects unbalanced parentheses', () => {
    expect(() => parseExpression('($A == "x"')).toThrow(/parenthes/i);
  });
  it('rejects dangling operators', () => {
    expect(() => parseExpression('$A ==')).toThrow();
  });
  it('round-trips to canonical text', () => {
    expect(parseExpression('$A=="x"&&($B||$C)').toString()).toBe('$A == "x" && ($B || $C)');
  });
});

describe('expression evaluation (GitLab semantics)', () => {
  it('bare variable is true only when defined and non-empty', () => {
    expect(ev('$A', { A: 'x' })).toBe(true);
    expect(ev('$A', { A: '' })).toBe(false);
    expect(ev('$A', {})).toBe(false);
  });
  it('string equality, both quote styles', () => {
    expect(ev('$A == "x"', { A: 'x' })).toBe(true);
    expect(ev("$A == 'x'", { A: 'x' })).toBe(true);
    expect(ev('$A != "x"', { A: 'y' })).toBe(true);
  });
  it('undefined differs from empty string; null literal', () => {
    expect(ev('$A == ""', {})).toBe(false);
    expect(ev('$A == null', {})).toBe(true);
    expect(ev('$A != null', { A: '' })).toBe(true);
  });
  it('variable vs variable', () => {
    expect(ev('$A == $B', { A: 'm', B: 'm' })).toBe(true);
    expect(ev('$A == $B', {})).toBe(true); // nil == nil
  });
  it('regex match and flags', () => {
    expect(ev('$A =~ /^feat\\//', { A: 'feat/x' })).toBe(true);
    expect(ev('$A =~ /^FEAT/i', { A: 'feat' })).toBe(true);
    expect(ev('$A !~ /^feat/', { A: 'fix' })).toBe(true);
  });
  it('regex against undefined uses empty string (Ruby to_s)', () => {
    expect(ev('$A =~ /.*/', {})).toBe(true);
    expect(ev('$A =~ /x/', {})).toBe(false);
  });
  it('regex from a variable holding /pattern/', () => {
    expect(ev('$A =~ $P', { A: 'release-1', P: '/^release-\\d+$/' })).toBe(true);
  });
  it('&& binds tighter than ||', () => {
    expect(ev('$A || $B && $C', { A: 'x' })).toBe(true);
    expect(ev('($A || $B) && $C', { A: 'x' })).toBe(false);
  });
  it('Ruby truthiness inside && / ||: empty string is truthy', () => {
    // "" && "x" -> "x" in Ruby -> present -> true
    expect(ev('$A && $B', { A: '', B: 'x' })).toBe(true);
    expect(ev('$A && $B', { A: 'x', B: '' })).toBe(false);
  });
  it('negation and boolean literals', () => {
    expect(ev('!$A', {})).toBe(true);
    expect(ev('!($A == "x")', { A: 'y' })).toBe(true);
    expect(ev('$A == true', { A: 'true' })).toBe(true);
  });
  it('inputs interpolation lexeme', () => {
    expect(evaluateExpression('$[[ inputs.env ]] == "prod"', {}, { env: 'prod' }).result).toBe(true);
  });
  it('lists variables referenced', () => {
    expect(parseExpression('$A == "x" || $B =~ /yy/ || $A').variables()).toEqual(['A', 'B']);
  });
});

describe('regex translation', () => {
  it('supports RE2-only constructs natively', () => {
    const r = evaluateExpression('$A =~ /\\Afoo\\z/', { A: 'foo' });
    expect(r.result).toBe(true);
    const u = evaluateExpression('$A =~ /a+/U', { A: 'aaa' });
    expect(u.result).toBe(true);
    expect(u.warnings).toEqual([]);
  });

  it('uses RE2 semantics: U flag, inline flags, \\Q..\\E, POSIX classes', () => {
    expect(evaluateExpression('$A =~ /^a+?$/U', { A: 'aaa' }).result).toBe(true);
    expect(evaluateExpression('$A =~ /(?i)^MAIN$/', { A: 'main' }).result).toBe(true);
    expect(evaluateExpression('$A =~ /^\\Qa.b\\E$/', { A: 'a.b' }).result).toBe(true);
    expect(evaluateExpression('$A =~ /^\\Qa.b\\E$/', { A: 'axb' }).result).toBe(false);
    expect(evaluateExpression('$A =~ /^[[:alpha:]]+$/', { A: 'abc' }).result).toBe(true);
  });

  it('does not backtrack catastrophically', () => {
    const t0 = Date.now();
    expect(evaluateExpression('$A =~ /^(a+)+$/', { A: `${'a'.repeat(50000)}!` }).result).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
