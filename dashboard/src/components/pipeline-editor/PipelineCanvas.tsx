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
  onEdgeClick?: (from: string, to: string) => void;
  onDocumentInputEdgeClick?: () => void;
}

/**
 * Layout nodes using dagre for proper DAG positioning.
 * Avoids edge crossings and node overlaps.
 */
function layoutNodes(
  steps: PipelineStep[],
  selectedNodeId: string | null,
  edges?: PipelineEdge[],
  documentInput?: DocumentInputData,
): Node[] {
  const dagre = require("@dagrejs/dagre");
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 120, marginx: 40, marginy: 40 });

  // Add document input node
  g.setNode("__document_input__", { width: 200, height: 60 });

  // Add step nodes
  for (const step of steps) {
    g.setNode(step.id, { width: 220, height: 120 });
  }

  // Add edges — document input to entry step
  if (steps.length > 0 && edges) {
    const withIncoming = new Set(edges.map(e => e.to));
    const entryId = steps.find(s => !withIncoming.has(s.id))?.id || steps[0]?.id;
    if (entryId) g.setEdge("__document_input__", entryId);
  } else if (steps.length > 0) {
    g.setEdge("__document_input__", steps[0]!.id);
  }

  // Add pipeline edges
  for (const e of edges || []) {
    g.setEdge(e.from, e.to);
  }

  // Run dagre layout
  dagre.layout(g);

  // Build document input node
  const docPos = g.node("__document_input__");
  const docInputNode: Node = {
    id: "__document_input__",
    type: "documentInput",
    position: { x: (docPos?.x ?? 275) - 100, y: (docPos?.y ?? 0) - 30 },
    draggable: false,
    selectable: false,
    deletable: false,
    data: (documentInput ?? {}) as Record<string, unknown>,
  };

  // Build step nodes from dagre positions
  const stepNodes = steps.map((step) => {
    const pos = g.node(step.id);
    return {
      id: step.id,
      type: "step",
      position: { x: (pos?.x ?? 250) - 110, y: (pos?.y ?? 0) - 60 },
      data: {
        ...step,
        label: step.id,
        stepId: step.id,
        selected: step.id === selectedNodeId,
      },
    };
  });

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
        fontSize: 10,
        fill: state?.matched ? "#C33520" : state?.evaluated ? "#D4CFC5" : "#3A3328",
        fontWeight: state?.matched ? 600 : 400,
      },
      labelShowBg: true,
      labelBgStyle: {
        fill: "#FAF7F0",
        fillOpacity: 0.9,
        rx: 3,
        ry: 3,
      },
      labelBgPadding: [4, 6] as [number, number],
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
  onEdgeClick,
  onDocumentInputEdgeClick,
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

  // Rebuild flow edges whenever pipeline edges, edge states, or steps change.
  // The document input edge always targets the current entry step.
  useEffect(() => {
    const flowEdges = toFlowEdges(pipelineEdges, edgeStates);
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
    setEdges(flowEdges);
  }, [pipelineEdges, edgeStates, steps, setEdges]);

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

  // Allow dragging edge endpoints to different nodes
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: { source: string | null; target: string | null }) => {
      if (!newConnection.source || !newConnection.target) return;
      // Update the pipeline edge
      const updatedEdges = pipelineEdges.map(e => {
        if (e.from === oldEdge.source && e.to === oldEdge.target) {
          return { ...e, from: newConnection.source!, to: newConnection.target! };
        }
        return e;
      });
      onEdgesChange(updatedEdges);
    },
    [pipelineEdges, onEdgesChange],
  );

  const onEdgeClickHandler = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      // Document input edge clicked — show help tooltip
      if (edge.id === "e-__document_input__-entry") {
        onDocumentInputEdgeClick?.();
        return;
      }
      // Find the pipeline edge by source/target
      const pEdge = pipelineEdges.find(e => edge.source === e.from && edge.target === e.to);
      if (pEdge && onEdgeClick) {
        onEdgeClick(pEdge.from, pEdge.to);
      }
    },
    [onEdgeClick, onDocumentInputEdgeClick, pipelineEdges],
  );

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
        onReconnect={onReconnect}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClickHandler}
        onPaneClick={onPaneClick}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        nodeTypes={nodeTypes}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={!readOnly}
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
