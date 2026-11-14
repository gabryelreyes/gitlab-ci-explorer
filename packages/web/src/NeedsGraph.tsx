import { PATH_SEP, pipelineGraph, relatives, type GraphEdge, type JobResult, type PipelineResult } from '@gce/core';
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { ChildBadge, localName, whenClass } from './PipelineView';

const W = 190;
const H = 46;
const GROUP_PAD = '[top=30,left=14,bottom=14,right=14]';
const CHILD = '#child';

interface Props {
  result: PipelineResult;
  selected?: string;
  onSelect: (path: string | undefined) => void;
  dark: boolean;
}

type Rel = 'sel' | 'up' | 'down' | 'dim' | '';
type JobNode = Node<{ job: JobResult; rel: Rel }, 'job'>;
type GroupNode = Node<{ title: string; created: boolean; reason: string }, 'pipeline'>;

function JobCard({ data }: NodeProps<JobNode>) {
  const j = data.job;
  return (
    <div className={`job gjob ${whenClass(j)} rel-${data.rel}`} style={{ width: W, height: H }}>
      <Handle type="target" position={Position.Left} className="ghandle" />
      <div className="job-name" title={j.name}>{j.name}</div>
      <div className="job-meta">
        <span className="badge">{j.included ? j.when : 'excluded'}</span>
        {j.blocking && <span className="badge block">blocking</span>}
        <ChildBadge j={j} compact />
        <span className="muted small">{j.stage}</span>
      </div>
      <Handle type="source" position={Position.Right} className="ghandle" />
    </div>
  );
}

function PipelineGroup({ data }: NodeProps<GroupNode>) {
  return (
    <div className={`pgroup ${data.created ? '' : 'bad'}`}>
      <Handle type="target" position={Position.Left} className="ghandle" />
      <div className="pgroup-title" title={data.reason}>▸ {data.title} · {data.created ? 'child pipeline' : `not created — ${data.reason}`}</div>
    </div>
  );
}
const nodeTypes = { job: JobCard, pipeline: PipelineGroup };

/** One pipeline level (the root or a child pipeline). */
interface Level {
  prefix: string;
  result: PipelineResult;
  graph: ReturnType<typeof pipelineGraph>;
  /** Included jobs + excluded jobs something still needs. */
  visible: string[];
  edges: GraphEdge[];
  /** Trigger jobs with a child pipeline: [job name, child level | undefined]. */
  children: [JobResult, Level | undefined][];
}

function levelOf(result: PipelineResult, prefix: string): Level {
  const graph = pipelineGraph(result);
  const jobs = new Map(result.jobs.map((j) => [j.name, j]));
  const missing = new Set(graph.edges.filter((e) => e.kind === 'missing').map((e) => e.from));
  const visible = graph.nodes.filter((n) => jobs.get(n)?.included || missing.has(n));
  const v = new Set(visible);
  return {
    prefix, result, graph, visible,
    edges: graph.edges.filter((e) => v.has(e.from) && v.has(e.to)),
    children: result.jobs.filter((j) => j.downstream && v.has(j.name)).map((j) => {
      const c = j.downstream!.result;
      return [j, c && c.created ? levelOf(c, prefix + j.name + PATH_SEP) : undefined];
    }),
  };
}

const allLevels = (l: Level): Level[] => [l, ...l.children.flatMap(([, c]) => (c ? allLevels(c) : []))];

interface Box { x: number; y: number; width: number; height: number }
type ElkNode = { id: string; width?: number; height?: number; children?: ElkNode[]; edges?: { id: string; sources: string[]; targets: string[] }[]; layoutOptions?: Record<string, string> };

const OPTS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.spacing.nodeNode': '14',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
};

function toElk(l: Level): Pick<ElkNode, 'children' | 'edges'> {
  const children: ElkNode[] = l.visible.map((n) => ({ id: l.prefix + n, width: W, height: H }));
  const edges = l.edges.map((e, i) => ({ id: `${l.prefix}e${i}`, sources: [l.prefix + e.from], targets: [l.prefix + e.to] }));
  for (const [j, c] of l.children) {
    const id = l.prefix + j.name + CHILD;
    children.push(c && c.visible.length
      ? { id, ...toElk(c), layoutOptions: { ...OPTS, 'elk.padding': GROUP_PAD } }
      : { id, width: W + 60, height: 40 });
    edges.push({ id: `${id}>`, sources: [l.prefix + j.name], targets: [id] });
  }
  return { children, edges };
}

/** ELK layered layout, left → right; child pipelines are compound nodes. Loaded lazily (large bundle). */
async function layout(root: Level): Promise<Record<string, Box>> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const g = await new ELK().layout({ id: 'root', layoutOptions: OPTS, ...toElk(root) } as Parameters<InstanceType<typeof ELK>['layout']>[0]);
  const out: Record<string, Box> = {};
  const walk = (n: { id: string; x?: number; y?: number; width?: number; height?: number; children?: unknown[] }) => {
    out[n.id] = { x: n.x ?? 0, y: n.y ?? 0, width: n.width ?? W, height: n.height ?? H };
    for (const c of (n.children ?? []) as typeof n[]) walk(c);
  };
  for (const c of g.children ?? []) walk(c);
  return out;
}

