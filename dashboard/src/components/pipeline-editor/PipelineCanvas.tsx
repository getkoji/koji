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
import { StepNode } from "./StepNode";
import type { PipelineStep } from "./StepConfigPanel";

const nodeTypes: NodeTypes = {
  step: StepNode,
};

export interface PipelineEdge {
  from: string;
  to: string;
  when?: string;
  default?: boolean;
}

interface PipelineCanvasProps {
  steps: PipelineStep[];
  edges: PipelineEdge[];
  onStepsChange: (steps: PipelineStep[]) => void;
  onEdgesChange: (edges: PipelineEdge[]) => void;
  onNodeSelect: (nodeId: string | null) => void;
  selectedNodeId: string | null;
}

/**
 * Auto-layout: arrange nodes vertically, centering them on the X axis.
 * For steps that have multiple incoming edges (branches), space them
 * out horizontally.
 */
function layoutNodes(steps: PipelineStep[], selectedNodeId: string | null): Node[] {
  return steps.map((step, i) => ({
    id: step.id,
    type: "step",
    position: { x: 250, y: i * 150 },
    data: {
      ...step,
      label: step.id,
      stepId: step.id,
      selected: step.id === selectedNodeId,
    },
  }));
}

function toFlowEdges(pipelineEdges: PipelineEdge[]): Edge[] {
  return pipelineEdges.map((edge) => ({
    id: `e-${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    label: edge.when || (edge.default ? "default" : undefined),
    animated: false,
    style: {
      stroke: edge.default ? "#8A847B" : "#C33520",
      strokeWidth: 2,
    },
    labelStyle: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      fill: "#3A3328",
    },
  }));
}

export function PipelineCanvas({
  steps,
  edges: pipelineEdges,
  onStepsChange,
  onEdgesChange,
  onNodeSelect,
  selectedNodeId,
}: PipelineCanvasProps) {
  const initialNodes = useMemo(
    () => layoutNodes(steps, selectedNodeId),
    [steps, selectedNodeId],
  );
  const initialFlowEdges = useMemo(
    () => toFlowEdges(pipelineEdges),
    [pipelineEdges],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChangeInternal] = useEdgesState(initialFlowEdges);

  // Keep flow nodes in sync with step changes from outside (add/remove/update)
  const prevStepsRef = useRef(steps);
  useEffect(() => {
    if (prevStepsRef.current !== steps) {
      prevStepsRef.current = steps;
      setNodes(layoutNodes(steps, selectedNodeId));
    }
  }, [steps, selectedNodeId, setNodes]);

  const prevEdgesRef = useRef(pipelineEdges);
  useEffect(() => {
    if (prevEdgesRef.current !== pipelineEdges) {
      prevEdgesRef.current = pipelineEdges;
      setEdges(toFlowEdges(pipelineEdges));
    }
  }, [pipelineEdges, setEdges]);

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
        fitView
        proOptions={{ hideAttribution: true }}
        deleteKeyCode="Delete"
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
