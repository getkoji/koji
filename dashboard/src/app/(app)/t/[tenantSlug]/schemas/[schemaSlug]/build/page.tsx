"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { parse as parseYaml } from "yaml";
import { useParams, usePathname } from "next/navigation";
import { Pencil, History, RotateCcw, Play, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

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

  const { data: schemaDetail, refetch } = useApi(
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
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

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

  async function handleSaveDescription() {
    await api.patch(`/api/schemas/${schemaSlug}`, { description: descriptionDraft });
    setEditingDescription(false);
    refetch();
  }

  // Loading
  if (!schemaDetail) {
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
            <div className="flex items-baseline gap-3 mb-1">
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
        <div className="flex-1 min-h-0 grid grid-cols-2 border-t border-border">
          {/* LEFT: YAML editor */}
          <div className="bg-ink overflow-y-auto min-h-0 flex flex-col">
            <textarea
              ref={textareaRef}
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              spellCheck={false}
              className="flex-1 w-full p-4 font-mono text-[13px] leading-[1.7] text-cream bg-transparent resize-none outline-none border-none placeholder:text-ink-4"
              style={{ tabSize: 2, caretColor: "#F4EEE2" }}
              placeholder="# Start writing your schema YAML here..."
            />

            {/* Validation errors panel */}
            {commitErrors.length > 0 && (
              <div className="border-t border-vermillion-2/30 bg-vermillion-2/10 p-3 max-h-[180px] overflow-y-auto shrink-0">
                <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-vermillion-2 mb-1.5">
                  Validation errors
                </div>
                {commitErrors.map((e, i) => (
                  <div key={i} className="text-[11px] text-vermillion-3 font-mono py-0.5">
                    {e.field ? `${e.field}: ` : ""}{e.message}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT: Document + extraction */}
          <div className="bg-cream overflow-y-auto min-h-0 flex flex-col border-l border-border">
            {/* Document controls bar */}
            <div className="px-4 py-2.5 border-b border-border shrink-0 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-ink-4">Document</span>
                {sampleFile ? (
                  <span className="text-[12px] text-ink font-medium truncate max-w-[200px]">{sampleFile.name}</span>
                ) : (
                  <span className="text-[12px] text-ink-4">None selected</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink hover:text-ink transition-colors cursor-pointer">
                  <Upload className="w-3 h-3" />
                  Upload
                  <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                    onChange={(e) => { if (e.target.files?.[0]) setSampleFile(e.target.files[0]); }} />
                </label>
                <button disabled={!sampleFile}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sm text-[12px] font-medium bg-vermillion-2 text-cream transition-colors disabled:opacity-30">
                  <Play className="w-3 h-3" />
                  Run
                  <kbd className="font-mono text-[9px] text-cream/50 ml-0.5">⌘↵</kbd>
                </button>
              </div>
            </div>

            {/* Document content area */}
            <div className="flex-1 overflow-y-auto p-5">
              {!sampleFile ? (
                <div className="h-full flex flex-col items-center justify-center text-center">
                  <label className="border-2 border-dashed border-border rounded-sm p-8 w-full max-w-[360px] cursor-pointer hover:border-ink-4 transition-colors">
                    <Upload className="w-8 h-8 text-ink-4 mx-auto mb-3" />
                    <div className="text-[13px] text-ink-3 mb-1">Upload a sample document</div>
                    <div className="text-[11px] text-ink-4">
                      PDF, PNG, JPG, or TIFF — click or drag a file here
                    </div>
                    <input type="file" className="hidden" accept=".pdf,.png,.jpg,.jpeg,.tiff,.tif"
                      onChange={(e) => { if (e.target.files?.[0]) setSampleFile(e.target.files[0]); }} />
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
                /* Document uploaded — ready to run */
                <div className="text-center py-12">
                  <div className="font-mono text-[11px] text-ink-4 mb-2">{sampleFile.name}</div>
                  <div className="text-[13px] text-ink-3">
                    Click <strong className="text-ink">Run</strong> to extract with the current schema
                  </div>
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
