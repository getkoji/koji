"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { parse as parseYaml } from "yaml";
import { Loader2, Upload, Sparkles, Trash2, Check, Plus } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import {
  classifiers as classifiersApi,
  corpusPool,
  type ClassifierCorpusEntry,
  type CorpusPoolDoc,
} from "@/lib/api";
import { usePageTitle } from "@/lib/use-page-title";
import { ClassifierTabs } from "../ClassifierTabs";

const UNKNOWN = "unknown";

export default function ClassifierCorpusPage() {
  const params = useParams();
  const tenantSlug = params.tenantSlug as string;
  const slug = params.classifierSlug as string;
  const base = `/t/${tenantSlug}`;
  usePageTitle(`${slug} · corpus`);

  const [displayName, setDisplayName] = useState(slug);
  const [classIds, setClassIds] = useState<string[]>([]);
  const [entries, setEntries] = useState<ClassifierCorpusEntry[]>([]);
  const [pool, setPool] = useState<CorpusPoolDoc[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Label used for the next upload / attach; defaults to the first class.
  const [pendingLabel, setPendingLabel] = useState<string>("");

  const labelOptions = useMemo(() => [...classIds, UNKNOWN], [classIds]);

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4000);
  }, []);

  const load = useCallback(async () => {
    try {
      const [detail, corpus, poolDocs] = await Promise.all([
        classifiersApi.get(slug),
        classifiersApi.corpus(slug),
        corpusPool.list(),
      ]);
      setDisplayName(detail.displayName);
      // Parse the released (or draft) config's class ids for the label dropdown.
      const yamlSource = detail.latestVersion?.yamlSource ?? detail.draftYaml ?? "";
      try {
        const parsed = parseYaml(yamlSource) as { classes?: Record<string, unknown> } | null;
        const ids = parsed?.classes ? Object.keys(parsed.classes) : [];
        setClassIds(ids);
        setPendingLabel((prev) => prev || ids[0] || UNKNOWN);
      } catch {
        setClassIds([]);
      }
      setEntries(corpus);
      setPool(poolDocs);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load corpus");
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Pool documents not already in this classifier's corpus — the "attach" set.
  const attachable = useMemo(() => {
    const usedDocIds = new Set(entries.map((e) => e.documentId));
    return pool.filter((d) => !usedDocIds.has(d.id));
  }, [pool, entries]);

  async function onUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!pendingLabel) return flash("err", "Pick a label first.");
    setBusy("upload");
    try {
      for (const file of Array.from(files)) {
        await classifiersApi.uploadCorpus(slug, file, pendingLabel);
      }
      flash("ok", `Uploaded ${files.length} document(s) as “${pendingLabel}”.`);
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(null);
    }
  }

  async function attach(doc: CorpusPoolDoc) {
    if (!pendingLabel) return flash("err", "Pick a label first.");
    setBusy(`attach-${doc.id}`);
    try {
      await classifiersApi.attachCorpus(slug, doc.id, pendingLabel);
      flash("ok", `Labelled ${doc.filename} as “${pendingLabel}”.`);
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Attach failed");
    } finally {
      setBusy(null);
    }
  }

  async function remove(entry: ClassifierCorpusEntry) {
    setBusy(`rm-${entry.id}`);
    try {
      await classifiersApi.removeCorpus(slug, entry.id);
      setEntries((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Remove failed");
    } finally {
      setBusy(null);
    }
  }

  async function approve(entry: ClassifierCorpusEntry, label?: string) {
    if (!entry.latestGtId) return;
    setBusy(`ap-${entry.id}`);
    try {
      await classifiersApi.approve(slug, entry.id, entry.latestGtId, label);
      flash("ok", `Approved “${label ?? entry.proposedLabel}”.`);
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }

  async function bootstrap() {
    setBusy("bootstrap");
    try {
      const res = await classifiersApi.bootstrap(slug, 25);
      flash("ok", res.proposed ? `Proposed ${res.proposed} draft label(s) — review below.` : (res.message ?? "Nothing to label."));
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Bootstrap failed");
    } finally {
      setBusy(null);
    }
  }

  const draftCount = entries.filter((e) => e.reviewStatus === "draft").length;

  if (loadError) {
    return (
      <ListLayout header={<Breadcrumbs items={[{ label: tenantSlug, href: base }, { label: "Classifiers", href: `${base}/classifiers` }, { label: slug }]} />}>
        <ClassifierTabs base={base} slug={slug} active="corpus" />
        <p className="text-[13px] text-vermillion-2">{loadError}</p>
      </ListLayout>
    );
  }

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs items={[{ label: tenantSlug, href: base }, { label: "Classifiers", href: `${base}/classifiers` }, { label: displayName }]} />
          <PageHeader title={displayName} meta={<span>Backtest corpus — label documents with the class they should get.</span>} />
        </>
      }
    >
      <ClassifierTabs base={base} slug={slug} active="corpus" />

      {notice && (
        <div className={`text-[12px] px-3 py-1.5 rounded-sm mb-4 ${notice.kind === "ok" ? "text-ink bg-ink/[0.04]" : "text-vermillion-2 bg-vermillion-3/50"}`}>
          {notice.text}
        </div>
      )}

      {classIds.length === 0 && (
        <div className="text-[12px] px-3 py-1.5 rounded-sm mb-4 text-ink-3 bg-cream-2">
          This classifier has no released classes yet — release a version on the Config tab before labeling.
        </div>
      )}

      {/* Label picker + upload + bootstrap toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-5">
        <label className="text-[12px] text-ink-3">Label as</label>
        <select
          value={pendingLabel}
          onChange={(e) => setPendingLabel(e.target.value)}
          className="rounded-sm border border-input bg-transparent px-2 py-1.5 text-[12.5px] outline-none focus:border-ring"
        >
          {labelOptions.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>

        <label className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] border border-border cursor-pointer transition-colors ${busy ? "opacity-40 pointer-events-none" : "text-ink-3 hover:text-ink hover:border-ink-4"}`}>
          {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          Upload
          <input type="file" multiple className="hidden" onChange={(e) => void onUpload(e.target.files)} />
        </label>

        <button
          onClick={() => void bootstrap()}
          disabled={busy !== null || classIds.length === 0}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] text-ink-3 border border-border hover:text-ink hover:border-ink-4 transition-colors disabled:opacity-40"
          title="Run the classifier at max_tier 4 over unlabeled pool documents and propose draft labels"
        >
          {busy === "bootstrap" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          Auto-label unlabeled
        </button>

        {draftCount > 0 && (
          <span className="text-[11px] text-ink-4 ml-auto">{draftCount} draft{draftCount === 1 ? "" : "s"} awaiting review</span>
        )}
      </div>

      {/* Labelled corpus */}
      <div className="mb-8">
        <div className="text-[12.5px] font-medium text-ink mb-2">Labelled documents ({entries.length})</div>
        {entries.length === 0 ? (
          <p className="text-[12px] text-ink-4">No documents labelled yet. Upload files, attach from the pool below, or auto-label.</p>
        ) : (
          <div className="border border-border rounded-sm divide-y divide-border">
            {entries.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                <span className="flex-1 truncate text-ink" title={e.filename}>{e.filename}</span>
                {e.label ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded-sm bg-ink/[0.06] text-ink-2">{e.label}</span>
                ) : e.reviewStatus === "draft" && e.proposedLabel ? (
                  <span className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0.5 rounded-sm bg-vermillion/[0.10] text-vermillion-2">
                    {e.proposedLabel}?{e.authoredViaAgent && <span className="text-ink-4">agent</span>}
                  </span>
                ) : (
                  <span className="text-ink-4 text-[11px]">unlabeled</span>
                )}
                {e.reviewStatus === "draft" && e.latestGtId && (
                  <>
                    <select
                      defaultValue={e.proposedLabel ?? ""}
                      onChange={(ev) => {
                        // Correct-then-approve in one gesture when a different label is chosen.
                        const v = ev.target.value;
                        if (v && v !== e.proposedLabel) void approve(e, v);
                      }}
                      className="rounded-sm border border-input bg-transparent px-1.5 py-1 text-[11px] outline-none"
                      title="Change the label"
                    >
                      {labelOptions.map((id) => (
                        <option key={id} value={id}>{id}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => void approve(e)}
                      disabled={busy !== null}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] text-ink-3 border border-border hover:text-ink hover:border-ink-4 disabled:opacity-40"
                      title="Approve this draft into the scored ground truth"
                    >
                      {busy === `ap-${e.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Approve
                    </button>
                  </>
                )}
                <button
                  onClick={() => void remove(e)}
                  disabled={busy !== null}
                  className="text-ink-4 hover:text-vermillion-2 disabled:opacity-40"
                  title="Remove from corpus"
                >
                  {busy === `rm-${e.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Project pool picker — reuse a document already uploaded by any artifact */}
      <div>
        <div className="text-[12.5px] font-medium text-ink mb-2">Project pool ({attachable.length} unattached)</div>
        <p className="text-[11px] text-ink-4 mb-2">Documents uploaded by any schema or classifier in this project. Attach one without re-uploading — it&apos;s labelled with the class selected above.</p>
        {attachable.length === 0 ? (
          <p className="text-[12px] text-ink-4">Every pooled document is already in this corpus.</p>
        ) : (
          <div className="border border-border rounded-sm divide-y divide-border max-h-[320px] overflow-y-auto">
            {attachable.map((d) => (
              <div key={d.id} className="flex items-center gap-3 px-3 py-2 text-[12.5px]">
                <span className="flex-1 truncate text-ink-2" title={d.filename}>{d.filename}</span>
                <span className="text-[11px] text-ink-4">{d.source}</span>
                <button
                  onClick={() => void attach(d)}
                  disabled={busy !== null || !pendingLabel}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-sm text-[11px] text-ink-3 border border-border hover:text-ink hover:border-ink-4 disabled:opacity-40"
                >
                  {busy === `attach-${d.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  Add as {pendingLabel}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ListLayout>
  );
}
