"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Save, Trash2, CheckCircle, Circle, MousePointer2, Play, Upload, Loader2, Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { parse as parseYaml } from "yaml";

type MappingType = "text" | "checkbox" | "checkbox_group" | "llm_interpret";
type ValueType = "string" | "number" | "currency" | "date" | "percentage" | "phone" | "email" | "enum";

interface FieldMapping {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How to read the field: text (default), checkbox, checkbox_group, llm_interpret */
  mapping_type: MappingType;
  /** How to normalize the extracted value */
  value_type: ValueType;
  sample_text: string;
  /** Optional label text to exclude from extraction */
  label?: string;
  /** For checkbox: value when checked */
  checked_value?: string;
  /** For checkbox: value when unchecked */
  unchecked_value?: string | null;
  /** For checkbox_group: array of options with their coordinates */
  options?: Array<{ x: number; y: number; w: number; h: number; value: string }>;
  /** For enum: allowed values */
  allowed_values?: string[];
  /** For llm_interpret: prompt to send to the LLM with the extracted text */
  llm_prompt?: string;
  /** For llm_interpret: which schema fields this region maps to */
  target_fields?: string[];
}

const VALUE_TYPES: { value: ValueType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "number", label: "Number" },
  { value: "currency", label: "Currency ($)" },
  { value: "date", label: "Date" },
  { value: "percentage", label: "Percentage (%)" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "enum", label: "Enum (pick list)" },
];

interface FormDetail {
  id: string;
  slug: string;
  displayName: string;
  mappingsJson: Record<string, FieldMapping>;
  sampleStorageKey: string | null;
  status: string;
  version: number;
}

// Colors for different field mappings
const FIELD_COLORS = [
  { bg: "rgba(195, 53, 32, 0.15)", border: "#C33520" },
  { bg: "rgba(37, 99, 235, 0.15)", border: "#2563eb" },
  { bg: "rgba(22, 163, 74, 0.15)", border: "#16a34a" },
  { bg: "rgba(202, 138, 4, 0.15)", border: "#ca8a04" },
  { bg: "rgba(147, 51, 234, 0.15)", border: "#9333ea" },
  { bg: "rgba(236, 72, 153, 0.15)", border: "#ec4899" },
  { bg: "rgba(20, 184, 166, 0.15)", border: "#14b8a6" },
  { bg: "rgba(249, 115, 22, 0.15)", border: "#f97316" },
];

