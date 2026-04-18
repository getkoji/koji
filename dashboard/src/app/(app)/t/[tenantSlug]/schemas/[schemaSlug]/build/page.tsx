"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { parse as parseYaml } from "yaml";
import { useParams } from "next/navigation";
import { WorkbenchLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import { Badge } from "@/components/shared/SettingsComponents";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface SchemaDetail {
  id: string;
  slug: string;
  displayName: string;
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

function parseFields(yamlText: string): { fields: ParsedField[]; error: string | null } {
  try {
    const doc = parseYaml(yamlText);
    if (!doc?.fields || typeof doc.fields !== "object") {
      return { fields: [], error: null };
    }

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

export default function BuildPage() {
  const params = useParams();
  const schemaSlug = params.schemaSlug as string;

  const { data: schemaDetail, refetch } = useApi(
    useCallback(() => api.get<SchemaDetail>(`/api/schemas/${schemaSlug}`), [schemaSlug]),
  );

  const { data: versions, refetch: refetchVersions } = useApi(
    useCallback(() => api.get<{ data: SchemaVersion[] }>(`/api/schemas/${schemaSlug}/versions`).then((r) => r.data), [schemaSlug]),
  );

  const [yaml, setYaml] = useState("");
  const [initialized, setInitialized] = useState(false);
  const [showCommit, setShowCommit] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitErrors, setCommitErrors] = useState<Array<{ field?: string; message: string }>>([]);

  // Initialize editor with latest version YAML
  useEffect(() => {
    if (schemaDetail && !initialized) {
      const initialYaml = schemaDetail.latestVersion?.yamlSource ?? schemaDetail.draftYaml ?? "";
      setYaml(initialYaml);
      setInitialized(true);
    }
  }, [schemaDetail, initialized]);

  // Parse fields for preview (debounced via useMemo)
  const { fields, error: parseError } = useMemo(() => parseFields(yaml), [yaml]);

  const hasChanges = schemaDetail?.latestVersion?.yamlSource !== yaml;

  async function handleCommit() {
    setCommitError(null);
    setCommitErrors([]);
    setCommitting(true);
    try {
      await api.post(`/api/schemas/${schemaSlug}/versions`, {
        yaml,
        commit_message: commitMessage || undefined,
      });
      setShowCommit(false);
      setCommitMessage("");
      refetch();
      refetchVersions();
    } catch (err: unknown) {
      if (err instanceof Error) {
        // Try to parse validation errors from the response
        try {
          const body = JSON.parse(err.message.replace("API error 422: ", "").replace(/^[^{]*/, ""));
          if (body.details) {
            setCommitErrors(body.details);
            setCommitting(false);
            return;
          }
        } catch { /* not JSON */ }
        setCommitError(err.message);
      }
      setCommitting(false);
    }
  }

  function handleLoadVersion(version: SchemaVersion) {
    // Fetch the version's YAML and load it
    api.get<{ yamlSource: string }>(`/api/schemas/${schemaSlug}/versions/${version.versionNumber}`)
      .then((v) => { setYaml(v.yamlSource); setShowVersions(false); });
  }

  if (!schemaDetail) {
    return (
      <WorkbenchLayout
        header={<><Breadcrumbs items={[{ label: "Schema" }, { label: "Build" }]} /><PageHeader title="Build" /></>}
        left={<div className="animate-pulse font-mono text-[11px] text-ink-4 p-4">Loading...</div>}
        right={<div />}
      />
    );
  }

  return (
    <>
    <WorkbenchLayout
      header={
        <>
          <Breadcrumbs items={[{ label: schemaDetail.displayName }, { label: "Build" }]} />
          <PageHeader
            title="Build"
            meta={
              <span className="flex items-center gap-2">
                {schemaDetail.latestVersion && (
                  <span className="font-mono text-[11px] text-ink-4">v{schemaDetail.latestVersion.versionNumber}</span>
                )}
                {hasChanges && <Badge>unsaved changes</Badge>}
              </span>
            }
            actions={
              <div className="flex items-center gap-2">
                <button onClick={() => setShowVersions(!showVersions)}
                  className="inline-flex items-center px-3 py-1.5 rounded-sm text-[12px] text-ink-3 border border-border hover:border-ink transition-colors">
                  History
                </button>
                <button onClick={() => setShowCommit(true)} disabled={!hasChanges}
                  className="inline-flex items-center px-3.5 py-1.5 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-40">
                  Commit
                </button>
              </div>
            }
          />
        </>
      }
      left={
        <div className="h-full flex flex-col">
          {/* YAML Editor */}
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
            className="flex-1 w-full p-4 font-mono text-[12px] leading-[1.6] text-ink bg-transparent resize-none outline-none border-none"
            style={{ tabSize: 2 }}
          />

          {/* Validation errors */}
          {commitErrors.length > 0 && (
            <div className="border-t border-vermillion-2/30 bg-vermillion-3/20 p-3 max-h-[200px] overflow-y-auto">
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

          {/* Version history drawer */}
          {showVersions && (
            <div className="border-t border-border bg-cream-2/50 p-3 max-h-[250px] overflow-y-auto">
              <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-2">
                Version history
              </div>
              {(versions ?? []).map((v) => (
                <button key={v.id} onClick={() => handleLoadVersion(v)}
                  className="w-full text-left px-2 py-1.5 hover:bg-cream-2 rounded-sm transition-colors flex items-center justify-between group">
                  <div>
                    <span className="font-mono text-[11px] text-ink font-medium">v{v.versionNumber}</span>
                    {v.commitMessage && <span className="text-[11px] text-ink-3 ml-2">{v.commitMessage}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-ink-4">{v.committedByName}</span>
                    <span className="text-[10px] text-ink-4">{timeAgo(v.createdAt)}</span>
                    <span className="text-[10px] text-vermillion-2 opacity-0 group-hover:opacity-100 transition-opacity">load</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      }
      right={
        <div className="p-4 overflow-y-auto h-full">
          <div className="font-mono text-[10px] font-medium tracking-[0.08em] uppercase text-ink-4 mb-3">
            Fields ({fields.length})
          </div>

          {parseError ? (
            <div className="text-[12px] text-vermillion-2 font-mono bg-vermillion-3/20 p-3 rounded-sm">
              {parseError}
            </div>
          ) : fields.length === 0 ? (
            <div className="text-[12px] text-ink-4 text-center py-8">
              No fields defined yet
            </div>
          ) : (
            <div className="space-y-2">
              {fields.map((f) => (
                <div key={f.name} className="border border-border rounded-sm p-2.5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-mono text-[12px] text-ink font-medium">{f.name}</span>
                    <Badge>{f.type}</Badge>
                    {f.required && <span className="font-mono text-[9px] text-vermillion-2 uppercase">req</span>}
                    {f.nullable && <span className="font-mono text-[9px] text-ink-4 uppercase">null</span>}
                  </div>
                  {f.validate && Object.keys(f.validate).length > 0 && (
                    <div className="font-mono text-[10px] text-ink-4">
                      {Object.entries(f.validate).map(([k, v]) => `${k}: ${v}`).join(", ")}
                    </div>
                  )}
                  {f.extraction_guidance && (
                    <div className="text-[10.5px] text-ink-3 mt-1 line-clamp-2">
                      {f.extraction_guidance}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      }
    />

    {/* Commit dialog */}
    {showCommit && (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-ink/20" onClick={() => setShowCommit(false)} />
        <div className="relative bg-cream border border-border rounded-sm shadow-lg w-full max-w-[420px] p-6">
          <h2 className="text-[15px] font-medium text-ink mb-1">Commit version</h2>
          <p className="text-[12.5px] text-ink-3 mb-5">
            This will validate the schema and create version {(schemaDetail.latestVersion?.versionNumber ?? 0) + 1}.
          </p>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[12.5px] font-medium text-ink">Commit message</label>
              <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} autoFocus
                placeholder="e.g. Add line_items array field"
                data-1p-ignore autoComplete="off"
                className="w-full h-[30px] rounded-sm border border-input bg-transparent px-2.5 text-[13px] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 placeholder:text-ink-4" />
            </div>

            {commitError && <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{commitError}</div>}

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => { setShowCommit(false); setCommitError(null); setCommitErrors([]); }}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] text-ink-3 hover:text-ink transition-colors">Cancel</button>
              <button onClick={handleCommit} disabled={committing}
                className="inline-flex items-center px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50">
                {committing ? "Committing..." : "Commit"}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
