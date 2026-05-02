"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PipelineCanvas, type PipelineEdge, type NodeState, type EdgeState, type DocumentInputData } from "@/components/pipeline-editor/PipelineCanvas";
import { Toolbar } from "@/components/pipeline-editor/Toolbar";
import {
  StepConfigPanel,
  type PipelineStep,
} from "@/components/pipeline-editor/StepConfigPanel";
import { YamlView } from "@/components/pipeline-editor/YamlView";
import { AddStepModal } from "@/components/pipeline-editor/AddStepModal";
import { TestModeControls } from "@/components/pipeline-editor/TestModeControls";
import { TestResultsPanel, type StepTestResult } from "@/components/pipeline-editor/TestResultsPanel";
import { EdgeConditionPanel } from "@/components/pipeline-editor/EdgeConditionPanel";
import { api, pipelines as pipelinesApi, schemas as schemasApi, type PipelineDetail, type SchemaRow } from "@/lib/api";
import { useApi } from "@/lib/use-api";

// ── YAML <-> editor state conversion ──

interface PipelineGraph {
  steps: PipelineStep[];
  edges: PipelineEdge[];
}

/**
 * Parse the pipeline YAML source into steps and edges.
 * The YAML format is the Koji pipeline DSL:
 *
 * ```yaml
 * steps:
 *   - id: classify_doc
 *     type: classify
 *     config:
 *       question: "What type of document is this?"
 *     routes:
 *       - when: "insurance"
 *         goto: extract_insurance
 *       - default: true
 *         goto: tag_skip
 *   - id: extract_insurance
 *     type: extract
 *     config:
 *       schema: commercial_policy
 * ```
 */
function parseGraph(yamlSource: string): PipelineGraph {
  const steps: PipelineStep[] = [];
  const edges: PipelineEdge[] = [];

  if (!yamlSource || !yamlSource.trim()) {
    return { steps, edges };
  }

  try {
    const doc = parseYaml(yamlSource);
    if (!doc || !doc.steps) {
      return { steps, edges };
    }

    for (const raw of doc.steps) {
      const step: PipelineStep = {
        id: raw.id || `step_${Math.random().toString(36).slice(2, 6)}`,
        type: raw.type || "transform",
        config: { ...raw },
      };
      // Remove non-config keys from config
      delete (step.config as Record<string, unknown>).id;
      delete (step.config as Record<string, unknown>).type;
      delete (step.config as Record<string, unknown>).routes;
      delete (step.config as Record<string, unknown>).next;

      // If there's a nested config object, merge it up
      if (raw.config && typeof raw.config === "object") {
        step.config = { ...raw.config };
      }

      steps.push(step);

      // Parse routes (conditional edges)
      if (Array.isArray(raw.routes)) {
        for (const route of raw.routes) {
          if (route.goto) {
            edges.push({
              from: step.id,
              to: route.goto,
              when: route.when || undefined,
              default: route.default || false,
            });
          }
        }
      }
      // Parse simple "next" edge
      if (raw.next && typeof raw.next === "string") {
        edges.push({ from: step.id, to: raw.next });
      }
    }

    // If no explicit edges, create implicit sequential edges
    if (edges.length === 0 && steps.length > 1) {
      for (let i = 0; i < steps.length - 1; i++) {
        edges.push({ from: steps[i]!.id, to: steps[i + 1]!.id });
      }
    }
  } catch {
    // If YAML is malformed, return empty
  }

  return { steps, edges };
}

/**
 * Convert steps and edges back to YAML.
 */
function toYaml(steps: PipelineStep[], edges: PipelineEdge[]): string {
  const edgesBySource = new Map<string, PipelineEdge[]>();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.from) || [];
    list.push(edge);
    edgesBySource.set(edge.from, list);
  }

  const yamlSteps = steps.map((step) => {
    const entry: Record<string, unknown> = {
      id: step.id,
      type: step.type,
    };

    if (step.config && Object.keys(step.config).length > 0) {
      entry.config = step.config;
    }

    const stepEdges = edgesBySource.get(step.id) || [];
    if (stepEdges.length === 1 && !stepEdges[0]!.when && !stepEdges[0]!.default) {
      entry.next = stepEdges[0]!.to;
    } else if (stepEdges.length > 0) {
      entry.routes = stepEdges.map((e) => {
        const route: Record<string, unknown> = { goto: e.to };
        if (e.when) route.when = e.when;
        if (e.default) route.default = true;
        return route;
      });
    }

    return entry;
  });

  return stringifyYaml({ steps: yamlSteps }, { indent: 2 });
}

