import { pipelineGraph, relatives, type GraphEdge, type JobResult, type PipelineResult } from '@gce/core';
import {
  Background, Controls, Handle, MarkerType, Position, ReactFlow,
  type Edge, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import { whenClass } from './PipelineView';

const W = 190;
const H = 46;

interface Props {
  result: PipelineResult;
  selected?: string;
  onSelect: (name: string | undefined) => void;
  dark: boolean;
}

type JobNode = Node<{ job: JobResult; rel: 'sel' | 'up' | 'down' | 'dim' | '' }, 'job'>;

function JobCard({ data }: NodeProps<JobNode>) {
  const j = data.job;
  return (
    <div className={`job gjob ${whenClass(j)} rel-${data.rel}`} style={{ width: W, height: H }}>
      <Handle type="target" position={Position.Left} className="ghandle" />
      <div className="job-name" title={j.name}>{j.name}</div>
      <div className="job-meta">
        <span className="badge">{j.included ? j.when : 'excluded'}</span>
        {j.blocking && <span className="badge block">blocking</span>}
        {j.trigger && <span className="badge soft">trigger</span>}
        <span className="muted small">{j.stage}</span>
      </div>
      <Handle type="source" position={Position.Right} className="ghandle" />
    </div>
  );
}
const nodeTypes = { job: JobCard };

type Pos = Record<string, { x: number; y: number }>;

/** ELK layered layout, left → right by dependency depth. Loaded lazily (large bundle). */
async function layout(nodes: string[], edges: GraphEdge[]): Promise<Pos> {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  const g = await new ELK().layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '70',
      'elk.spacing.nodeNode': '14',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    },
    children: nodes.map((id) => ({ id, width: W, height: H })),
    edges: edges.map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  });
  return Object.fromEntries((g.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}

export function NeedsGraph({ result, selected, onSelect, dark }: Props) {
  const [showStage, setShowStage] = useState(true);
  const graph = useMemo(() => pipelineGraph(result), [result]);
  const jobs = useMemo(() => new Map(result.jobs.map((j) => [j.name, j])), [result]);
  // Graph = the created pipeline; excluded jobs only appear when something still needs them.
  const visible = useMemo(() => {
    const missing = new Set(graph.edges.filter((e) => e.kind === 'missing').map((e) => e.from));
    return graph.nodes.filter((n) => jobs.get(n)?.included || missing.has(n));
  }, [graph, jobs]);
  const hidden = graph.nodes.length - visible.length;
  const vEdges = useMemo(() => {
    const v = new Set(visible);
    return graph.edges.filter((e) => v.has(e.from) && v.has(e.to));
  }, [graph, visible]);

  // Layout depends only on structure, not on selection.
  const key = JSON.stringify([visible, vEdges.map((e) => [e.from, e.to])]);
  const [pos, setPos] = useState<{ key: string; pos: Pos }>();
  useEffect(() => {
    let live = true;
    void layout(visible, vEdges).then((p) => { if (live) setPos({ key, pos: p }); });
    return () => { live = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rel = useMemo(() => (selected && jobs.get(selected)?.included ? relatives(graph, selected) : undefined), [graph, jobs, selected]);
  const relOf = (n: string): JobNode['data']['rel'] =>
    !rel ? '' : n === selected ? 'sel' : rel.up.has(n) ? 'up' : rel.down.has(n) ? 'down' : 'dim';
  const inChain = (n: string) => n === selected || !!rel?.up.has(n) || !!rel?.down.has(n);

  if (!visible.length) return <div className="empty">No jobs to show.</div>;
  if (!pos || pos.key !== key) return <div className="empty">Laying out…</div>;

  const nodes: JobNode[] = visible.map((n) => ({
    id: n, type: 'job', position: pos.pos[n] ?? { x: 0, y: 0 },
    data: { job: jobs.get(n)!, rel: relOf(n) },
    selected: n === selected, connectable: false,
  }));
  const edges: Edge[] = vEdges
    .filter((e) => showStage || e.kind !== 'stage')
    .map((e, i) => {
      const hot = !!rel && inChain(e.from) && inChain(e.to) && e.kind !== 'missing';
      const color = e.kind === 'missing' ? 'var(--bad)' : hot ? 'var(--accent)' : 'var(--muted)';
      const notes = [e.kind === 'missing' && 'excluded by rules', e.optional && 'optional', e.artifacts === false && 'no artifacts'].filter(Boolean);
      return {
        id: `e${i}`, source: e.from, target: e.to,
        label: notes.join(', ') || undefined,
        labelStyle: { fontSize: 10, fill: color },
        labelBgStyle: { fill: 'var(--panel)' },
        style: {
          stroke: color, strokeWidth: hot ? 2.5 : 1.2,
          strokeDasharray: e.kind === 'needs' ? undefined : '5 4',
          opacity: rel && !hot && e.kind !== 'missing' ? 0.25 : 1,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      };
    });

  return (
    <div className="graph-wrap">
      <div className="graph-legend small muted">
        <span><i className="lg solid" /> needs</span>
        <label className="check"><input type="checkbox" checked={showStage} onChange={(e) => setShowStage(e.target.checked)} /><i className="lg dash" /> stage order (no <code>needs</code>)</label>
        <span><i className="lg miss" /> need on excluded job</span>
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
        onNodeClick={(_, n) => onSelect(n.id)}
        onPaneClick={() => onSelect(undefined)}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