export function NeedsGraph({ result, selected, onSelect, dark }: Props) {
  const [showStage, setShowStage] = useState(true);
  const root = useMemo(() => levelOf(result, ''), [result]);
  const levels = useMemo(() => allLevels(root), [root]);
  const hidden = levels.reduce((s, l) => s + l.graph.nodes.length - l.visible.length, 0);

  // Layout depends only on structure, not on selection.
  const key = JSON.stringify(levels.map((l) => [l.prefix, l.visible, l.edges.map((e) => [e.from, e.to]), l.children.map(([j, c]) => [j.name, !!c])]));
  const [pos, setPos] = useState<{ key: string; pos: Record<string, Box> }>();
  useEffect(() => {
    let live = true;
    void layout(root).then((p) => { if (live) setPos({ key, pos: p }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Chain highlight within the selected job's pipeline level.
  const selLevel = levels.find((l) => { const n = localName(selected, l.prefix); return n !== undefined && l.result.jobs.some((j) => j.name === n && j.included); });
  const selName = selLevel && localName(selected, selLevel.prefix)!;
  const rel = useMemo(() => (selLevel ? relatives(selLevel.graph, selName!) : undefined), [selLevel, selName]);
  // Child pipelines of the selected job (and of jobs waiting for it) run downstream of it.
  const downLevels = useMemo(() => {
    if (!selLevel || !rel) return new Set<Level>();
    const hit = (n: string) => n === selName || rel.down.has(n);
    return new Set(selLevel.children.filter(([j]) => hit(j.name)).flatMap(([, c]) => (c ? allLevels(c) : [])));
  }, [selLevel, selName, rel]);
  const relOf = (l: Level, n: string): Rel =>
    !rel ? '' : downLevels.has(l) ? 'down' : l !== selLevel ? 'dim' : n === selName ? 'sel' : rel.up.has(n) ? 'up' : rel.down.has(n) ? 'down' : 'dim';
  const inChain = (l: Level, n: string) => l === selLevel && (n === selName || !!rel?.up.has(n) || !!rel?.down.has(n));

  if (!root.visible.length) return <div className="empty">No jobs to show.</div>;
  if (!pos || pos.key !== key) return <div className="empty">Laying out…</div>;

  const nodes: (JobNode | GroupNode)[] = [];
  const edges: Edge[] = [];
  const emit = (l: Level, parentId?: string) => {
    const jobs = new Map(l.result.jobs.map((j) => [j.name, j]));
    for (const n of l.visible) {
      const id = l.prefix + n;
      const b = pos.pos[id];
      nodes.push({
        id, type: 'job', position: { x: b?.x ?? 0, y: b?.y ?? 0 }, ...(parentId && { parentId }),
        data: { job: jobs.get(n)!, rel: relOf(l, n) }, selected: id === selected, connectable: false,
      });
    }
    for (const e of l.edges) {
      if (!showStage && e.kind === 'stage') continue;
      const hot = !!rel && inChain(l, e.from) && inChain(l, e.to) && e.kind !== 'missing';
      const color = e.kind === 'missing' ? 'var(--bad)' : hot ? 'var(--accent)' : 'var(--muted)';
      const notes = [e.kind === 'missing' && 'excluded by rules', e.optional && 'optional', e.artifacts === false && 'no artifacts'].filter(Boolean);
      edges.push({
        id: `${l.prefix}${e.kind}:${e.from}>${e.to}`, source: l.prefix + e.from, target: l.prefix + e.to,
        label: notes.join(', ') || undefined, labelStyle: { fontSize: 10, fill: color }, labelBgStyle: { fill: 'var(--panel)' },
        style: { stroke: color, strokeWidth: hot ? 2.5 : 1.2, strokeDasharray: e.kind === 'needs' ? undefined : '5 4', opacity: rel && !hot && e.kind !== 'missing' ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      });
    }
    for (const [j, c] of l.children) {
      const id = l.prefix + j.name + CHILD;
      const b = pos.pos[id] ?? { x: 0, y: 0, width: W, height: 40 };
      const d = j.downstream!;
      nodes.push({
        id, type: 'pipeline', position: { x: b.x, y: b.y }, ...(parentId && { parentId }),
        style: { width: b.width, height: b.height }, selectable: false, connectable: false,
        data: { title: j.name, created: !!c, reason: d.error ?? d.result?.errors[0] ?? d.result?.workflow.reason ?? '' },
      });
      const hotChild = !!c && downLevels.has(c);
      edges.push({
        id: `${id}>`, source: l.prefix + j.name, target: id,
        style: { stroke: 'var(--w-child)', strokeWidth: hotChild ? 2.5 : 1.5, strokeDasharray: '2 3', opacity: rel && !hotChild ? 0.25 : 1 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--w-child)', width: 14, height: 14 },
      });
      if (c) emit(c, id);
    }
  };
  emit(root);

  return (
    <div className="graph-wrap">
      <div className="graph-legend small muted">
        <span><i className="lg solid" /> needs</span>
        <label className="check"><input type="checkbox" checked={showStage} onChange={(e) => setShowStage(e.target.checked)} /><i className="lg dash" /> stage order (no <code>needs</code>)</label>
        <span><i className="lg miss" /> need on excluded job</span>
        {levels.length > 1 && <span><i className="lg child" /> child pipeline</span>}
        <span className="spacer" />
        {hidden > 0 && <span>{hidden} excluded job(s) hidden ·</span>}
        <span>click a job to trace its chain</span>
      </div>
      <ReactFlow
        key={key}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={dark ? 'dark' : 'light'}
        fitView
        fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        minZoom={0.1}
        nodesConnectable={false}
        onNodeClick={(_, n) => { if (n.type === 'job') onSelect(n.id); }}
        onPaneClick={() => onSelect(undefined)}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