export default function FormAnnotationPage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const formSlug = params.formSlug as string;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [drawing, setDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);
  const [drawRect, setDrawRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [pendingField, setPendingField] = useState<string | null>(null);
  const [pendingLabel, setPendingLabel] = useState<string>("");
  const [pendingMappingType, setPendingMappingType] = useState<MappingType>("text");
  const [pendingValueType, setPendingValueType] = useState<ValueType>("string");
  const [pendingCheckedValue, setPendingCheckedValue] = useState<string>("");
  const [pendingUncheckedValue, setPendingUncheckedValue] = useState<string>("");
  const [pendingLlmPrompt, setPendingLlmPrompt] = useState<string>("");
  const [pendingTargetFields, setPendingTargetFields] = useState<string[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<string, FieldMapping>>({});
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [formStatus, setFormStatus] = useState<string>("draft");
  const [drawMode, setDrawMode] = useState(false);
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ field: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [resizing, setResizing] = useState<{ field: string; handle: string; startX: number; startY: number; orig: { x: number; y: number; w: number; h: number } } | null>(null);
  const [mode, setMode] = useState<"annotate" | "test">("annotate");
  const [testFile, setTestFile] = useState<File | null>(null);
  const [testPdfDoc, setTestPdfDoc] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<{
    extracted?: Record<string, unknown>;
    confidence_scores?: Record<string, number>;
    coordinate_results?: Record<string, { value: unknown }>;
    needs_llm?: string[];
    // Legacy raw format
    [key: string]: unknown;
  } | null>(null);
  const [testWarning, setTestWarning] = useState<string | null>(null);

  // Load form details
  const { data: form, loading: formLoading } = useApi(
    useCallback(() => api.get<FormDetail>(`/api/forms/${formSlug}?schema=${schemaSlug}`), [formSlug, schemaSlug]),
  );

  // Load schema fields
  const { data: schemaDetail } = useApi(
    useCallback(() => api.get<{ draftYaml?: string; latestVersion?: { yamlSource: string } }>(`/api/schemas/${schemaSlug}`), [schemaSlug]),
  );

  const schemaFields = (() => {
    const yaml = schemaDetail?.latestVersion?.yamlSource ?? schemaDetail?.draftYaml;
    if (!yaml) return [];
    try {
      const doc = parseYaml(yaml);
      return Object.entries(doc?.fields ?? {}).map(([name, spec]: [string, any]) => ({
        name,
        type: spec?.type ?? "string",
      }));
    } catch { return []; }
  })();

  // Load PDF
  const { data: sampleUrl } = useApi(
    useCallback(() =>
      form?.sampleStorageKey
        ? api.get<{ url: string }>(`/api/forms/${formSlug}/sample-url?schema=${schemaSlug}`).then((r) => r.url)
        : Promise.resolve(null),
      [form?.sampleStorageKey, formSlug],
    ),
  );

  useEffect(() => {
    if (!sampleUrl) return;
    import("pdfjs-dist").then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.mjs",
        import.meta.url,
      ).toString();
      const doc = await pdfjs.getDocument(sampleUrl).promise;
      setPdfDoc(doc);
      setTotalPages(doc.numPages);
    });
  }, [sampleUrl]);

  // Load test PDF when file is selected
  useEffect(() => {
    if (!testFile) { setTestPdfDoc(null); return; }
    const url = URL.createObjectURL(testFile);
    import("pdfjs-dist").then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.mjs",
        import.meta.url,
      ).toString();
      const doc = await pdfjs.getDocument(url).promise;
      setTestPdfDoc(doc);
    });
    return () => URL.revokeObjectURL(url);
  }, [testFile]);

  // Which PDF to show — test PDF in test mode, sample PDF in annotate mode
  const activePdfDoc = mode === "test" && testPdfDoc ? testPdfDoc : pdfDoc;

  // Render PDF page
  useEffect(() => {
    if (!activePdfDoc || !canvasRef.current) return;
    setTotalPages(activePdfDoc.numPages);
    if (currentPage > activePdfDoc.numPages) setCurrentPage(1);
    (async () => {
      const pg = Math.min(currentPage, activePdfDoc.numPages);
      const page = await activePdfDoc.getPage(pg);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    })();
  }, [activePdfDoc, currentPage]);

  // Init mappings + status from form data
  useEffect(() => {
    if (form?.status) setFormStatus(form.status);
    if (form?.mappingsJson && typeof form.mappingsJson === "object") {
      setMappings(form.mappingsJson as Record<string, FieldMapping>);
    }
  }, [form]);

  // Mouse handlers for drawing, moving, and resizing
  function getRelativeCoords(e: React.MouseEvent): { x: number; y: number } | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: ((e.clientX - rect.left) * scaleX) / canvas.width,
      y: ((e.clientY - rect.top) * scaleY) / canvas.height,
    };
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (drawMode) {
      const coords = getRelativeCoords(e);
      if (!coords) return;
      setDrawing(true);
      setDrawStart(coords);
      setDrawRect(null);
      setSelectedField(null);
    } else {
      // Click on blank area deselects
      setSelectedField(null);
    }
  }

  function handleMouseMove(e: React.MouseEvent) {
    const coords = getRelativeCoords(e);
    if (!coords) return;

    // Drawing new box
    if (drawing && drawStart) {
      setDrawRect({
        x: Math.min(drawStart.x, coords.x),
        y: Math.min(drawStart.y, coords.y),
        w: Math.abs(coords.x - drawStart.x),
        h: Math.abs(coords.y - drawStart.y),
      });
      return;
    }

    // Moving a box
    if (dragging) {
      const dx = coords.x - dragging.startX;
      const dy = coords.y - dragging.startY;
      setMappings((prev) => ({
        ...prev,
        [dragging.field]: {
          ...prev[dragging.field]!,
          x: Math.max(0, Math.min(1 - prev[dragging.field]!.w, dragging.origX + dx)),
          y: Math.max(0, Math.min(1 - prev[dragging.field]!.h, dragging.origY + dy)),
        },
      }));
      return;
    }

    // Resizing a box
    if (resizing) {
      const { field, handle, startX, startY, orig } = resizing;
      const dx = coords.x - startX;
      const dy = coords.y - startY;
      let { x, y, w, h } = orig;

      if (handle.includes("e")) { w = Math.max(0.01, w + dx); }
      if (handle.includes("w")) { x = x + dx; w = Math.max(0.01, w - dx); }
      if (handle.includes("s")) { h = Math.max(0.005, h + dy); }
      if (handle.includes("n")) { y = y + dy; h = Math.max(0.005, h - dy); }

      // Clamp to canvas bounds
      x = Math.max(0, x);
      y = Math.max(0, y);
      if (x + w > 1) w = 1 - x;
      if (y + h > 1) h = 1 - y;

      setMappings((prev) => ({
        ...prev,
        [field]: { ...prev[field]!, x, y, w, h },
      }));
      return;
    }
  }

  function handleMouseUp() {
    if (drawing) {
      if (!drawRect || drawRect.w < 0.01 || drawRect.h < 0.005) {
        setDrawing(false);
        setDrawStart(null);
        setDrawRect(null);
        return;
      }
      setDrawing(false);
      setDrawStart(null);
      // Show field picker
      setPendingField("");
      return;
    }
    if (dragging) { setDragging(null); return; }
    if (resizing) { setResizing(null); return; }
  }

  function handleOverlayMouseDown(e: React.MouseEvent, field: string) {
    if (drawMode) return;
    e.stopPropagation();
    const coords = getRelativeCoords(e);
    if (!coords) return;
    setSelectedField(field);
    const m = mappings[field]!;
    setDragging({ field, startX: coords.x, startY: coords.y, origX: m.x, origY: m.y });
  }

  function handleResizeMouseDown(e: React.MouseEvent, field: string, handle: string) {
    e.stopPropagation();
    const coords = getRelativeCoords(e);
    if (!coords) return;
    setSelectedField(field);
    const m = mappings[field]!;
    setResizing({ field, handle, startX: coords.x, startY: coords.y, orig: { x: m.x, y: m.y, w: m.w, h: m.h } });
  }

  function assignField(fieldName: string) {
    const rect = editingField ? mappings[editingField] : drawRect;
    if (!rect || !fieldName) return;
    const mapping: FieldMapping = {
      page: editingField ? mappings[editingField]!.page : currentPage,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      mapping_type: pendingMappingType,
      value_type: pendingValueType,
      sample_text: "",
      label: pendingLabel.trim() || undefined,
    };
    if (pendingMappingType === "checkbox") {
      mapping.checked_value = pendingCheckedValue.trim() || "true";
      mapping.unchecked_value = pendingUncheckedValue.trim() || null;
    }
    if (pendingMappingType === "llm_interpret") {
      mapping.llm_prompt = pendingLlmPrompt.trim() || undefined;
      mapping.target_fields = pendingTargetFields.length > 0 ? pendingTargetFields : undefined;
    }
    // If editing, remove old field name if it changed
    if (editingField && editingField !== fieldName) {
      setMappings((prev) => {
        const next = { ...prev };
        delete next[editingField!];
        next[fieldName] = mapping;
        return next;
      });
    } else {
      setMappings((prev) => ({ ...prev, [fieldName]: mapping }));
    }
    resetPendingState();
  }

  function resetPendingState() {
    setDrawRect(null);
    setPendingField(null);
    setPendingLabel("");
    setPendingMappingType("text");
    setPendingValueType("string");
    setPendingCheckedValue("");
    setPendingUncheckedValue("");
    setPendingLlmPrompt("");
    setPendingTargetFields([]);
    setEditingField(null);
  }

  function startEditField(fieldName: string) {
    const m = mappings[fieldName];
    if (!m) return;
    setEditingField(fieldName);
    setPendingField("");
    setPendingMappingType(m.mapping_type);
    setPendingValueType(m.value_type);
    setPendingLabel(m.label ?? "");
    setPendingCheckedValue(m.checked_value ?? "");
    setPendingUncheckedValue(m.unchecked_value ?? "");
    setPendingLlmPrompt(m.llm_prompt ?? "");
    setPendingTargetFields(m.target_fields ?? []);
    // Set drawRect to current position for the popover
    setDrawRect({ x: m.x, y: m.y, w: m.w, h: m.h });
  }

  function removeMapping(fieldName: string) {
    setMappings((prev) => {
      const next = { ...prev };
      delete next[fieldName];
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await api.patch(`/api/forms/${formSlug}?schema=${schemaSlug}`, { mappings_json: mappings });
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate() {
    const newStatus = formStatus === "active" ? "draft" : "active";
    setActivating(true);
    try {
      await api.patch(`/api/forms/${formSlug}?schema=${schemaSlug}`, {
        mappings_json: mappings,
        status: newStatus,
      });
      setFormStatus(newStatus);
    } finally {
      setActivating(false);
    }
  }

  async function handleTest() {
    if (!testFile) return;
    setTesting(true);
    setTestResults(null);
    setTestWarning(null);
    try {
      const fd = new FormData();
      fd.append("file", testFile);
      const resp = await api.postForm<{
        data: {
          extracted: Record<string, { value: string | null; error?: string }>;
          has_text_layer: boolean;
          warning?: string;
        };
      }>(`/api/forms/${formSlug}/test?schema=${schemaSlug}`, fd);
      if (resp.data.warning) {
        setTestWarning(resp.data.warning);
      } else if (resp.data.has_text_layer === false) {
        setTestWarning("This PDF appears to be scanned — it has no text layer. Coordinate-based extraction requires a digital PDF. Results may be empty or inaccurate.");
      }
      setTestResults(resp.data);
    } catch (err: any) {
      setTestWarning(err?.message ?? "Test failed");
    } finally {
      setTesting(false);
    }
  }

  const fieldColorMap = new Map<string, typeof FIELD_COLORS[0]>();
  Object.keys(mappings).forEach((field, i) => {
    fieldColorMap.set(field, FIELD_COLORS[i % FIELD_COLORS.length]!);
  });

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      {/* Header */}
      <div className="px-6 pt-4 pb-3 border-b border-border shrink-0 flex items-start justify-between">
        <div>
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-1">
            <Link href={pathname.replace(`/${formSlug}`, "")} className="text-ink-3 hover:text-ink">{schemaSlug}</Link>
            <span className="text-cream-4">/</span>
            <span className="text-ink-3">Forms</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium truncate max-w-[200px]">{form?.displayName ?? formSlug}</span>
          </nav>
          <div className="flex items-center gap-1 mt-2">
            {(["annotate", "test"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`font-mono text-[10px] px-2.5 py-1 rounded-sm transition-colors ${
                  mode === m ? "bg-ink text-cream" : "text-ink-4 hover:bg-cream-2"
                }`}
              >
                {m === "annotate" ? "Annotate" : "Test"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mode === "annotate" && (
            <>
              <button
                onClick={() => setDrawMode(!drawMode)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium transition-colors ${
                  drawMode
                    ? "bg-vermillion-2 text-cream"
                    : "bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink"
                }`}
              >
                <MousePointer2 className="w-3.5 h-3.5" />
                {drawMode ? "Drawing..." : "Draw mode"}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30"
              >
                <Save className="w-3.5 h-3.5" />
                {saving ? "Saving..." : "Save"}
              </button>
              <button
                onClick={handleActivate}
                disabled={activating || Object.keys(mappings).length === 0}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium transition-colors disabled:opacity-30 ${
                  formStatus === "active"
                    ? "bg-green/15 text-green border border-green/30 hover:bg-vermillion-3/30 hover:text-vermillion-2 hover:border-vermillion-2/30"
                    : "bg-cream-2 text-ink-3 border border-border hover:border-green hover:text-green"
                }`}
              >
                {activating ? "..." : formStatus === "active" ? "Active" : "Activate"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_300px]">
        {/* Left: PDF with drawing overlay */}
        <div ref={containerRef} className="relative overflow-auto border-r border-border">
          {!sampleUrl ? (
            <div className="flex items-center justify-center h-full text-[12px] text-ink-4">
              {formLoading ? "Loading..." : "No sample PDF uploaded"}
            </div>
          ) : (
            <div
              className="relative inline-block"
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <canvas
                ref={canvasRef}
                className="block"
                style={{ cursor: drawMode ? "crosshair" : dragging ? "move" : resizing ? "grabbing" : "default" }}
                onMouseDown={handleMouseDown}
              />

              {/* Existing mapping overlays */}
              {canvasRef.current && Object.entries(mappings)
                .filter(([, m]) => m.page === currentPage)
                .map(([field, m]) => {
                  const color = fieldColorMap.get(field)!;
                  const isSelected = selectedField === field && !drawMode;
                  return (
                    <div
                      key={field}
                      className={`absolute ${drawMode ? "pointer-events-none" : "cursor-move"}`}
                      style={{
                        left: `${m.x * 100}%`,
                        top: `${m.y * 100}%`,
                        width: `${m.w * 100}%`,
                        height: `${m.h * 100}%`,
                        backgroundColor: color.bg,
                        border: `2px solid ${isSelected ? "#000" : color.border}`,
                        borderRadius: 2,
                      }}
                      onMouseDown={(e) => handleOverlayMouseDown(e, field)}
                    >
                      <span
                        className="absolute -top-5 left-0 text-[9px] font-mono font-medium px-1 py-0.5 rounded-sm whitespace-nowrap"
                        style={{ backgroundColor: color.border, color: "#fff" }}
                      >
                        {field.startsWith("__llm_") ? `LLM → ${m.target_fields?.join(", ") ?? "?"}` : field}
                      </span>
                      {/* Resize handles — visible when selected */}
                      {isSelected && (
                        <>
                          {(["nw", "ne", "sw", "se", "n", "s", "e", "w"] as const).map((h) => {
                            const pos: React.CSSProperties = {};
                            if (h.includes("n")) pos.top = -4;
                            if (h.includes("s")) pos.bottom = -4;
                            if (h.includes("w")) pos.left = -4;
                            if (h.includes("e")) pos.right = -4;
                            if (h === "n" || h === "s") { pos.left = "50%"; pos.marginLeft = -4; }
                            if (h === "e" || h === "w") { pos.top = "50%"; pos.marginTop = -4; }
                            const cursor = h === "n" || h === "s" ? "ns-resize"
                              : h === "e" || h === "w" ? "ew-resize"
                              : h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize";
                            return (
                              <div
                                key={h}
                                className="absolute w-2 h-2 bg-white border border-ink rounded-full"
                                style={{ ...pos, cursor }}
                                onMouseDown={(e) => handleResizeMouseDown(e, field, h)}
                              />
                            );
                          })}
                        </>
                      )}
                    </div>
                  );
                })}

              {/* Drawing rectangle */}
              {drawRect && (
                <div
                  className="absolute border-2 border-dashed border-vermillion-2 bg-vermillion-3/20 pointer-events-none"
                  style={{
                    left: `${drawRect.x * 100}%`,
                    top: `${drawRect.y * 100}%`,
                    width: `${drawRect.w * 100}%`,
                    height: `${drawRect.h * 100}%`,
                  }}
                />
              )}

              {/* Field assignment popover */}
              {pendingField !== null && drawRect && (
                <div
                  className="absolute z-50 bg-white border border-border rounded-sm shadow-lg p-2 min-w-[180px]"
                  style={{
                    left: `${drawRect.x * 100}%`,
                    top: `${(drawRect.y + drawRect.h) * 100}%`,
                    marginTop: 8,
                  }}
                >
                  <div className="font-mono text-[9px] text-ink-4 uppercase tracking-[0.08em] mb-1">
                    {editingField ? `Edit: ${editingField}` : "Assign to field"}
                  </div>

                  {/* Mapping type */}
                  <div className="flex gap-1 mb-2 flex-wrap">
                    {([["text", "Text"], ["checkbox", "Checkbox"], ["llm_interpret", "LLM"]] as [MappingType, string][]).map(([mt, label]) => (
                      <button
                        key={mt}
                        onClick={() => setPendingMappingType(mt)}
                        className={`font-mono text-[9px] px-2 py-0.5 rounded-sm transition-colors ${
                          pendingMappingType === mt ? "bg-ink text-cream" : "text-ink-4 hover:bg-cream-2 border border-border"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {/* Value type (for text fields) */}
                  {pendingMappingType === "text" && (
                    <div className="mb-2">
                      <select
                        value={pendingValueType}
                        onChange={(e) => setPendingValueType(e.target.value as ValueType)}
                        className="w-full h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] outline-none focus:border-ring"
                      >
                        {VALUE_TYPES.map((vt) => (
                          <option key={vt.value} value={vt.value}>{vt.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Checkbox options */}
                  {pendingMappingType === "checkbox" && (
                    <div className="mb-2 space-y-1">
                      <input
                        value={pendingCheckedValue}
                        onChange={(e) => setPendingCheckedValue(e.target.value)}
                        placeholder="Value when checked (e.g. Claims-Made)"
                        className="w-full h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] outline-none focus:border-ring placeholder:text-ink-4"
                      />
                      <input
                        value={pendingUncheckedValue}
                        onChange={(e) => setPendingUncheckedValue(e.target.value)}
                        placeholder="Value when unchecked (leave empty for null)"
                        className="w-full h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] outline-none focus:border-ring placeholder:text-ink-4"
                      />
                    </div>
                  )}

                  {/* LLM interpret options */}
                  {pendingMappingType === "llm_interpret" && (
                    <div className="mb-2 space-y-1.5">
                      <div>
                        <textarea
                          value={pendingLlmPrompt}
                          onChange={(e) => setPendingLlmPrompt(e.target.value)}
                          placeholder="Prompt: e.g. Extract the insured name only, ignoring the address below it"
                          rows={3}
                          className="w-full rounded-sm border border-input bg-white px-2 py-1.5 text-[11px] outline-none focus:border-ring placeholder:text-ink-4 resize-none"
                        />
                        <p className="text-[9px] text-ink-4 mt-0.5">The LLM receives the text from this region + your prompt</p>
                      </div>
                      <div>
                        <div className="text-[9px] text-ink-4 mb-1">Target fields (multi-select)</div>
                        <div className="max-h-[100px] overflow-y-auto border border-input rounded-sm p-1 space-y-0.5">
                          {schemaFields.map((f) => (
                            <label key={f.name} className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] rounded-sm hover:bg-cream-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={pendingTargetFields.includes(f.name)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setPendingTargetFields((prev) => [...prev, f.name]);
                                  } else {
                                    setPendingTargetFields((prev) => prev.filter((n) => n !== f.name));
                                  }
                                }}
                                className="rounded-sm"
                              />
                              <span className="font-mono text-[10px]">{f.name}</span>
                            </label>
                          ))}
                        </div>
                        <p className="text-[9px] text-ink-4 mt-0.5">Which schema fields this region populates</p>
                      </div>
                    </div>
                  )}

                  {/* Label exclusion */}
                  {pendingMappingType !== "llm_interpret" && (
                  <div className="mb-2">
                    <input
                      value={pendingLabel}
                      onChange={(e) => setPendingLabel(e.target.value)}
                      placeholder="Label to exclude (e.g. INSURED)"
                      className="w-full h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] outline-none focus:border-ring placeholder:text-ink-4"
                    />
                    <p className="text-[9px] text-ink-4 mt-0.5">Optional — strips this text from extracted values</p>
                  </div>
                  )}
                  {/* Field picker — for LLM interpret, assign button instead of field list */}
                  {pendingMappingType === "llm_interpret" ? (
                    <button
                      onClick={() => {
                        // Always use synthetic key so LLM regions never collide with direct field mappings
                        const key = editingField?.startsWith("__llm_")
                          ? editingField
                          : `__llm_${Date.now()}`;
                        assignField(key);
                      }}
                      disabled={pendingTargetFields.length === 0}
                      className="w-full px-2 py-1.5 text-[12px] font-medium rounded-sm bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30"
                    >
                      {editingField ? "Update mapping" : "Create LLM region"}
                    </button>
                  ) : (
                    <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                      {schemaFields
                        .filter((f) => editingField === f.name || !(f.name in mappings))
                        .map((f) => (
                          <button
                            key={f.name}
                            onClick={() => assignField(f.name)}
                            className={`w-full text-left px-2 py-1.5 text-[12px] rounded-sm hover:bg-cream-2 transition-colors ${
                              editingField === f.name ? "bg-cream-2 font-medium" : ""
                            }`}
                          >
                            <span className="font-mono text-vermillion-2">{f.name}</span>
                            <span className="text-ink-4 ml-1.5 text-[10px]">{f.type}</span>
                            {editingField === f.name && <span className="text-ink-4 ml-1 text-[9px]">(current)</span>}
                          </button>
                        ))}
                    </div>
                  )}
                  <button
                    onClick={resetPendingState}
                    className="w-full mt-1 px-2 py-1 text-[10px] text-ink-4 hover:text-ink text-center"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Page navigation */}
          {totalPages > 1 && (
            <div className="sticky bottom-0 bg-cream/90 backdrop-blur-sm border-t border-border px-3 py-1.5 flex items-center justify-center gap-3">
              <button
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="text-[12px] text-ink-3 hover:text-ink disabled:opacity-30"
              >
                ← Prev
              </button>
              <span className="font-mono text-[10px] text-ink-4">{currentPage} / {totalPages}</span>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                className="text-[12px] text-ink-3 hover:text-ink disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="overflow-y-auto p-4 space-y-1">
          {mode === "annotate" ? (
            <>
              <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-3">
                Schema Fields
              </div>
              {schemaFields.map((f) => {
                const mapped = f.name in mappings;
                const coveredByLlm = Object.values(mappings).some(
                  (m) => m.mapping_type === "llm_interpret" && m.target_fields?.includes(f.name),
                );
                const color = fieldColorMap.get(f.name);
                return (
                  <div
                    key={f.name}
                    className={`flex items-center justify-between px-2.5 py-2 rounded-sm border transition-colors ${
                      mapped ? "border-l-2 bg-cream-2/50" : coveredByLlm ? "border-l-2 bg-purple-50/50" : "border-border"
                    }`}
                    style={
                      mapped && color ? { borderLeftColor: color.border }
                      : coveredByLlm ? { borderLeftColor: "#9333ea" }
                      : undefined
                    }
                  >
                    <div className="min-w-0">
                      <div className="font-mono text-[11px] text-ink truncate">{f.name}</div>
                      <div className="font-mono text-[9px] text-ink-4 space-x-1.5">
                        <span>{mapped ? (mappings[f.name]?.mapping_type ?? "text") : f.type}</span>
                        {mapped && mappings[f.name]?.value_type && mappings[f.name]!.value_type !== "string" && (
                          <span className="text-blue-600">{mappings[f.name]!.value_type}</span>
                        )}
                        {mapped && mappings[f.name]?.label && (
                          <span className="text-vermillion-2">-{mappings[f.name]!.label}</span>
                        )}
                        {mapped && mappings[f.name]?.mapping_type === "checkbox" && (
                          <span className="text-green">☑ {mappings[f.name]!.checked_value}</span>
                        )}
                        {!mapped && coveredByLlm && (
                          <span className="text-purple-600">via LLM region</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {mapped ? (
                        <>
                          <button
                            onClick={() => startEditField(f.name)}
                            className="text-ink-4 hover:text-ink transition-colors"
                            title="Edit mapping"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <CheckCircle className="w-3.5 h-3.5 text-green" />
                          <button onClick={() => removeMapping(f.name)} className="text-ink-4 hover:text-vermillion-2">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </>
                      ) : coveredByLlm ? (
                        <CheckCircle className="w-3.5 h-3.5 text-purple-400" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-ink-4/30" />
                      )}
                    </div>
                  </div>
                );
              })}

              {schemaFields.length === 0 && (
                <p className="text-[11px] text-ink-4 text-center py-4">
                  No fields defined in schema. Add fields in Build mode first.
                </p>
              )}

              {/* LLM Regions */}
              {(() => {
                const llmRegions = Object.entries(mappings).filter(([k]) => k.startsWith("__llm_"));
                if (llmRegions.length === 0) return null;
                return (
                  <div className="mt-4 pt-3 border-t border-border">
                    <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-2">
                      LLM Regions
                    </div>
                    {llmRegions.map(([key, m]) => {
                      const color = fieldColorMap.get(key);
                      return (
                        <div
                          key={key}
                          className="flex items-center justify-between px-2.5 py-2 rounded-sm border border-l-2 bg-purple-50/50 mb-1"
                          style={color ? { borderLeftColor: color.border } : { borderLeftColor: "#9333ea" }}
                        >
                          <div className="min-w-0">
                            <div className="font-mono text-[10px] text-purple-600 truncate">
                              → {m.target_fields?.join(", ") || "no targets"}
                            </div>
                            <div className="text-[9px] text-ink-4 truncate mt-0.5">
                              {m.llm_prompt ? m.llm_prompt.slice(0, 60) + (m.llm_prompt.length > 60 ? "..." : "") : "No prompt"}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={() => startEditField(key)}
                              className="text-ink-4 hover:text-ink transition-colors"
                              title="Edit region"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button onClick={() => removeMapping(key)} className="text-ink-4 hover:text-vermillion-2">
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}

              <div className="pt-3 mt-3 border-t border-border font-mono text-[9px] text-ink-4 space-y-1">
                <div>{Object.keys(mappings).filter((k) => !k.startsWith("__llm_")).length} / {schemaFields.length} fields mapped</div>
                {Object.keys(mappings).filter((k) => k.startsWith("__llm_")).length > 0 && (
                  <div>{Object.keys(mappings).filter((k) => k.startsWith("__llm_")).length} LLM region(s)</div>
                )}
                <div>v{form?.version ?? 1}</div>
              </div>
            </>
          ) : (
            <>
              <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-3">
                Test Extraction
              </div>
              <p className="text-[11px] text-ink-4 mb-3">
                Upload a different instance of this form type to test coordinate extraction.
              </p>

              {/* Upload test PDF */}
              <label className={`flex items-center gap-2 px-3 py-2 rounded-sm text-[12px] border border-dashed transition-colors cursor-pointer mb-3 ${
                testFile ? "text-green border-green/30" : "text-ink-3 border-border hover:border-ink hover:text-ink"
              }`}>
                {testFile ? <CheckCircle className="w-3.5 h-3.5 shrink-0" /> : <Upload className="w-3.5 h-3.5 shrink-0" />}
                <span className="truncate">{testFile?.name ?? "Upload test PDF"}</span>
                <input type="file" className="hidden" accept=".pdf" onChange={(e) => {
                  if (e.target.files?.[0]) { setTestFile(e.target.files[0]); setTestResults(null); setTestWarning(null); }
                }} />
              </label>

              <button
                onClick={handleTest}
                disabled={!testFile || testing || Object.keys(mappings).length === 0}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-30 mb-4"
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {testing ? "Extracting..." : "Run test"}
              </button>

              {testWarning && (
                <div className="border border-vermillion-2/30 bg-vermillion-3/30 rounded-sm px-3 py-2 text-[11px] text-vermillion-2 mb-3">
                  {testWarning}
                </div>
              )}

              {/* Test results */}
              {testResults && (() => {
                const extracted = testResults.extracted ?? testResults.coordinate_results ?? testResults;
                const scores = testResults.confidence_scores as Record<string, number> | undefined;
                const needsLlm = testResults.needs_llm as string[] | undefined;
                const needsLlmSet = new Set(needsLlm ?? []);

                return (
                  <>
                    {needsLlm && needsLlm.length > 0 && (
                      <div className="border border-yellow-500/30 bg-yellow-500/10 rounded-sm px-3 py-2 text-[11px] text-yellow-700 mb-2">
                        {needsLlm.length} field(s) may need LLM interpretation: {needsLlm.join(", ")}
                      </div>
                    )}
                    <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
                      {Object.entries(extracted as Record<string, unknown>).map(([field, value]) => {
                        const score = scores?.[field];
                        const needsInterpretation = needsLlmSet.has(field);
                        return (
                          <div key={field} className={`px-3 py-2 ${needsInterpretation ? "bg-yellow-500/5" : ""}`}>
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-[10px] text-vermillion-2 font-medium">{field}</span>
                              {score !== undefined && (
                                <span className={`font-mono text-[9px] ${score >= 0.9 ? "text-green" : score >= 0.5 ? "text-yellow-600" : "text-vermillion-2"}`}>
                                  {(score * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>
                            <div className="text-[12px] text-ink mt-0.5">
                              {value != null ? (
                                typeof value === "boolean" ? (value ? "✓ Yes" : "✗ No") :
                                typeof value === "object" ? JSON.stringify(value) :
                                String(value)
                              ) : (
                                <span className="text-ink-4">— empty —</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                );
              })()}

              {Object.keys(mappings).length === 0 && (
                <p className="text-[11px] text-ink-4 text-center py-4">
                  No fields mapped yet. Switch to Annotate mode to map fields first.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
