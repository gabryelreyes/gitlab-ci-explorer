// Shareable state in the URL hash: JSON → deflate-raw → base64url.
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
    const s = JSON.parse(new TextDecoder().decode(raw)) as AppState;
    if (s?.v !== 1 || typeof s.text !== 'string' || typeof s.ui?.kind !== 'string') return undefined;
    return s;
  } catch {
    return undefined;
  }
}
