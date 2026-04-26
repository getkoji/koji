"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { parse as parseYaml } from "yaml";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { FileQuestion, Pencil, History, RotateCcw, Play, Upload, Maximize2, Minimize2, MapPin } from "lucide-react";
import { api, getAuthTokenProvider } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { EmptyState } from "@/components/shared/EmptyState";

// ── Types ──

interface SchemaDetail {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  draftYaml: string | null;
  latestVersion: {
    versionNumber: number;
    yamlSource: string;
    commitMessage: string | null;
    createdAt: string;
  } | null;
}

interface SchemaVersion {
  id: string;
  versionNumber: number;
  commitMessage: string | null;
  committedByName: string;
  createdAt: string;
}

interface CorpusEntry {
  id: string;
  filename: string;
  fileSize: number;
  mimeType: string;
  source: string;
  createdAt: string;
}

interface ParsedField {
  name: string;
  type: string;
  required?: boolean;
  nullable?: boolean;
  validate?: Record<string, unknown>;
  extraction_guidance?: string;
}

// ── Helpers ──

function parseFields(yamlText: string): { fields: ParsedField[]; error: string | null } {
  try {
    const doc = parseYaml(yamlText);
    if (!doc?.fields || typeof doc.fields !== "object") return { fields: [], error: null };
    const fields: ParsedField[] = [];
    for (const [name, def] of Object.entries(doc.fields)) {
      if (!def || typeof def !== "object") continue;
      const d = def as Record<string, unknown>;
      fields.push({
        name,
        type: (d.type as string) ?? "unknown",
        required: d.required as boolean | undefined,
        nullable: d.nullable as boolean | undefined,
        validate: d.validate as Record<string, unknown> | undefined,
        extraction_guidance: d.extraction_guidance as string | undefined,
      });
    }
    return { fields, error: null };
  } catch (err: unknown) {
    return { fields: [], error: err instanceof Error ? err.message : "Parse error" };
  }
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function highlightYaml(text: string): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Then apply highlighting
  html = html
    .replace(/(#.*)$/gm, '<span style="color:#998E78">$1</span>')
    .replace(/^(\s*-\s+)([\w][\w.-]*\s*)(:)/gm, '$1<span style="color:#C33520">$2</span><span style="color:#998E78">$3</span>')
    .replace(/^(\s*)([\w][\w.-]*\s*)(:)/gm, '$1<span style="color:#C33520">$2</span><span style="color:#998E78">$3</span>');
  return html;
}

function countChangedLines(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  let changes = 0;
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i++) {
    if ((linesA[i] ?? "") !== (linesB[i] ?? "")) changes++;
  }
  return changes;
}

// ── Page ──

export default function BuildPage() {
  const params = useParams();
  const pathname = usePathname();
  const schemaSlug = params.schemaSlug as string;
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1] ?? "";

  // Data
  const { data: tenants } = useApi(
    useCallback(() => api.get<{ data: Array<{ slug: string; displayName: string }> }>("/api/tenants").then((r) => r.data), []),
  );
  const projectName = tenants?.find((t) => t.slug === tenantSlug)?.displayName ?? tenantSlug;

  const { data: schemaDetail, loading: schemaLoading, error: schemaError, refetch } = useApi(
    useCallback(() => api.get<SchemaDetail>(`/api/schemas/${schemaSlug}`), [schemaSlug]),
  );
  const { data: versions, refetch: refetchVersions } = useApi(
    useCallback(() => api.get<{ data: SchemaVersion[] }>(`/api/schemas/${schemaSlug}/versions`).then((r) => r.data), [schemaSlug]),
  );

  // Editor state
  const [yaml, setYaml] = useState("");
  const [initialized, setInitialized] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // UI state
  const [showCommit, setShowCommit] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitErrors, setCommitErrors] = useState<Array<{ field?: string; message: string }>>([]);
  const [focusPanel, setFocusPanel] = useState<"split" | "editor" | "document">("split");
  const [editorTab, setEditorTab] = useState<"schema" | "results">("schema");
  const [savingGT, setSavingGT] = useState(false);
  const [gtSaved, setGtSaved] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [docPreviewUrl, setDocPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("koji:build:model") ?? "";
    return "";
  });
  const [extracting, setExtracting] = useState(false);
  const [extractionResult, setExtractionResult] = useState<{
    extracted: Record<string, unknown>;
    confidence: number;
    confidence_scores?: Record<string, number>;
    provenance?: Record<string, { offset: number; length: number; chunk?: string; page?: number } | null>;
    model?: string;
    elapsed_ms?: number;
    parse_seconds?: number;
    ocr_skipped?: boolean;
    error?: string;
  } | null>(null);
  const [highlightedField, setHighlightedField] = useState<string | null>(null);
  const [parseProgress, setParseProgress] = useState<{
    pages: number;
    scanned: boolean;
    ocr_skipped: boolean;
    estimated_seconds: number;
    percent: number;
    estimated_remaining_seconds: number;
    phase: "detecting" | "parsing" | "extracting" | "done";
  } | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  // Corpus entries for this schema
  const { data: corpusEntries, refetch: refetchCorpus } = useApi(
    useCallback(() => api.get<{ data: CorpusEntry[] }>(`/api/schemas/${schemaSlug}/corpus`).then((r) => r.data), [schemaSlug]),
  );

  // Model catalog
  const { data: catalogModels } = useApi(
    useCallback(() => api.get<{ data: Array<{ id: string; provider: string; model: string; displayName: string }> }>("/api/model-providers").then((r) => r.data.map(e => ({ ...e, modelId: e.model }))), []),
  );

  // Persist model selection
  useEffect(() => {
    if (selectedModel) localStorage.setItem("koji:build:model", selectedModel);
  }, [selectedModel]);

  // Auto-select first corpus entry
  useEffect(() => {
    if (!selectedDocId && (corpusEntries ?? []).length > 0) {
      setSelectedDocId(corpusEntries![0]!.id);
    }
  }, [corpusEntries, selectedDocId]);

  const selectedDoc = (corpusEntries ?? []).find((e) => e.id === selectedDocId) ?? null;

  // Load latest extraction run when document is selected
  useEffect(() => {
    if (!selectedDocId) return;
    let cancelled = false;
    api.get<{ data: {
      id: string;
      model: string;
      extracted: Record<string, unknown>;
      confidence: Record<string, string>;
      confidence_scores: Record<string, number>;
      parse_seconds: number | null;
      elapsed_ms: number | null;
      ocr_skipped: boolean;
      cached: boolean;
      created_at: string;
    } | null }>(`/api/extract/runs/${selectedDocId}`)
      .then((resp) => {
        if (cancelled || !resp.data) return;
        setExtractionResult({
          extracted: resp.data.extracted,
          confidence: 0,
          confidence_scores: resp.data.confidence_scores,
          model: resp.data.model,
          elapsed_ms: resp.data.elapsed_ms ?? undefined,
          parse_seconds: resp.data.parse_seconds ?? undefined,
          ocr_skipped: resp.data.ocr_skipped,
        });
        setGtSaved(false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedDocId]);

  // Initialize editor
  useEffect(() => {
    if (schemaDetail && !initialized) {
      setYaml(schemaDetail.latestVersion?.yamlSource ?? schemaDetail.draftYaml ?? "");
      setInitialized(true);
    }
  }, [schemaDetail, initialized]);

  // Close history on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setShowHistory(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (hasChanges) setShowCommit(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (selectedDocId && yaml) handleRun();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

  // Derived
  const committedYaml = schemaDetail?.latestVersion?.yamlSource ?? "";
  const hasChanges = yaml !== committedYaml && initialized;
  const changedLines = hasChanges ? countChangedLines(committedYaml, yaml) : 0;
  const currentVersion = schemaDetail?.latestVersion?.versionNumber ?? 0;
  const nextVersion = currentVersion + 1;
  const { fields, error: parseError } = useMemo(() => parseFields(yaml), [yaml]);

  // Actions
  async function handleCommit() {
    setCommitError(null);
    setCommitErrors([]);
    setCommitting(true);
    try {
      await api.post(`/api/schemas/${schemaSlug}/versions`, { yaml, commit_message: commitMessage || undefined });
      setShowCommit(false);
      setCommitMessage("");
      setCommitting(false);
      refetch();
      refetchVersions();
    } catch (err: unknown) {
      if (err instanceof Error) {
        try {
          const body = JSON.parse(err.message.replace(/^[^{]*/, ""));
          if (body.details) { setCommitErrors(body.details); setCommitting(false); return; }
        } catch { /* not JSON */ }
        setCommitError(err.message);
      }
      setCommitting(false);
    }
  }

  function handleDiscard() {
    setYaml(committedYaml);
    setCommitErrors([]);
  }

  function handleLoadVersion(v: SchemaVersion) {
    api.get<{ yamlSource: string }>(`/api/schemas/${schemaSlug}/versions/${v.versionNumber}`)
      .then((data) => { setYaml(data.yamlSource); setShowHistory(false); });
  }

  async function handleRun() {
    if (!selectedDocId || !yaml) return;
    setExtracting(true);
    setExtractionResult(null);
    setGtSaved(false);
    setParseProgress({ pages: 0, scanned: false, ocr_skipped: false, estimated_seconds: 0, percent: 0, estimated_remaining_seconds: 0, phase: "detecting" });

    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:9401";
    try {
      // Raw fetch needed for SSE streaming — can't use api.post which parses JSON.
      // Build auth headers through the same path as api.post.
      const fetchHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "x-koji-tenant": tenantSlug,
      };
      const tokenProvider = getAuthTokenProvider();
      if (tokenProvider) {
        const token = await tokenProvider();
        if (token) fetchHeaders["Authorization"] = `Bearer ${token}`;
      }

      const resp = await fetch(`${API_BASE}/api/extract/run`, {
        method: "POST",
        headers: fetchHeaders,
        body: JSON.stringify({ corpus_entry_id: selectedDocId, schema_yaml: yaml, ...(selectedModel ? { model: selectedModel } : {}) }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        setExtractionResult({ extracted: {}, confidence: 0, error: (err as { error?: string }).error ?? `HTTP ${resp.status}` });
        setExtracting(false);
        setParseProgress(null);
        return;
      }

      const contentType = resp.headers.get("content-type") ?? "";

      if (contentType.includes("text/event-stream")) {
        // SSE streaming path
        const reader = resp.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let currentEvent = "message";
          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              let data: any;
              try { data = JSON.parse(line.slice(6)); } catch { continue; }

              if (currentEvent === "parse_started") {
                setParseProgress((p) => ({
                  ...p!,
                  pages: data.pages,
                  scanned: data.scanned,
                  ocr_skipped: data.ocr_skipped,
                  estimated_seconds: data.estimated_seconds,
                  phase: "parsing",
                }));
              } else if (currentEvent === "parse_progress") {
                setParseProgress((p) => ({
                  ...p!,
                  percent: data.percent,
                  estimated_remaining_seconds: data.estimated_remaining_seconds,
                  phase: "parsing",
                }));
              } else if (currentEvent === "parse_complete") {
                setParseProgress((p) => ({ ...p!, percent: 100, phase: "extracting" }));
              } else if (currentEvent === "extracting") {
                setParseProgress((p) => ({ ...p!, phase: "extracting" }));
              } else if (currentEvent === "complete") {
                setExtractionResult(data);
                setEditorTab("results");
                setParseProgress((p) => ({ ...p!, phase: "done" }));
              } else if (currentEvent === "error") {
                setExtractionResult({ extracted: {}, confidence: 0, error: data.error ?? "Unknown error" });
              }
              currentEvent = "message";
            }
          }
        }
      } else {
        // JSON fallback path
        const result = await resp.json();
        if (result.error) {
          setExtractionResult({ extracted: {}, confidence: 0, error: result.error });
        } else {
          setExtractionResult(result);
          setEditorTab("results");
        }
        setParseProgress(null);
      }
    } catch (err: unknown) {
      setExtractionResult({
        extracted: {},
        confidence: 0,
        error: err instanceof Error ? err.message : "Extraction failed",
      });
    } finally {
      setExtracting(false);
    }
  }

  async function handleUploadDoc(file: File) {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const entry = await api.postForm<CorpusEntry>(`/api/schemas/${schemaSlug}/corpus`, formData);
      refetchCorpus();
      setSelectedDocId(entry.id);
    } catch (err) {
      console.error(err);
    } finally {
      setUploading(false);
    }
  }

  // Load signed URL when document is selected
  useEffect(() => {
    if (!selectedDocId) { setDocPreviewUrl(null); return; }
    api.get<{ url: string }>(`/api/schemas/${schemaSlug}/corpus/${selectedDocId}/url`)
      .then((r) => setDocPreviewUrl(r.url))
      .catch(() => setDocPreviewUrl(null));
  }, [selectedDocId, schemaSlug]);

  async function handleSaveDescription() {
    await api.patch(`/api/schemas/${schemaSlug}`, { description: descriptionDraft });
    setEditingDescription(false);
    refetch();
  }

  // Loading
  if (schemaLoading && !schemaDetail) {
    return (
      <div className="flex flex-col h-[calc(100vh-60px)]">
        <div className="p-10 animate-pulse">
          <div className="h-4 w-32 bg-cream-2 rounded mb-4" />
          <div className="h-8 w-48 bg-cream-2 rounded mb-2" />
          <div className="h-3 w-64 bg-cream-2 rounded" />
        </div>
      </div>
    );
  }

  // Not found / error — render an explicit empty state instead of the
  // forever-skeleton that used to sit here when the schema 404'd.
  if (schemaError || !schemaDetail) {
    const notFound = schemaError?.message.toLowerCase().includes("not found") ?? !schemaDetail;
    return (
      <div className="flex flex-col h-[calc(100vh-60px)]">
        <div className="px-10 pt-5 pb-0 shrink-0">
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-3">
            <span className="text-ink-3">{projectName}</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink-3">Schemas</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium">{schemaSlug}</span>
          </nav>
        </div>
        <EmptyState
          icon={<FileQuestion className="w-10 h-10" />}
          title={notFound ? "Schema not found" : "Cannot reach API"}
          description={
            notFound
              ? `No schema with slug "${schemaSlug}" exists in this workspace.`
              : (schemaError?.message ?? "Unknown error")
          }
          action={
            <Link
              href={`/t/${tenantSlug}`}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
            >
              Back to schemas
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col h-[calc(100vh-60px)]">
        {/* ── 1. Breadcrumb ── */}
        <div className="px-10 pt-5 pb-0 shrink-0">
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-ink-4 mb-3">
            <span className="text-ink-3">{projectName}</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink-3">Schemas</span>
            <span className="text-cream-4">/</span>
            <span className="text-ink font-medium">{schemaDetail.displayName}</span>
          </nav>
        </div>

        {/* ── 2. Heading area ── */}
        <div className="px-10 pb-4 shrink-0 flex items-start justify-between gap-8">
          <div>
            {/* Schema name + badges */}
            <div className="flex items-center gap-3 mb-1">
              <h1
                className="font-display text-[30px] font-medium leading-none tracking-tight text-ink"
                style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
              >
                {schemaDetail.displayName}
              </h1>
              {currentVersion > 0 && (
                <span className="font-mono text-[11px] text-ink-4 border border-border rounded-sm px-1.5 py-0.5">
                  v{currentVersion}
                </span>
              )}
              {hasChanges && (
                <span className="font-mono text-[10px] font-medium text-cream bg-vermillion-2 rounded-sm px-1.5 py-0.5 uppercase tracking-[0.06em]">
                  {changedLines} unsaved
                </span>
              )}
            </div>

            {/* Description */}
            <div className="flex items-center gap-1.5 mt-1">
              {editingDescription ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={descriptionDraft}
                    onChange={(e) => setDescriptionDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveDescription();
                      if (e.key === "Escape") setEditingDescription(false);
                    }}
                    className="text-[13px] text-ink-3 bg-transparent border-b border-border outline-none py-0.5 w-80 focus:border-ring"
                  />
                  <button onClick={handleSaveDescription} className="text-[11px] text-green font-mono">save</button>
                  <button onClick={() => setEditingDescription(false)} className="text-[11px] text-ink-4 font-mono">cancel</button>
                </div>
              ) : (
                <>
                  <span className="text-[13px] text-ink-3">
                    {schemaDetail.description || "Add a description..."}
                  </span>
                  <button
                    onClick={() => { setDescriptionDraft(schemaDetail.description ?? ""); setEditingDescription(true); }}
                    className="text-ink-4 hover:text-ink transition-colors p-0.5"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Right: action buttons */}
          <div className="flex items-center gap-2 shrink-0 pt-1">
            <div className="relative" ref={historyRef}>
              <button onClick={() => setShowHistory(!showHistory)}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors">
                <History className="w-3.5 h-3.5" />
                History
              </button>

              {/* Version history dropdown */}
              {showHistory && (
                <div className="absolute right-0 top-full mt-1 w-[320px] bg-white border border-border rounded-sm shadow-lg z-30 overflow-hidden">
                  <div className="px-3 py-2 border-b border-border font-mono text-[9.5px] font-medium tracking-[0.1em] uppercase text-ink-4">
                    Version history
                  </div>
                  <div className="max-h-[300px] overflow-y-auto">
                    {(versions ?? []).map((v) => (
                      <button key={v.id} onClick={() => handleLoadVersion(v)}
                        className="w-full text-left px-3 py-2.5 hover:bg-cream-2 transition-colors flex items-center justify-between group border-b border-dotted border-border last:border-none">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-ink font-medium">v{v.versionNumber}</span>
                            <span className="text-[10px] text-ink-4">{v.committedByName}</span>
                            <span className="text-[10px] text-ink-4">{timeAgo(v.createdAt)}</span>
                          </div>
                          {v.commitMessage && (
                            <div className="text-[11px] text-ink-3 truncate mt-0.5">{v.commitMessage}</div>
                          )}
                        </div>
                        <span className="text-[10px] text-vermillion-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-2">
                          load
                        </span>
                      </button>
                    ))}
                    {(versions ?? []).length === 0 && (
                      <div className="px-3 py-4 text-[12px] text-ink-4 text-center">No versions yet</div>
                    )}
                  </div>
                </div>
              )}
            </div>

            <button onClick={handleDiscard} disabled={!hasChanges}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              <RotateCcw className="w-3.5 h-3.5" />
              Discard
            </button>

            <button onClick={() => setShowCommit(true)} disabled={!hasChanges}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
              Save v{nextVersion}
            </button>
          </div>
        </div>

        {/* ── 3. Workbench panels ── */}
        <div className="flex-1 min-h-0 grid border-t border-border" style={{
          gridTemplateColumns: focusPanel === "editor" ? "1fr 0px" : focusPanel === "document" ? "0px 1fr" : "1fr 1.6fr",
          transition: "grid-template-columns 300ms cubic-bezier(0.4,0,0.2,1)",
        }}>
          {/* LEFT: Schema editor / Results (tabbed) */}
          <div className="bg-cream-2/50 min-h-0 flex flex-col border-r border-border overflow-hidden">
            {/* Tab bar */}
            <div className="flex items-center justify-between border-b border-border/50 shrink-0">
              <div className="flex">
                <button
                  onClick={() => setEditorTab("schema")}
                  className={`px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.08em] uppercase border-b-2 transition-colors ${editorTab === "schema" ? "text-ink border-vermillion-2" : "text-ink-4 border-transparent hover:text-ink"}`}
                >
                  Schema
                </button>
                <button
                  onClick={() => setEditorTab("results")}
                  className={`px-3 py-1.5 font-mono text-[10px] font-medium tracking-[0.08em] uppercase border-b-2 transition-colors ${editorTab === "results" ? "text-ink border-vermillion-2" : "text-ink-4 border-transparent hover:text-ink"} ${!extractionResult && !extracting ? "opacity-30 cursor-not-allowed" : ""}`}
                  disabled={!extractionResult && !extracting}
                >
                  Results
                  {extracting && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-vermillion-2 animate-pulse" />}
                </button>
              </div>
              <button
                onClick={() => setFocusPanel(focusPanel === "editor" ? "split" : "editor")}
                className="text-ink-4 hover:text-ink transition-colors p-1 rounded-sm hover:bg-cream-2 mr-2"
                title={focusPanel === "editor" ? "Split view" : "Expand editor"}
              >
                {focusPanel === "editor" ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* Schema editor tab */}
            {editorTab === "schema" && (
              <>
                <div className="flex-1 min-h-0 overflow-y-auto relative">
                  <div className="flex min-h-full">
                    {/* Line numbers gutter */}
                    <div
                      className="shrink-0 pt-4 pb-4 pl-3 pr-2 text-right select-none font-mono text-[13px] leading-[1.7] text-ink-4/30 border-r border-border/50 bg-cream-2/30 sticky left-0"
                      aria-hidden
                    >
                      {yaml.split("\n").map((_, i) => (
                        <div key={i}>{i + 1}</div>
                      ))}
                    </div>
                    {/* Editor with YAML syntax highlighting */}
                    <div className="flex-1 relative">
                      <pre
                        className="pt-4 pb-4 pr-4 pl-3 font-mono text-[13px] leading-[1.7] whitespace-pre-wrap break-words m-0 min-h-full"
                        style={{ tabSize: 2 }}
                        aria-hidden
                        dangerouslySetInnerHTML={{ __html: highlightYaml(yaml) || '<span style="color:#998E78"># Start writing your schema YAML here...</span>' }}
                      />
                      <textarea
                        ref={textareaRef}
                        value={yaml}
                        onChange={(e) => setYaml(e.target.value)}
                        spellCheck={false}
                        className="absolute inset-0 w-full h-full pt-4 pb-4 pr-4 pl-3 font-mono text-[13px] leading-[1.7] text-transparent bg-transparent resize-none outline-none border-none overflow-hidden caret-ink"
                        style={{ tabSize: 2, caretColor: "#171410" }}
                      />
                    </div>
                  </div>
                </div>

                {/* Validation errors panel */}
                {commitErrors.length > 0 && (
                  <div className="border-t border-vermillion-2/30 bg-vermillion-3/30 p-3 max-h-[180px] overflow-y-auto shrink-0">
                    <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-vermillion-2 mb-1.5">
                      Validation errors
                    </div>
                    {commitErrors.map((e, i) => (
                      <div key={i} className="text-[11px] text-vermillion-2 font-mono py-0.5">
                        {e.field ? `${e.field}: ` : ""}{e.message}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Results tab */}
            {editorTab === "results" && (
              <div className="flex-1 min-h-0 overflow-y-auto">
                {extracting && parseProgress && (
                  <div className="p-4">
                    <div className="border border-border rounded-sm p-5 bg-cream">
                      <div className="text-[13px] font-medium text-ink mb-1">
                        {parseProgress.phase === "detecting" && "Analyzing document..."}
                        {parseProgress.phase === "parsing" && (parseProgress.scanned ? "Scanned document detected" : "Processing document")}
                        {parseProgress.phase === "extracting" && "Running extraction..."}
                      </div>
                      {parseProgress.phase === "parsing" && parseProgress.pages > 0 && (
                        <>
                          <div className="text-[12px] text-ink-3 mb-2">
                            Page {Math.min(Math.round(parseProgress.percent / 100 * parseProgress.pages), parseProgress.pages)} of {parseProgress.pages}
                          </div>
                          <div className="w-full h-2 bg-cream-2 rounded-full overflow-hidden mb-2">
                            <div className="h-full bg-vermillion-2 rounded-full transition-all duration-1000 ease-linear" style={{ width: `${parseProgress.percent}%` }} />
                          </div>
                          <div className="text-[11px] text-ink-4">
                            {parseProgress.estimated_remaining_seconds > 60
                              ? `~${Math.ceil(parseProgress.estimated_remaining_seconds / 60)} min remaining`
                              : parseProgress.estimated_remaining_seconds > 5
                                ? `~${Math.round(parseProgress.estimated_remaining_seconds)}s remaining`
                                : "Almost done..."}
                          </div>
                        </>
                      )}
                      {parseProgress.phase === "extracting" && (
                        <div className="text-[11px] text-ink-4 animate-pulse">Sending to extraction model...</div>
                      )}
                    </div>
                  </div>
                )}

                {extracting && !parseProgress && (
                  <div className="h-full flex items-center justify-center">
                    <div className="animate-pulse font-mono text-[11px] text-ink-4">Processing...</div>
                  </div>
                )}

                {extractionResult && !extracting && (
                  <div className="p-3">
                    {extractionResult.error ? (
                      <div className="text-[12px] text-vermillion-2 font-mono bg-vermillion-3/20 p-3 rounded-sm">
                        {extractionResult.error}
                      </div>
                    ) : (
                      <>
                        {/* Metadata strip */}
                        <div className="flex items-center gap-3 px-1 py-1.5 mb-2 text-[10px] font-mono text-ink-4">
                          <span>{Object.keys(extractionResult.extracted).length} fields</span>
                          {extractionResult.elapsed_ms && <span>{(extractionResult.elapsed_ms / 1000).toFixed(1)}s</span>}
                          {extractionResult.model && <span>{extractionResult.model}</span>}
                          {extractionResult.confidence > 0 && (
                            <span className={extractionResult.confidence >= 0.9 ? "text-green" : "text-vermillion-2"}>
                              {(extractionResult.confidence * 100).toFixed(0)}%
                            </span>
                          )}
                        </div>

                        {/* Results table */}
                        <div className="border border-border rounded-sm divide-y divide-dotted divide-border">
                          {Object.entries(extractionResult.extracted).map(([key, value]) => {
                            const prov = extractionResult.provenance?.[key];
                            const hasProvenance = prov != null;
                            const isHighlighted = highlightedField === key;
                            return (
                              <div
                                key={key}
                                className={`flex items-start justify-between px-3 py-2 gap-3 ${hasProvenance ? "cursor-pointer hover:bg-cream-2/80 transition-colors" : ""} ${isHighlighted ? "bg-vermillion-3/20 border-l-2 border-l-vermillion-2" : ""}`}
                                onClick={() => {
                                  if (!hasProvenance) return;
                                  setHighlightedField(isHighlighted ? null : key);
                                  // Scroll document preview to show provenance context
                                  const previewEl = document.querySelector("[data-provenance-preview]");
                                  if (previewEl) {
                                    const mark = previewEl.querySelector(`[data-provenance-field="${key}"]`);
                                    mark?.scrollIntoView({ behavior: "smooth", block: "center" });
                                  }
                                }}
                              >
                                <span className="font-mono text-[11px] text-ink-4 shrink-0 flex items-center gap-1">
                                  {hasProvenance && (
                                    <MapPin className={`w-3 h-3 ${isHighlighted ? "text-vermillion-2" : "text-ink-4/50"}`} />
                                  )}
                                  {key}
                                </span>
                                <span className="text-[12px] text-ink text-right break-words min-w-0">
                                  {typeof value === "object" ? JSON.stringify(value) : String(value ?? "\u2014")}
                                </span>
                                {extractionResult.confidence_scores?.[key] !== undefined && (
                                  <span className={`shrink-0 font-mono text-[10px] ${extractionResult.confidence_scores[key]! >= 0.9 ? "text-green" : extractionResult.confidence_scores[key]! >= 0.7 ? "text-yellow-600" : "text-vermillion-2"}`}>
                                    {(extractionResult.confidence_scores[key]! * 100).toFixed(0)}%
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Save as Ground Truth */}
                        {selectedDocId && (
                          <div className="mt-3">
                            <button
                              disabled={savingGT || gtSaved}
                              onClick={async () => {
                                setSavingGT(true);
                                try {
                                  await api.post(`/api/schemas/${schemaSlug}/corpus/${selectedDocId}/ground-truth`, {
                                    values: extractionResult.extracted,
                                  });
                                  setGtSaved(true);
                                } catch (err) {
                                  console.error("Failed to save ground truth:", err);
                                } finally {
                                  setSavingGT(false);
                                }
                              }}
                              className={`w-full py-2 rounded-sm text-[12px] font-medium transition-colors ${
                                gtSaved
                                  ? "bg-green/10 text-green border border-green/30 cursor-default"
                                  : "bg-cream-2 text-ink-3 border border-border hover:border-ink hover:text-ink"
                              } disabled:opacity-50`}
                            >
                              {gtSaved ? "Saved as ground truth" : savingGT ? "Saving..." : "Save as ground truth"}
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {!extractionResult && !extracting && (
                  <div className="h-full flex items-center justify-center">
                    {(catalogModels ?? []).length === 0 ? (
                      <div className="text-center max-w-[300px]">
                        <div className="text-[13px] text-ink font-medium mb-1">No model endpoint configured</div>
                        <p className="text-[12px] text-ink-3 mb-3">
                          Add your OpenAI, Anthropic, or other LLM API key in Settings before running extraction.
                        </p>
                        <a href={`/t/${tenantSlug}/settings/model-providers`}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-sm text-[12px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
                          Configure model endpoint
                        </a>
                      </div>
                    ) : (
                      <div className="text-[12px] text-ink-4">Run extraction to see results here.</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* RIGHT: Document + extraction */}
          <div className="bg-cream min-h-0 flex flex-col border-l border-border overflow-hidden">
            {/* Document controls bar */}
            <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <button
                  onClick={() => setFocusPanel(focusPanel === "document" ? "split" : "document")}
                  className="text-ink-4 hover:text-ink transition-colors p-1 rounded-sm hover:bg-cream-2"
                  title={focusPanel === "document" ? "Split view" : "Expand document"}
                >
                  {focusPanel === "document" ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                </button>
                <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">Document</span>
                <select
                  value={selectedDocId ?? ""}
                  onChange={(e) => setSelectedDocId(e.target.value || null)}
                  className="h-[26px] rounded-sm border border-input bg-white px-2 text-[12px] outline-none focus:border-ring min-w-[100px] max-w-[200px] truncate"
                >
                  <option value="">Select...</option>
                  {(corpusEntries ?? []).map((e) => (
                    <option key={e.id} value={e.id}>{e.filename}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <label className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors cursor-pointer ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
                  <Upload className="w-3 h-3" />
                  {uploading ? "Uploading..." : "Upload"}
                  <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                    onChange={(e) => { if (e.target.files?.[0]) handleUploadDoc(e.target.files[0]); }} />
                </label>
                <select
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  className="h-[26px] rounded-sm border border-input bg-white px-2 text-[11px] font-mono outline-none focus:border-ring min-w-[80px] max-w-[160px] truncate"
                  title="Model for extraction"
                >
                  <option value="">Default model</option>
                  {(catalogModels ?? []).map((m) => (
                    <option key={m.id} value={m.modelId}>{m.displayName} ({m.provider})</option>
                  ))}
                </select>
                <button onClick={handleRun} disabled={!selectedDoc || extracting || (catalogModels ?? []).length === 0}
                  title={(catalogModels ?? []).length === 0 ? "Configure a model endpoint in Settings → Model Endpoints first" : undefined}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[12px] font-medium bg-vermillion-2 text-cream transition-colors disabled:opacity-30">
                  <Play className="w-3 h-3" />
                  {extracting ? "Running..." : "Run"}
                  <kbd className="font-mono text-[9px] text-cream/50 ml-0.5">⌘↵</kbd>
                </button>
              </div>
            </div>

            {/* Document content area */}
            <div className="flex-1 overflow-y-auto">
              {!selectedDoc ? (
                /* No document selected */
                <div className="h-full flex flex-col items-center justify-center text-center p-5">
                  <label className="border-2 border-dashed border-border rounded-sm p-8 w-full max-w-[360px] cursor-pointer hover:border-ink-4 transition-colors">
                    <Upload className="w-8 h-8 text-ink-4 mx-auto mb-3" />
                    <div className="text-[13px] text-ink-3 mb-1">
                      {(corpusEntries ?? []).length === 0 ? "Upload a test document" : "Upload another document"}
                    </div>
                    <div className="text-[11px] text-ink-4">
                      PDF, PNG, JPG, or TIFF — click or drag a file here
                    </div>
                    <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                      onChange={(e) => { if (e.target.files?.[0]) handleUploadDoc(e.target.files[0]); }} />
                  </label>

                  {/* Field preview */}
                  {fields.length > 0 && (
                    <div className="w-full max-w-[360px] mt-6">
                      <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-2 text-left">
                        Schema fields ({fields.length})
                      </div>
                      <div className="space-y-1.5">
                        {fields.map((f) => (
                          <div key={f.name} className="flex items-center gap-2 px-2.5 py-1.5 border border-border rounded-sm text-left">
                            <span className="font-mono text-[11px] text-ink font-medium">{f.name}</span>
                            <span className="font-mono text-[9px] text-ink-4 bg-cream-2 px-1.5 py-0.5 rounded-sm uppercase">{f.type}</span>
                            {f.required && <span className="font-mono text-[8px] text-vermillion-2 uppercase">req</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {parseError && (
                    <div className="w-full max-w-[360px] mt-4 text-left">
                      <div className="text-[12px] text-vermillion-2 font-mono bg-vermillion-3/20 p-3 rounded-sm">
                        YAML parse error: {parseError}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Document selected — full-height preview */
                <div className="p-2 h-full flex flex-col">
                  {docPreviewUrl ? (
                    selectedDoc.mimeType === "application/pdf" ? (
                      <iframe
                        src={docPreviewUrl}
                        className={`w-full border border-border rounded-sm min-h-0 ${highlightedField ? "flex-[3]" : "flex-1"}`}
                        title={selectedDoc.filename}
                      />
                    ) : (
                      <img
                        src={docPreviewUrl}
                        alt={selectedDoc.filename}
                        className={`w-full border border-border rounded-sm object-contain ${highlightedField ? "flex-[3]" : "flex-1"}`}
                      />
                    )
                  ) : (
                    <div className={`border border-border rounded-sm flex items-center justify-center ${highlightedField ? "flex-[3]" : "flex-1"}`}>
                      <span className="animate-pulse font-mono text-[11px] text-ink-4">Loading preview...</span>
                    </div>
                  )}

                  {/* Provenance highlight panel */}
                  {highlightedField && extractionResult?.provenance?.[highlightedField] && (
                    <div className="mt-2 border border-vermillion-2/30 rounded-sm bg-vermillion-3/10 p-3 shrink-0">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5">
                          <MapPin className="w-3 h-3 text-vermillion-2" />
                          <span className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-vermillion-2">
                            Source: {highlightedField}
                          </span>
                        </div>
                        <button
                          onClick={() => setHighlightedField(null)}
                          className="text-[10px] text-ink-4 hover:text-ink font-mono"
                        >
                          dismiss
                        </button>
                      </div>
                      <div className="font-mono text-[12px] text-ink bg-cream rounded-sm px-3 py-2 border border-border">
                        <span className="bg-vermillion-3/40 text-vermillion-2 px-0.5 rounded-sm">
                          {extractionResult.provenance[highlightedField]!.chunk ?? String(extractionResult.extracted[highlightedField] ?? "")}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] text-ink-4 font-mono">
                        offset {extractionResult.provenance[highlightedField]!.offset}, {extractionResult.provenance[highlightedField]!.length} chars
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Commit dialog ── */}
      {showCommit && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="absolute inset-0 bg-ink/20" onClick={() => setShowCommit(false)} />
          <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
            <h2 className="text-[15px] font-medium text-ink mb-1">Save version v{nextVersion}</h2>
            <p className="text-[12.5px] text-ink-3 mb-5">
              This will validate the schema YAML and create a new committed version.
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-[12.5px] font-medium text-ink">Commit message</label>
                <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} autoFocus
                  placeholder="e.g. Add line_items array field"
                  data-1p-ignore autoComplete="off"
                  onKeyDown={(e) => { if (e.key === "Enter" && !committing) handleCommit(); }}
                  className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
              </div>

              {commitError && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{commitError}</div>}

              <div className="flex items-center justify-end gap-2">
                <button onClick={() => { setShowCommit(false); setCommitError(null); setCommitErrors([]); }}
                  className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
                <button onClick={handleCommit} disabled={committing}
                  className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-vermillion-2 text-cream hover:bg-vermillion transition-colors disabled:opacity-50">
                  {committing ? "Saving..." : `Save v${nextVersion}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
