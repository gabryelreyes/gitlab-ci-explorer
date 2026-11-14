// Job dependency graph of an evaluated pipeline.
//  needs   — explicit `needs:` (all drawn, like GitLab's needs view)
//  stage   — implicit stage order of jobs without `needs:`, transitively reduced
//  missing — non-optional need on a job excluded by rules (pipeline error)
import type { PipelineResult } from './evaluate/index.js';

export interface GraphEdge {
  from: string;
  to: string;
  kind: 'needs' | 'stage' | 'missing';
  artifacts?: boolean;
  optional?: boolean;
}

export interface PipelineGraph {
  /** Jobs in stage order (included and excluded). */
  nodes: string[];
  edges: GraphEdge[];
}

export function pipelineGraph(r: PipelineResult): PipelineGraph {
  const stageIx = new Map(r.stages.map((s, i) => [s, i]));
  const live = r.jobs.filter((j) => j.included);
  const liveSet = new Set(live.map((j) => j.name));

  // Full (unreduced) upstream set per job: needs, or every included job in an earlier stage.
  const direct = new Map<string, string[]>();
  for (const j of live) {
    const deps = j.needs
      ? j.needs.filter((n) => !n.pipeline && !n.project && liveSet.has(n.job)).map((n) => n.job)
      : live.filter((o) => (stageIx.get(o.stage) ?? 0) < (stageIx.get(j.stage) ?? 0)).map((o) => o.name);
    direct.set(j.name, deps);
  }
  const anc = new Map<string, Set<string>>();
  const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
    const hit = anc.get(name);
    if (hit) return hit;
    if (seen.has(name)) return new Set(); // cycle guard (normalize reports cycles)
    seen.add(name);
    const out = new Set<string>();
    for (const d of direct.get(name) ?? []) { out.add(d); for (const a of ancestors(d, seen)) out.add(a); }
    anc.set(name, out);
    return out;
  };

  const edges: GraphEdge[] = [];
  for (const j of r.jobs) {
    if (j.included && j.needs) {
      for (const n of j.needs) {
        if (n.pipeline || n.project || !liveSet.has(n.job)) continue;
        edges.push({ from: n.job, to: j.name, kind: 'needs', artifacts: n.artifacts, optional: n.optional });
      }
    } else if (j.included) {
      const cands = direct.get(j.name) ?? [];
      // Drop a candidate if another candidate already waits for it.
      for (const c of cands) if (!cands.some((o) => o !== c && ancestors(o).has(c))) edges.push({ from: c, to: j.name, kind: 'stage' });
    }
    for (const m of j.missingNeeds ?? []) edges.push({ from: m, to: j.name, kind: 'missing' });
  }
  const nodes = [...r.jobs].sort((a, b) => (stageIx.get(a.stage) ?? 0) - (stageIx.get(b.stage) ?? 0)).map((j) => j.name);
  return { nodes, edges };
}

/** Transitive upstream/downstream jobs of `name` (missing edges are not followed). */
export function relatives(g: PipelineGraph, name: string): { up: Set<string>; down: Set<string> } {
  const walk = (forward: boolean) => {
    const out = new Set<string>();
    const stack = [name];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of g.edges) {
        if (e.kind === 'missing') continue;
        const [a, b] = forward ? [e.from, e.to] : [e.to, e.from];
        if (a === cur && b !== name && !out.has(b)) { out.add(b); stack.push(b); }
      }
    }
    return out;
  };
  return { up: walk(false), down: walk(true) };
}
