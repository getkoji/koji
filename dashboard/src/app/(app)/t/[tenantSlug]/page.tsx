export default async function OverviewPage({
  params,
}: {
  params: Promise<{ tenantSlug: string }>;
}) {
  const { tenantSlug } = await params;

  return (
    <div className="px-10 py-8 pb-16">
      {/* Page header */}
      <div className="flex items-start justify-between gap-8 mb-8">
        <div>
          <p className="inline-flex items-center gap-2 font-mono text-[10.5px] font-medium tracking-[0.12em] uppercase text-ink-4 mb-2">
            <span className="text-vermillion-2">01</span>
            <span className="text-cream-4">·</span>
            <span>Overview</span>
          </p>
          <h1
            className="font-display text-[34px] font-medium leading-[1.05] tracking-tight text-ink m-0"
            style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 50" }}
          >
            {tenantSlug}.
            <br />
            <em
              className="text-vermillion-2 italic"
              style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 100" }}
            >
              Quietly working.
            </em>
          </h1>
          <p className="text-[13.5px] text-ink-3 max-w-[54ch] mt-1.5 m-0">
            Four pipelines active. Twelve schemas under measurement. The last
            regression was caught before it shipped. Nothing on fire.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-cream text-ink border border-border-strong hover:border-ink transition-colors">
            Deploy
          </button>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-sm text-[12.5px] font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors">
            New schema
          </button>
        </div>
      </div>

      {/* Metrics strip */}
      <div
        className="grid gap-px bg-border border border-border rounded-sm mb-9"
        style={{ gridTemplateColumns: "repeat(5, 1fr)" }}
      >
        {[
          { label: "Accuracy", value: "98.5", unit: "%", delta: "+0.4", up: true },
          { label: "Throughput", value: "1,247", unit: "docs", delta: "+12%", up: true },
          { label: "Latency p50", value: "2.3", unit: "s", delta: "-0.1", up: true },
          { label: "Cost / doc", value: "$0.03", unit: "", delta: "flat", up: false },
          { label: "Error rate", value: "0.4", unit: "%", delta: "-0.2", up: true },
        ].map((m) => (
          <div key={m.label} className="bg-cream px-4 py-4 flex flex-col gap-0.5">
            <span className="font-mono text-[9.5px] font-medium tracking-[0.12em] uppercase text-ink-4">
              {m.label}
            </span>
            <span
              className="font-display text-[26px] font-medium text-ink leading-none tracking-tight"
              style={{ fontVariationSettings: "'opsz' 72, 'SOFT' 30" }}
            >
              {m.value}
              {m.unit && (
                <span className="font-body text-xs font-normal text-ink-3 ml-0.5 tracking-normal">
                  {m.unit}
                </span>
              )}
            </span>
            <span
              className={`font-mono text-[10.5px] font-medium mt-1 ${
                m.delta === "flat" ? "text-ink-4" : m.up ? "text-green" : "text-vermillion-2"
              }`}
            >
              {m.delta}
            </span>
          </div>
        ))}
      </div>

      {/* Content grid: activity + attention */}
      <div className="grid gap-8" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        {/* Activity panel */}
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between pb-2.5 border-b border-border">
            <h2
              className="font-display text-lg font-medium tracking-tight text-ink m-0"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
            >
              Recent activity
            </h2>
            <span className="font-mono text-[11px] text-ink-3 hover:text-vermillion-2 cursor-pointer transition-colors">
              view all →
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {[
              { time: "2 min ago", desc: "Job completed", resource: "job-20260414-1442-a91c", status: "ok" },
              { time: "18 min ago", desc: "Schema deployed", resource: "invoice v13", status: "ok" },
              { time: "1h ago", desc: "Review item resolved", resource: "rev_01HZK2N3", status: "ok" },
              { time: "3h ago", desc: "Pipeline paused", resource: "claims-intake", status: "warn" },
              { time: "5h ago", desc: "Validate run passed", resource: "invoice v12 → v13", status: "ok" },
            ].map((a, i) => (
              <div
                key={i}
                className="grid items-center gap-3.5 py-2 border-b border-dotted border-border last:border-none text-[12.5px]"
                style={{ gridTemplateColumns: "auto 1fr auto" }}
              >
                <span className="font-mono text-[11px] text-ink-4 min-w-[4.5rem]">{a.time}</span>
                <span className="text-ink-2 min-w-0">
                  {a.desc} <span className="font-mono text-ink">{a.resource}</span>
                </span>
                <span
                  className={`font-mono text-[11px] px-1.5 py-0.5 rounded-sm ${
                    a.status === "ok"
                      ? "bg-green/10 text-green"
                      : "bg-vermillion/10 text-vermillion-2"
                  }`}
                >
                  {a.status === "ok" ? "✓" : "⚠"}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Attention panel */}
        <div className="flex flex-col gap-4">
          <div className="flex items-baseline justify-between pb-2.5 border-b border-border">
            <h2
              className="font-display text-lg font-medium tracking-tight text-ink m-0"
              style={{ fontVariationSettings: "'opsz' 96, 'SOFT' 50" }}
            >
              Needs attention
            </h2>
          </div>
          <div className="flex flex-col gap-3">
            {[
              {
                kind: "Drift alert",
                text: (
                  <>
                    Schema <span className="font-mono font-medium">invoice</span> accuracy dropped
                    1.2% on the last nightly bench. 3 regressions flagged.
                  </>
                ),
                action: "View regressions →",
              },
              {
                kind: "Review queue",
                text: "8 items pending review, oldest is 4 hours.",
                action: "Open queue →",
              },
              {
                kind: "Source error",
                text: (
                  <>
                    Source <span className="font-mono font-medium">acme-s3-inbound</span> has failed
                    3 consecutive health checks.
                  </>
                ),
                action: "View source →",
              },
            ].map((a, i) => (
              <div key={i} className="px-4 py-3.5 bg-cream-2 border-l-[3px] border-vermillion-2 rounded-r-sm">
                <div className="font-mono text-[10px] font-medium tracking-[0.1em] uppercase text-vermillion-2 mb-1">
                  {a.kind}
                </div>
                <p className="text-[12.5px] text-ink leading-[1.45] m-0">{a.text}</p>
                <span className="inline-block mt-2 font-mono text-[11px] text-vermillion-2 hover:text-ink cursor-pointer transition-colors">
                  {a.action}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
