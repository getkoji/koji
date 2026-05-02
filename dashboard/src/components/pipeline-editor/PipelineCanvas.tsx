"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  type Node,
  type Edge,
  type OnConnect,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { StepNode, type ExecutionState } from "./StepNode";
import { DocumentInputNode } from "./DocumentInputNode";
import type { PipelineStep } from "./StepConfigPanel";

const nodeTypes: NodeTypes = {
  step: StepNode,
  documentInput: DocumentInputNode,
};

export interface PipelineEdge {
  from: string;
  to: string;
  when?: string;
  default?: boolean;
}

export interface EdgeState {
  matched: boolean;
  evaluated: boolean;
}

export interface NodeState {
  executionState: ExecutionState;
  output?: Record<string, unknown>;
  durationMs?: number;
  costUsd?: number;
}

export interface DocumentInputData {
  filename?: string;
  pageCount?: number;
  parseDurationMs?: number;
  parseStatus?: "idle" | "parsing" | "parsed" | "failed";
}

interface PipelineCanvasProps {
  steps: PipelineStep[];
  edges: PipelineEdge[];
  onStepsChange: (steps: PipelineStep[]) => void;
  onEdgesChange: (edges: PipelineEdge[]) => void;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
  nodeStates?: Map<string, NodeState>;
  edgeStates?: Map<string, EdgeState>;
  readOnly?: boolean;
  documentInput?: DocumentInputData;
}

/**
 * Auto-layout: arrange nodes vertically, centering them on the X axis.
 * For steps that have multiple incoming edges (branches), space them
 * out horizontally.
 */
/**
 * Layout nodes in topological order (entry step at top, follow edges down).
 * Falls back to array order if no edges exist.
 */
function layoutNodes(
  steps: PipelineStep[],
  selectedNodeId: string | null,
  edges?: PipelineEdge[],
  documentInput?: DocumentInputData,
): Node[] {
  // Topological sort: entry step first, then follow edges
  let ordered = steps;
  if (edges && edges.length > 0) {
    const incomingCount = new Map<string, number>();
    const outgoing = new Map<string, string[]>();
    for (const s of steps) {
      incomingCount.set(s.id, 0);
      outgoing.set(s.id, []);
    }
    for (const e of edges) {
      incomingCount.set(e.to, (incomingCount.get(e.to) ?? 0) + 1);
      outgoing.get(e.from)?.push(e.to);
    }
    // Kahn's algorithm
    const queue = steps.filter((s) => (incomingCount.get(s.id) ?? 0) === 0).map((s) => s.id);
    const sorted: string[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(id);
      for (const next of outgoing.get(id) ?? []) {
        const count = (incomingCount.get(next) ?? 1) - 1;
        incomingCount.set(next, count);
        if (count === 0) queue.push(next);
      }
    }
    // Add any steps not reached by edges (disconnected)
    for (const s of steps) {
      if (!sorted.includes(s.id)) sorted.push(s.id);
    }
    ordered = sorted.map((id) => steps.find((s) => s.id === id)!).filter(Boolean);
  }

  // Document input node at the top, then steps below it
  const docInputNode: Node = {
    id: "__document_input__",
    type: "documentInput",
    position: { x: 275, y: 0 },
    draggable: false,
    selectable: false,
    deletable: false,
    data: (documentInput ?? {}) as Record<string, unknown>,
  };

  const stepNodes = ordered.map((step, i) => ({
    id: step.id,
    type: "step",
    position: { x: 250, y: (i + 1) * 150 },  // offset by 1 for document input
    data: {
      ...step,
      label: step.id,
      stepId: step.id,
      selected: step.id === selectedNodeId,
    },
  }));

  return [docInputNode, ...stepNodes];
}