// ── Main editor page ──

export default function PipelineEditorPage() {
  const params = useParams<{ tenantSlug: string; pipelineSlug: string }>();
  const router = useRouter();
  const tenantSlug = params?.tenantSlug ?? "";
  const pipelineSlug = params?.pipelineSlug ?? "";

  const {
    data: pipeline,
    loading,
    error,
  } = useApi(
    useCallback(() => pipelinesApi.get(pipelineSlug), [pipelineSlug]),
  );

  // Fetch available schemas for the extract step config dropdown
  const { data: schemasList } = useApi(
    useCallback(() => schemasApi.list(), []),
  );

  // Parse YAML into graph state once pipeline loads.
  // If the pipeline has no yamlSource but has a deployed schema,
  // generate a default single-step extract graph so the editor
  // isn't empty.
  const initialGraph = useMemo(() => {
    if (!pipeline) return { steps: [], edges: [] };

    // If there's YAML, parse it
    if (pipeline.yamlSource && pipeline.yamlSource.trim()) {
      return parseGraph(pipeline.yamlSource);
    }

    // Simple pipeline with a deployed schema — show as a single extract node
    if (pipeline.schemaSlug || pipeline.schemaId) {
      return {
        steps: [{
          id: "extract",
          type: "extract",
          config: {
            schema: pipeline.schemaSlug || pipeline.schemaId || "",
          },
        }],
        edges: [],
      };
    }

    return { steps: [], edges: [] };
  }, [pipeline]);

  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [edges, setEdges] = useState<PipelineEdge[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [showYaml, setShowYaml] = useState(false);
  const [showAddStep, setShowAddStep] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [costEstimate] = useState<number | null>(null);
  const [validationMsg, setValidationMsg] = useState<string | null>(null);

  // Test mode state
  const [testMode, setTestMode] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResults, setTestResults] = useState<StepTestResult[]>([]);
  const [nodeStates, setNodeStates] = useState<Map<string, NodeState>>(new Map());
  const [edgeStates, setEdgeStates] = useState<Map<string, EdgeState>>(new Map());
  const [testPath, setTestPath] = useState<string[]>([]);
  const [documentInput, setDocumentInput] = useState<DocumentInputData>({});
  const [selectedEdge, setSelectedEdge] = useState<PipelineEdge | null>(null);

  // Initialize from pipeline data
  if (pipeline && !initialized) {
    setSteps(initialGraph.steps);
    setEdges(initialGraph.edges);
    setInitialized(true);
  }

  const selectedStep = useMemo(
    () => steps.find((s) => s.id === selectedNode) ?? null,
    [steps, selectedNode],
  );

  const currentYaml = useMemo(() => toYaml(steps, edges), [steps, edges]);

  // ── Undo stack ──
  const undoStackRef = useRef<Array<{ steps: PipelineStep[]; edges: PipelineEdge[] }>>([]);
  const MAX_UNDO = 30;

  function pushUndo() {
    undoStackRef.current.push({ steps: structuredClone(steps), edges: structuredClone(edges) });
    if (undoStackRef.current.length > MAX_UNDO) undoStackRef.current.shift();
  }

  function handleUndo() {
    const prev = undoStackRef.current.pop();
    if (prev) {
      setSteps(prev.steps);
      setEdges(prev.edges);
      setDirty(true);
    }
  }

  // Listen for Ctrl+Z / Cmd+Z
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // ── Handlers ──

  function handleStepsChange(newSteps: PipelineStep[]) {
    pushUndo();
    setSteps(newSteps);
    setDirty(true);
  }

  function handleEdgesChange(newEdges: PipelineEdge[]) {
    pushUndo();
    setEdges(newEdges);
    setDirty(true);
  }

  function handleAddStep(type: string, id: string) {
    pushUndo();
    const newStep: PipelineStep = { id, type, config: {} };
    setSteps([...steps, newStep]);
    setDirty(true);
    setSelectedNode(id);
  }

  function handleUpdateStep(stepId: string, updates: Partial<PipelineStep>) {
    pushUndo();
    setSteps((prev) => {
      const idx = prev.findIndex((s) => s.id === stepId);
      if (idx === -1) return prev;

      const updated = { ...prev[idx]!, ...updates };

      // If ID changed, update edges too
      if (updates.id && updates.id !== stepId) {
        setEdges((prevEdges) =>
          prevEdges.map((e) => ({
            ...e,
            from: e.from === stepId ? updates.id! : e.from,
            to: e.to === stepId ? updates.id! : e.to,
          })),
        );
        setSelectedNode(updates.id);
      }

      const next = [...prev];
      next[idx] = updated;
      return next;
    });
    setDirty(true);
  }

  function handleDeleteStep(stepId: string) {
    pushUndo();
    setSteps((prev) => prev.filter((s) => s.id !== stepId));
    setEdges((prev) =>
      prev.filter((e) => e.from !== stepId && e.to !== stepId),
    );
    setSelectedNode(null);
    setDirty(true);
  }

  function handleEdgeClick(from: string, to: string) {
    const edge = edges.find(e => e.from === from && e.to === to);
    if (edge && !testMode) {
      setSelectedEdge(edge);
      setSelectedNode(null);
    }
  }

  function handleEdgeUpdate(from: string, to: string, updates: Partial<PipelineEdge>) {
    pushUndo();
    setEdges(prev => prev.map(e =>
      e.from === from && e.to === to ? { ...e, ...updates } : e
    ));
    setSelectedEdge(null);
    setDirty(true);
  }

  function handleEdgeDelete(from: string, to: string) {
    pushUndo();
    setEdges(prev => prev.filter(e => !(e.from === from && e.to === to)));
    setSelectedEdge(null);
    setDirty(true);
  }

  // Collect classify labels for the edge condition builder
  const classifyLabels = useMemo(() =>
    steps
      .filter(s => s.type === "classify" && s.config?.labels)
      .map(s => ({
        stepId: s.id,
        labels: (s.config.labels as Array<{ id: string }>).map(l => l.id),
      })),
    [steps]
  );

  function handleYamlChange(newYaml: string) {
    const graph = parseGraph(newYaml);
    setSteps(graph.steps);
    setEdges(graph.edges);
    setDirty(true);
    setShowYaml(false);
  }

  async function handleSave() {
    if (!pipeline || saving) return;
    setSaving(true);
    try {
      // Save as YAML to the pipeline's yamlSource field
      const yaml = toYaml(steps, edges);
      await api.patch(`/api/pipelines/${pipeline.slug}`, { yaml });
      setDirty(false);
    } catch (err) {
      setValidationMsg(
        err instanceof Error ? err.message : "Save failed",
      );
    } finally {
      setSaving(false);
    }
  }

  function handleValidate() {
    setValidationMsg(null);
    const errors: string[] = [];

    if (steps.length === 0) {
      errors.push("Pipeline has no steps.");
    }

    // Check for duplicate IDs
    const ids = new Set<string>();
    for (const step of steps) {
      if (ids.has(step.id)) {
        errors.push(`Duplicate step ID: ${step.id}`);
      }
      ids.add(step.id);
    }

    // Check edges reference valid steps
    for (const edge of edges) {
      if (!ids.has(edge.from)) {
        errors.push(`Edge references unknown source: ${edge.from}`);
      }
      if (!ids.has(edge.to)) {
        errors.push(`Edge references unknown target: ${edge.to}`);
      }
    }

    // Check for orphaned steps (no incoming or outgoing edges, and not the only step)
    if (steps.length > 1) {
      for (const step of steps) {
        const hasIn = edges.some((e) => e.to === step.id);
        const hasOut = edges.some((e) => e.from === step.id);
        if (!hasIn && !hasOut) {
          errors.push(`Step "${step.id}" is disconnected from the pipeline.`);
        }
      }
    }

    if (errors.length === 0) {
      setValidationMsg("Pipeline is valid.");
    } else {
      setValidationMsg(errors.join("\n"));
    }
  }

  function handleDeploy() {
    // Navigate to the pipeline detail page which has the deploy dialog
    router.push(`/t/${tenantSlug}/pipelines/${pipelineSlug}`);
  }

  // ── Test mode handlers ──

  function handleTestStart(filename?: string) {
    setTestRunning(true);
    setTestResults([]);
    setTestPath([]);
    setDocumentInput({ filename, parseStatus: "parsing" });
    const ns = new Map<string, NodeState>();
    for (const step of steps) {
      ns.set(step.id, { executionState: "waiting" });
    }
    setNodeStates(ns);
    setEdgeStates(new Map());
  }

  function handleStepEvent(event: { type: string; data: Record<string, unknown> }) {
    if (event.type === "step_start") {
      // First step_start means parse completed — update document input
      setDocumentInput(prev => prev.parseStatus === "parsing"
        ? { ...prev, parseStatus: "parsed" }
        : prev
      );
      setNodeStates(prev => {
        const next = new Map(prev);
        next.set(event.data.stepId as string, { executionState: "running" });
        return next;
      });
    }
    if (event.type === "step_complete") {
      const result = event.data as unknown as StepTestResult;
      setTestResults(prev => [...prev, result]);
      setTestPath(prev => [...prev, result.stepId]);
      setNodeStates(prev => {
        const next = new Map(prev);
        next.set(result.stepId, {
          executionState: result.status === "completed" ? "completed" : "failed",
          output: result.output,
          durationMs: result.durationMs,
          costUsd: result.costUsd,
        });
        return next;
      });
      if (result.edgeEvaluations) {
        setEdgeStates(prev => {
          const next = new Map(prev);
          for (const edge of result.edgeEvaluations) {
            next.set(`e-${result.stepId}-${edge.to}`, { matched: edge.matched, evaluated: true });
          }
          return next;
        });
      }
    }
  }

  function handleTestComplete(data: Record<string, unknown>) {
    setTestRunning(false);
    // Update document input with final info
    const docInfo = data.documentInfo as { filename?: string; pageCount?: number } | undefined;
    if (docInfo) {
      setDocumentInput(prev => ({
        ...prev,
        filename: docInfo.filename,
        pageCount: docInfo.pageCount,
        parseStatus: "parsed" as const,
      }));
    }
    const skipped = (data.skippedSteps as string[]) || [];
    setNodeStates(prev => {
      const next = new Map(prev);
      for (const stepId of skipped) {
        next.set(stepId, { executionState: "skipped" });
      }
      return next;
    });
  }

  function handleTestReset() {
    setTestRunning(false);
    setTestResults([]);
    setNodeStates(new Map());
    setEdgeStates(new Map());
    setTestPath([]);
    setDocumentInput({});
  }

  // ── Render ──

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4" style={{ background: "#FAF7F0" }}>
        <p className="text-[13px] text-[#C33520]">
          {error.message.includes("not found") ? "Pipeline not found" : error.message}
        </p>
        <Link
          href={`/t/${tenantSlug}/pipelines`}
          className="text-[12px] font-medium text-[#3A3328] border border-[#E8E0D0] px-3 py-1.5 rounded hover:border-[#3A3328] transition-colors no-underline"
        >
          Back to pipelines
        </Link>
      </div>
    );
  }

  if (!pipeline || loading || !initialized) {
    return (
      <div
        className="flex items-center justify-center h-screen"
        style={{
          background: "#FAF7F0",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: "11px",
          color: "#8A847B",
        }}
      >
        Loading pipeline...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen" style={{ background: "#FAF7F0" }}>
      {/* Edit / Test toggle */}
      <div className="flex items-center gap-2 px-5 py-2" style={{ background: "#F4EEE2", borderBottom: "1px solid #E8E0D0" }}>
        <button
          onClick={() => { setTestMode(false); handleTestReset(); }}
          style={{
            padding: "4px 14px",
            fontSize: "12px",
            fontWeight: 500,
            borderRadius: "4px",
            border: "none",
            cursor: "pointer",
            background: !testMode ? "#171410" : "transparent",
            color: !testMode ? "#F4EEE2" : "#3A3328",
            fontFamily: "'Instrument Sans', sans-serif",
          }}
        >
          Edit
        </button>
        <button
          onClick={() => setTestMode(true)}
          style={{
            padding: "4px 14px",
            fontSize: "12px",
            fontWeight: 500,
            borderRadius: "4px",
            border: "none",
            cursor: "pointer",
            background: testMode ? "#C33520" : "transparent",
            color: testMode ? "#F4EEE2" : "#3A3328",
            fontFamily: "'Instrument Sans', sans-serif",
          }}
        >
          Test
        </button>
      </div>

      {!testMode ? (
        <Toolbar
          pipelineName={pipeline.displayName}
          costEstimate={costEstimate}
          onAddStep={() => setShowAddStep(true)}
          onValidate={handleValidate}
          onDeploy={handleDeploy}
          onToggleYaml={() => setShowYaml(!showYaml)}
          showYaml={showYaml}
          stepCount={steps.length}
          dirty={dirty}
          onSave={handleSave}
          saving={saving}
        />
      ) : null}

      {testMode ? (
        <TestModeControls
          pipelineSlug={pipelineSlug}
          onTestStart={handleTestStart}
          onStepEvent={handleStepEvent}
          onTestComplete={handleTestComplete}
          onTestError={(err) => setValidationMsg(err)}
          onReset={handleTestReset}
          isRunning={testRunning}
          completedStepCount={testResults.length}
          totalStepCount={steps.length}
          totalDurationMs={testResults.reduce((a, r) => a + r.durationMs, 0)}
          totalCostUsd={testResults.reduce((a, r) => a + r.costUsd, 0)}
          path={testPath}
        />
      ) : null}

      {/* Validation message bar */}
      {validationMsg && (
        <div
          className="px-5 py-2 text-[12px] border-b border-[#E8E0D0] flex items-center justify-between"
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            background: validationMsg.startsWith("Pipeline is valid")
              ? "rgba(45, 138, 78, 0.06)"
              : "rgba(195, 53, 32, 0.06)",
            color: validationMsg.startsWith("Pipeline is valid")
              ? "#2D8A4E"
              : "#C33520",
            whiteSpace: "pre-wrap",
          }}
        >
          <span>{validationMsg}</span>
          <button
            onClick={() => setValidationMsg(null)}
            className="text-[#8A847B] hover:text-[#171410] bg-transparent border-none cursor-pointer text-[14px] ml-4 shrink-0"
          >
            x
          </button>
        </div>
      )}

      {/* Canvas + config panel */}
      <div className="flex-1 relative overflow-hidden">
        <PipelineCanvas
          steps={steps}
          edges={edges}
          onStepsChange={handleStepsChange}
          onEdgesChange={handleEdgesChange}
          onNodeSelect={setSelectedNode}
          selectedNodeId={selectedNode}
          nodeStates={testMode ? nodeStates : undefined}
          edgeStates={testMode ? edgeStates : undefined}
          readOnly={testMode}
          documentInput={documentInput}
          onEdgeClick={handleEdgeClick}
          onDocumentInputEdgeClick={() => setValidationMsg(
            "This edge automatically connects to the first step in the pipeline (the entry point). " +
            "To change which step runs first, add a new step and connect it to the current first step — " +
            "the document input will follow automatically."
          )}
        />

        {/* Config panel */}
        {testMode && selectedNode && testResults.find(r => r.stepId === selectedNode) ? (
          <TestResultsPanel
            result={testResults.find(r => r.stepId === selectedNode)!}
            onClose={() => setSelectedNode(null)}
          />
        ) : !testMode && selectedStep ? (
          <StepConfigPanel
            step={selectedStep}
            onUpdate={handleUpdateStep}
            onClose={() => setSelectedNode(null)}
            onDelete={handleDeleteStep}
            schemas={schemasList ?? []}
          />
        ) : !testMode && selectedEdge ? (
          <EdgeConditionPanel
            edge={selectedEdge}
            onUpdate={handleEdgeUpdate}
            onClose={() => setSelectedEdge(null)}
            onDelete={handleEdgeDelete}
            classifyLabels={classifyLabels}
          />
        ) : null}

        {/* YAML view overlay */}
        {showYaml && (
          <YamlView
            yaml={currentYaml}
            onChange={handleYamlChange}
            onClose={() => setShowYaml(false)}
          />
        )}
      </div>

      {/* Add step modal */}
      {showAddStep && (
        <AddStepModal
          onAdd={handleAddStep}
          onClose={() => setShowAddStep(false)}
        />
      )}
    </div>
  );
}
