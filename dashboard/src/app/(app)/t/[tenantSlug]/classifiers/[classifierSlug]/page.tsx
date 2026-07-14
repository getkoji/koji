"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2, Upload, Play, Save, Rocket, History } from "lucide-react";
import { ListLayout, Breadcrumbs, PageHeader } from "@/components/layouts";
import {
  classifiers as classifiersApi,
  ApiError,
  type ClassifierDetail,
  type ClassifierVersion,
  type ClassifyResult,
} from "@/lib/api";
import { usePageTitle } from "@/lib/use-page-title";

const TIER_LABELS: Record<number, string> = {
  0: "metadata",
  1: "text",
  2: "keyword",
  3: "llm",
  4: "vision",
};

export default function ClassifierDetailPage() {
  const params = useParams();
  const tenantSlug = params.tenantSlug as string;
  const slug = params.classifierSlug as string;
  const base = `/t/${tenantSlug}`;

  const [detail, setDetail] = useState<ClassifierDetail | null>(null);
  const [versions, setVersions] = useState<ClassifierVersion[]>([]);
  const [yaml, setYaml] = useState("");
  const [savedYaml, setSavedYaml] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "draft" | "candidate" | "release" | "promote">(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const dirty = yaml !== savedYaml;

  const loadVersions = useCallback(async () => {
    try {
      setVersions(await classifiersApi.versions(slug));
    } catch {
      /* non-fatal */
    }
  }, [slug]);

  const load = useCallback(async () => {
    try {
      const d = await classifiersApi.get(slug);
      setDetail(d);
      const source = d.latestVersion?.yamlSource ?? d.draftYaml ?? "";
      setYaml(source);
      setSavedYaml(source);
      void loadVersions();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load classifier");
    }
  }, [slug, loadVersions]);

  useEffect(() => {
    void load();
  }, [load]);

  function flash(kind: "ok" | "err", text: string) {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4000);
  }

  async function saveDraft() {
    setBusy("draft");
    try {
      await classifiersApi.update(slug, { draft_yaml: yaml });
      setSavedYaml(yaml);
      flash("ok", "Draft saved");
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function saveCandidate() {
    setBusy("candidate");
    try {
      const res = await classifiersApi.commit(slug, { yaml_source: yaml });
      setSavedYaml(yaml);
      flash("ok", `Committed candidate ${res.version} (${res.bump})`);
      await loadVersions();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Commit failed");
    } finally {
      setBusy(null);
    }
  }

  async function release() {
    setBusy("release");
    try {
      const res = await classifiersApi.release(slug, { yaml_source: yaml });
      setSavedYaml(yaml);
      flash("ok", `Released ${res.released} — now live`);
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Release failed");
    } finally {
      setBusy(null);
    }
  }

  async function promote() {
    setBusy("promote");
    try {
      const res = await classifiersApi.promote(slug);
      flash("ok", `Promoted ${res.released} — now live`);
      await load();
    } catch (err) {
      flash("err", err instanceof Error ? err.message : "Promote failed");
    } finally {
      setBusy(null);
    }
  }

  const hasCandidate = versions.some((v) => !v.released);

  usePageTitle(detail?.displayName ?? "Classifier");

  if (loadError) {
    return (
      <div className="mx-auto w-full max-w-[900px] px-6 py-8">
        <div className="text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-2 rounded-sm">{loadError}</div>
        <Link href={`${base}/classifiers`} className="text-[12.5px] text-ink-3 hover:text-ink mt-4 inline-block">
          ← Back to classifiers
        </Link>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-ink-3 py-16 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <ListLayout
      header={
        <>
          <Breadcrumbs
            items={[
              { label: tenantSlug, href: base },
              { label: "Classifiers", href: `${base}/classifiers` },
              { label: detail.displayName },
            ]}
          />
          <PageHeader
            title={detail.displayName}
            badge={
              detail.latestVersion ? (
                <span className="inline-flex items-center gap-1.5 font-mono text-[10.5px] font-medium px-2 py-0.5 rounded-sm bg-vermillion/[0.10] text-vermillion-2">
                  <span className="uppercase tracking-[0.08em]">live</span>
                  {detail.latestVersion.version ?? `v${detail.latestVersion.versionNumber}`}
                </span>
              ) : (
                <span className="inline-flex items-center font-mono text-[10px] font-medium px-2 py-0.5 rounded-sm uppercase tracking-[0.08em] bg-cream-2 text-ink-3">
                  no released version
                </span>
              )
            }
            meta={
              <span>
                {detail.description || <span className="text-ink-4">No description</span>}
              </span>
            }
          />
        </>
      }
    >
      {notice && (
        <div
          className={`text-[12px] px-3 py-1.5 rounded-sm mb-4 ${
            notice.kind === "ok"
              ? "text-ink bg-ink/[0.04]"
              : "text-vermillion-2 bg-vermillion-3/50"
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6">
        {/* Editor + actions */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12.5px] font-medium text-ink">Config (YAML)</span>
            {dirty && <span className="text-[11px] text-ink-4">unsaved changes</span>}
          </div>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            spellCheck={false}
            className="w-full h-[440px] rounded-sm border border-input bg-transparent p-3 text-[12.5px] font-mono leading-[1.6] outline-none focus:border-ring focus:ring-[2px] focus:ring-ring/30 resize-y"
          />
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button
              onClick={saveDraft}
              disabled={!dirty || busy !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] text-ink-3 border border-border hover:text-ink hover:border-ink-4 transition-colors disabled:opacity-40"
            >
              {busy === "draft" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save draft
            </button>
            <button
              onClick={saveCandidate}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] text-ink-3 border border-border hover:text-ink hover:border-ink-4 transition-colors disabled:opacity-40"
            >
              {busy === "candidate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
              Save as candidate
            </button>
            <button
              onClick={release}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
            >
              {busy === "release" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
              Release
            </button>
          </div>

          {/* Versions */}
          <div className="mt-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12.5px] font-medium text-ink">Versions</span>
              {hasCandidate && (
                <button
                  onClick={promote}
                  disabled={busy !== null}
                  className="text-[11.5px] text-vermillion-2 hover:text-vermillion-1 disabled:opacity-40"
                >
                  {busy === "promote" ? "Promoting…" : "Promote latest candidate →"}
                </button>
              )}
            </div>
            {versions.length === 0 ? (
              <p className="text-[12px] text-ink-4">No versions yet.</p>
            ) : (
              <div className="border border-border rounded-sm divide-y divide-border">
                {versions.map((v) => (
                  <div key={v.id} className="flex items-center justify-between px-3 py-2 text-[12px]">
                    <span className="font-mono text-ink">{v.version}</span>
                    <span className="text-ink-3 truncate px-3 flex-1">{v.commitMessage || ""}</span>
                    <span
                      className={`shrink-0 ${
                        v.active ? "text-vermillion-2 font-medium" : v.released ? "text-ink-3" : "text-ink-4"
                      }`}
                    >
                      {v.active ? "live" : v.released ? "released" : "candidate"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Test panel */}
        <TestPanel slug={slug} yaml={yaml} />
      </div>
    </ListLayout>
  );
}

function TestPanel({ slug: _slug, yaml }: { slug: string; yaml: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ClassifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function run() {
    if (!file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await classifiersApi.classify(file, yaml);
      setResult(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setError("Rejected — no class matched (on_unknown: reject).");
      } else {
        setError(err instanceof Error ? err.message : "Classification failed");
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border border-border rounded-sm p-4 h-fit lg:sticky lg:top-6">
      <div className="text-[12.5px] font-medium text-ink mb-1">Test</div>
      <p className="text-[11.5px] text-ink-3 mb-3">
        Classify a document against the config above — nothing is saved.
      </p>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setResult(null);
          setError(null);
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] text-ink-3 border border-dashed border-border hover:text-ink hover:border-ink-4 transition-colors"
      >
        <Upload className="h-3.5 w-3.5" />
        {file ? file.name : "Choose a document"}
      </button>

      <button
        onClick={run}
        disabled={!file || running}
        className="w-full mt-2 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors disabled:opacity-50"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {running ? "Classifying…" : "Classify"}
      </button>

      {error && (
        <div className="mt-3 text-[12px] text-vermillion-2 bg-vermillion-3/50 px-3 py-1.5 rounded-sm">{error}</div>
      )}

      {result && (
        <div className="mt-4 space-y-2">
          <Row label="Label">
            <span className="font-medium text-ink">{result.label}</span>
          </Row>
          <Row label="Confidence">
            {result.confidence != null ? `${(result.confidence * 100).toFixed(0)}%` : "—"}
          </Row>
          <Row label="Method">{result.method}</Row>
          <Row label="Tier">
            {result.tier_used} · {TIER_LABELS[result.tier_used] ?? "?"}
          </Row>
          <Row label="Evidence">{result.evidence_page != null ? `page ${result.evidence_page}` : "—"}</Row>
          {result.scores && result.scores.length > 0 && (
            <div className="pt-2 border-t border-border mt-2">
              <div className="text-[11px] text-ink-4 mb-1">Deterministic scores</div>
              {result.scores.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-[11.5px] py-0.5">
                  <span className="text-ink-3">{s.id}</span>
                  <span className="font-mono text-ink-4">
                    {(s.score * 100).toFixed(0)}% ({s.hits}/{s.total})
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-[12.5px]">
      <span className="text-ink-3">{label}</span>
      <span className="text-ink">{children}</span>
    </div>
  );
}