function toFlowEdges(pipelineEdges: PipelineEdge[], edgeStates?: Map<string, EdgeState>): Edge[] {
  return pipelineEdges.map((edge) => {
    const edgeId = `e-${edge.from}-${edge.to}`;
    const state = edgeStates?.get(edgeId);

    let stroke = edge.default ? "#8A847B" : "#C33520";
    let strokeWidth = 2;
    let opacity = 1;
    let animated = false;
    let strokeDasharray: string | undefined;

    if (state) {
      if (state.matched) {
        stroke = "#C33520";
        strokeWidth = 3;
        animated = true;
      } else if (state.evaluated) {
        stroke = "#D4CFC5";
        strokeWidth = 1;
        opacity = 0.5;
        strokeDasharray = "5,5";
      }
    }

    return {
      id: edgeId,
      source: edge.from,
      target: edge.to,
      label: edge.when || (edge.default ? "default" : undefined),
      animated,
      selectable: true,
      interactionWidth: 20,
      focusable: true,
      className: "koji-edge",
      style: { stroke, strokeWidth, opacity, strokeDasharray },
      labelStyle: {
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 11,
        fill: state?.matched ? "#C33520" : state?.evaluated ? "#D4CFC5" : "#3A3328",
        fontWeight: state?.matched ? 600 : 400,
      },
    };
  });
}

