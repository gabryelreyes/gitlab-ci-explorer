// Shareable state in the URL hash: JSON → deflate-raw → base64url.
import { PRESET_KINDS } from '@gce/core';
import type { UiScenario } from './App';

export interface AppState {
  v: 1;
  text: string;
  ui: UiScenario;
  /** Scenario B of the compare view. */
  uiB?: UiScenario;
  tab?: string;
  selected?: string;
  /** Provided include files (key → content). */
  files?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
const isStrMap = (v: unknown) => isObj(v) && Object.values(v).every(isStr);

const OPT_STRINGS = ['branch', 'tag', 'defaultBranch', 'mrSource', 'mrTarget', 'mrIid', 'mrTitle', 'projectPath', 'commitMessage'];
const OPT_BOOLS = ['openMr', 'protected', 'newBranch'];

function isUiScenario(u: unknown): u is UiScenario {
  if (!isObj(u) || !(PRESET_KINDS as readonly unknown[]).includes(u.kind)) return false;
  const o = u.opts;
  if (!isObj(o)) return false;
  if (!OPT_STRINGS.every((k) => optional(o[k], isStr)) || !OPT_BOOLS.every((k) => optional(o[k], (x) => typeof x === 'boolean'))) return false;
  if (!optional(o.mrLabels, (x) => Array.isArray(x) && x.every(isStr))) return false;
  return isStrMap(u.userVars) && isStr(u.changed) && isStr(u.files) && optional(u.inputs, isStrMap);
}

/** Links are untrusted input: anything the app would later dereference is checked here. */
function isAppState(s: unknown): s is AppState {
  return isObj(s) && s.v === 1 && isStr(s.text) && isUiScenario(s.ui) && optional(s.uiB, isUiScenario)
    && optional(s.tab, isStr) && optional(s.selected, isStr) && optional(s.files, isStrMap);
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const toB64url = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function encodeState(s: AppState): Promise<string> {
  return toB64url(await pipe(new TextEncoder().encode(JSON.stringify(s)), new CompressionStream('deflate-raw')));
}

export async function decodeState(hash: string): Promise<AppState | undefined> {
  try {
    const raw = await pipe(fromB64url(hash), new DecompressionStream('deflate-raw'));
    const s: unknown = JSON.parse(new TextDecoder().decode(raw));
    return isAppState(s) ? s : undefined;
  } catch {
    return undefined;
  }
}
