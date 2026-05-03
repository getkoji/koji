"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Save, Trash2, CheckCircle, Circle, MousePointer2 } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { parse as parseYaml } from "yaml";

interface FieldMapping {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  value_type: string;
  sample_text: string;
}

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
  const [mappings, setMappings] = useState<Record<string, FieldMapping>>({});
  const [saving, setSaving] = useState(false);
  const [drawMode, setDrawMode] = useState(false);

  // Load form details
  const { data: form, loading: formLoading } = useApi(
    useCallback(() => api.get<FormDetail>(`/api/forms/${formSlug}`), [formSlug]),
  );

  // Load schema fields
  const { data: schemaDetail } = useApi(
    useCallback(() => api.get<{ draftYaml?: string; latestVersion?: { yamlSource: string } }>(`/api/schemas/${schemaSlug}`), [schemaSlug]),
  );

  const schemaFields = (() => {
    const yaml = schemaDetail?.draftYaml ?? schemaDetail?.latestVersion?.yamlSource;
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
        ? api.get<{ url: string }>(`/api/forms/${formSlug}/sample-url`).then((r) => r.url)
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

  // Render PDF page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    (async () => {
      const page = await pdfDoc.getPage(currentPage);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = canvasRef.current!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    })();
  }, [pdfDoc, currentPage]);

  // Init mappings from form data
  useEffect(() => {
    if (form?.mappingsJson && typeof form.mappingsJson === "object") {
      setMappings(form.mappingsJson as Record<string, FieldMapping>);
    }
  }, [form]);

  // Mouse handlers for drawing
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
    if (!drawMode) return;
    const coords = getRelativeCoords(e);
    if (!coords) return;
    setDrawing(true);
    setDrawStart(coords);
    setDrawRect(null);
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (!drawing || !drawStart) return;
    const coords = getRelativeCoords(e);
    if (!coords) return;
    setDrawRect({
      x: Math.min(drawStart.x, coords.x),
      y: Math.min(drawStart.y, coords.y),
      w: Math.abs(coords.x - drawStart.x),
      h: Math.abs(coords.y - drawStart.y),
    });
  }

  function handleMouseUp() {
    if (!drawing || !drawRect || drawRect.w < 0.01 || drawRect.h < 0.005) {
      setDrawing(false);
      setDrawStart(null);
      setDrawRect(null);
      return;
    }
    setDrawing(false);
    setDrawStart(null);
    // Show field picker
    setPendingField("");
  }

  function assignField(fieldName: string) {
    if (!drawRect || !fieldName) return;
    setMappings((prev) => ({
      ...prev,
      [fieldName]: {
        page: currentPage,
        x: drawRect.x,
        y: drawRect.y,
        w: drawRect.w,
        h: drawRect.h,
        value_type: schemaFields.find((f) => f.name === fieldName)?.type ?? "string",
        sample_text: "", // TODO: extract text at coordinates
      },
    }));
    setDrawRect(null);
    setPendingField(null);
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
      await api.patch(`/api/forms/${formSlug}`, { mappings_json: mappings });
    } finally {
      setSaving(false);
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
          <h1 className="font-display text-[22px] font-medium leading-none tracking-tight text-ink"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}>
            Annotate Form
          </h1>
        </div>
        <div className="flex items-center gap-2">
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
            <div className="relative inline-block">
              <canvas
                ref={canvasRef}
                className="block"
                style={{ cursor: drawMode ? "crosshair" : "default" }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
              />

              {/* Existing mapping overlays */}
              {canvasRef.current && Object.entries(mappings)
                .filter(([, m]) => m.page === currentPage)
                .map(([field, m]) => {
                  const color = fieldColorMap.get(field)!;
                  return (
                    <div
                      key={field}
                      className="absolute pointer-events-none"
                      style={{
                        left: m.x * canvasRef.current!.width,
                        top: m.y * canvasRef.current!.height,
                        width: m.w * canvasRef.current!.width,
                        height: m.h * canvasRef.current!.height,
                        backgroundColor: color.bg,
                        border: `2px solid ${color.border}`,
                        borderRadius: 2,
                      }}
                    >
                      <span
                        className="absolute -top-5 left-0 text-[9px] font-mono font-medium px-1 py-0.5 rounded-sm whitespace-nowrap"
                        style={{ backgroundColor: color.border, color: "#fff" }}
                      >
                        {field}
                      </span>
                    </div>
                  );
                })}

              {/* Drawing rectangle */}
              {drawRect && canvasRef.current && (
                <div
                  className="absolute border-2 border-dashed border-vermillion-2 bg-vermillion-3/20 pointer-events-none"
                  style={{
                    left: drawRect.x * canvasRef.current.width,
                    top: drawRect.y * canvasRef.current.height,
                    width: drawRect.w * canvasRef.current.width,
                    height: drawRect.h * canvasRef.current.height,
                  }}
                />
              )}

              {/* Field assignment popover */}
              {pendingField !== null && drawRect && canvasRef.current && (
                <div
                  className="absolute z-50 bg-white border border-border rounded-sm shadow-lg p-2 min-w-[180px]"
                  style={{
                    left: drawRect.x * canvasRef.current.width,
                    top: (drawRect.y + drawRect.h) * canvasRef.current.height + 8,
                  }}
                >
                  <div className="font-mono text-[9px] text-ink-4 uppercase tracking-[0.08em] mb-1">Assign to field</div>
                  <div className="max-h-[200px] overflow-y-auto space-y-0.5">
                    {schemaFields
                      .filter((f) => !(f.name in mappings))
                      .map((f) => (
                        <button
                          key={f.name}
                          onClick={() => assignField(f.name)}
                          className="w-full text-left px-2 py-1.5 text-[12px] rounded-sm hover:bg-cream-2 transition-colors"
                        >
                          <span className="font-mono text-vermillion-2">{f.name}</span>
                          <span className="text-ink-4 ml-1.5 text-[10px]">{f.type}</span>
                        </button>
                      ))}
                  </div>
                  <button
                    onClick={() => { setPendingField(null); setDrawRect(null); }}
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

        {/* Right: Field list */}
        <div className="overflow-y-auto p-4 space-y-1">
          <div className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-3">
            Schema Fields
          </div>
          {schemaFields.map((f) => {
            const mapped = f.name in mappings;
            const color = fieldColorMap.get(f.name);
            return (
              <div
                key={f.name}
                className={`flex items-center justify-between px-2.5 py-2 rounded-sm border transition-colors ${
                  mapped ? "border-l-2 bg-cream-2/50" : "border-border"
                }`}
                style={mapped && color ? { borderLeftColor: color.border } : undefined}
              >
                <div className="min-w-0">
                  <div className="font-mono text-[11px] text-ink truncate">{f.name}</div>
                  <div className="font-mono text-[9px] text-ink-4">{f.type}</div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {mapped ? (
                    <>
                      <CheckCircle className="w-3.5 h-3.5 text-green" />
                      <button onClick={() => removeMapping(f.name)} className="text-ink-4 hover:text-vermillion-2">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </>
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

          {/* Stats */}
          <div className="pt-3 mt-3 border-t border-border font-mono text-[9px] text-ink-4 space-y-1">
            <div>{Object.keys(mappings).length} / {schemaFields.length} fields mapped</div>
            <div>v{form?.version ?? 1}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