export function PipelineCanvas({
  steps,
  edges: pipelineEdges,
  onStepsChange,
  onEdgesChange,
  onNodeSelect,
  selectedNodeId,
  nodeStates,
  edgeStates,
  readOnly,
  documentInput,
}: PipelineCanvasProps) {
  const initialNodes = useMemo(() => {
    const nodes = layoutNodes(steps, selectedNodeId, pipelineEdges, documentInput);
    if (nodeStates) {
      return nodes.map((n) => {
        const state = nodeStates.get(n.id);
        if (state) {
          return {
            ...n,
            data: {
              ...n.data,
              executionState: state.executionState,
              executionOutput: state.output,
              executionDuration: state.durationMs,
              executionCost: state.costUsd,
            },
          };
        }
        return {
          ...n,
          data: { ...n.data, executionState: nodeStates.size > 0 ? "waiting" : "idle" },
        };
      });
    }
    return nodes;
  }, [steps, selectedNodeId, nodeStates]);
  const initialFlowEdges = useMemo(() => {
    const flowEdges = toFlowEdges(pipelineEdges, edgeStates);
    // Add edge from document input to the entry step (first step with no incoming edges)
    if (steps.length > 0) {
      const withIncoming = new Set(pipelineEdges.map(e => e.to));
      const entryStepId = steps.find(s => !withIncoming.has(s.id))?.id || steps[0]?.id;
      if (entryStepId) {
        flowEdges.unshift({
          id: "e-__document_input__-entry",
          source: "__document_input__",
          target: entryStepId,
          animated: false,
          selectable: false,
          deletable: false,
          style: { stroke: "#D4CFC5", strokeWidth: 1, strokeDasharray: "4,4" },
        });
      }
    }
    return flowEdges;
  }, [pipelineEdges, edgeStates, steps]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initialFlowEdges);

  // Keep flow nodes in sync with step changes from outside (add/remove/update)
  const prevStepsRef = useRef(steps);
  const prevNodeStatesRef = useRef(nodeStates);
  useEffect(() => {
    if (prevStepsRef.current !== steps || prevNodeStatesRef.current !== nodeStates) {
      prevStepsRef.current = steps;
      prevNodeStatesRef.current = nodeStates;
      const nodes = layoutNodes(steps, selectedNodeId, pipelineEdges, documentInput);
      if (nodeStates) {
        setNodes(
          nodes.map((n) => {
            const state = nodeStates.get(n.id);
            if (state) {
              return {
                ...n,
                data: {
                  ...n.data,
                  executionState: state.executionState,
                  executionOutput: state.output,
                  executionDuration: state.durationMs,
                  executionCost: state.costUsd,
                },
              };
            }
            return {
              ...n,
              data: { ...n.data, executionState: nodeStates.size > 0 ? "waiting" : "idle" },
            };
          }),
        );
      } else {
        setNodes(nodes);
      }
    }
  }, [steps, selectedNodeId, nodeStates, setNodes]);

  const prevEdgesRef = useRef(pipelineEdges);
  const prevEdgeStatesRef = useRef(edgeStates);
  useEffect(() => {
    if (prevEdgesRef.current !== pipelineEdges || prevEdgeStatesRef.current !== edgeStates) {
      prevEdgesRef.current = pipelineEdges;
      prevEdgeStatesRef.current = edgeStates;
      setEdges(toFlowEdges(pipelineEdges, edgeStates));
    }
  }, [pipelineEdges, edgeStates, setEdges]);

  // Propagate node position changes back (for drag repositioning)
  const onNodesChangeWrapped = useCallback(
    (changes: Parameters<typeof onNodesChange>[0]) => {
      onNodesChange(changes);
    },
    [onNodesChange],
  );

  const onConnect: OnConnect = useCallback(
    (params) => {
      setEdges((eds) =>
        addEdge(
          { ...params, style: { stroke: "#C33520", strokeWidth: 2 } },
          eds,
        ),
      );
      // Propagate new edge back
      if (params.source && params.target) {
        onEdgesChange([
          ...pipelineEdges,
          { from: params.source, to: params.target },
        ]);
      }
    },
    [setEdges, pipelineEdges, onEdgesChange],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeSelect(node.id);
    },
    [onNodeSelect],
  );

  const onPaneClick = useCallback(() => {
    onNodeSelect(null);
  }, [onNodeSelect]);

  // Propagate node deletions
  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      const deletedIds = new Set(deleted.map((n) => n.id));
      const remainingSteps = steps.filter((s) => !deletedIds.has(s.id));
      const remainingEdges = pipelineEdges.filter(
        (e) => !deletedIds.has(e.from) && !deletedIds.has(e.to),
      );
      onStepsChange(remainingSteps);
      onEdgesChange(remainingEdges);
    },
    [steps, pipelineEdges, onStepsChange, onEdgesChange],
  );

  // Propagate edge deletions
  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      const deletedIds = new Set(deleted.map((e) => e.id));
      const remaining = pipelineEdges.filter(
        (e) => !deletedIds.has(`e-${e.from}-${e.to}`),
      );
      onEdgesChange(remaining);
    },
    [pipelineEdges, onEdgesChange],
  );

  return (
    <div className="w-full h-full" style={{ background: "#FAF7F0" }}>
      <style>{`
        .react-flow__edge.selected .react-flow__edge-path,
        .react-flow__edge:focus .react-flow__edge-path,
        .react-flow__edge:focus-visible .react-flow__edge-path {
          stroke: #C33520 !important;
          stroke-width: 4px !important;
          filter: drop-shadow(0 0 4px rgba(195, 53, 32, 0.4));
        }
        .react-flow__edge:hover .react-flow__edge-path {
          stroke-width: 3px !important;
          cursor: pointer;
        }
        .react-flow__edge.selected .react-flow__edge-text,
        .react-flow__edge:focus .react-flow__edge-text {
          fill: #C33520 !important;
          font-weight: 600 !important;
        }
        @keyframes koji-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(195, 53, 32, 0.4); }
          50% { box-shadow: 0 0 0 8px rgba(195, 53, 32, 0); }
        }
        .koji-node-running {
          animation: koji-pulse 1.5s ease-in-out infinite;
        }
      `}</style>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChangeWrapped}
        onEdgesChange={onEdgesChangeInternal}
        onConnect={onConnect}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        nodeTypes={nodeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        elementsSelectable={!readOnly}
        fitView
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={readOnly ? [] : ["Delete", "Backspace"]}
      >
        <Background color="#E8E0D0" gap={20} />
        <Controls
          style={{
            background: "#F4EEE2",
            border: "1px solid #E8E0D0",
            borderRadius: "4px",
          }}
        />
        <MiniMap
          style={{
            background: "#F4EEE2",
            border: "1px solid #E8E0D0",
          }}
          nodeColor="#C33520"
        />
      </ReactFlow>
    </div>
  );
}
