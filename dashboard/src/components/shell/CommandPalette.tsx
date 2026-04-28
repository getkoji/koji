"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
  CommandSeparator,
} from "@koji/ui";
import {
  LayoutDashboard,
  Workflow,
  Play,
  MessageSquare,
  ArrowDownToLine,
  Settings,
  FileCode,
  Plus,
  Search,
} from "lucide-react";
import {
  schemas as schemasApi,
  jobs as jobsApi,
  pipelines as pipelinesApi,
  sources as sourcesApi,
  type SchemaRow,
  type JobRow,
  type PipelineRow,
  type SourceRow,
} from "@/lib/api";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const router = useRouter();
  const pathname = usePathname();
  const tenantSlug = pathname.match(/^\/t\/([^/]+)/)?.[1];

  const [schemasData, setSchemasData] = useState<SchemaRow[]>([]);
  const [jobsData, setJobsData] = useState<JobRow[]>([]);
  const [pipelinesData, setPipelinesData] = useState<PipelineRow[]>([]);
  const [sourcesData, setSourcesData] = useState<SourceRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch entity lists when the palette opens
  useEffect(() => {
    if (!open || !tenantSlug) return;
    setLoading(true);

    Promise.all([
      schemasApi.list().catch(() => null),
      jobsApi.list({ limit: 20 }).catch(() => null),
      pipelinesApi.list().catch(() => null),
      sourcesApi.list().catch(() => null),
    ]).then(([s, j, p, src]) => {
      if (s) setSchemasData(s);
      if (j) setJobsData(j);
      if (p) setPipelinesData(p);
      if (src) setSourcesData(src);
      setLoading(false);
    });
  }, [open, tenantSlug]);

  const navigate = useCallback(
    (path: string) => {
      router.push(path);
      onOpenChange(false);
    },
    [router, onOpenChange],
  );

  if (!tenantSlug) return null;

  const base = `/t/${tenantSlug}`;

  const navItems = [
    { label: "Overview", path: base, icon: LayoutDashboard },
    { label: "Pipelines", path: `${base}/pipelines`, icon: Workflow },
    { label: "Jobs", path: `${base}/jobs`, icon: Play },
    { label: "Review", path: `${base}/review`, icon: MessageSquare },
    { label: "Sources", path: `${base}/sources`, icon: ArrowDownToLine },
    { label: "Settings", path: `${base}/settings`, icon: Settings },
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command Palette"
      description="Search schemas, pipelines, jobs, and more"
    >
      <CommandInput placeholder="Search or jump to..." />
      <CommandList>
        <CommandEmpty>
          {loading ? "Loading..." : "No results found."}
        </CommandEmpty>

        <CommandGroup heading="Navigation">
          {navItems.map((item) => (
            <CommandItem
              key={item.path}
              value={`nav ${item.label}`}
              onSelect={() => navigate(item.path)}
            >
              <item.icon className="w-4 h-4 text-ink-3" />
              <span>{item.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            value="action create new schema"
            onSelect={() => navigate(`${base}/schemas/new`)}
          >
            <Plus className="w-4 h-4 text-ink-3" />
            <span>Create schema</span>
          </CommandItem>
          <CommandItem
            value="action new project"
            onSelect={() => navigate("/new-project")}
          >
            <Plus className="w-4 h-4 text-ink-3" />
            <span>New project</span>
          </CommandItem>
        </CommandGroup>

        {schemasData.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Schemas">
              {schemasData.map((s) => (
                <CommandItem
                  key={s.slug}
                  value={`schema ${s.slug} ${s.displayName}`}
                  onSelect={() => navigate(`${base}/schemas/${s.slug}/build`)}
                >
                  <FileCode className="w-4 h-4 text-ink-3" />
                  <span>{s.displayName}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-4">
                    {s.slug}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {pipelinesData.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Pipelines">
              {pipelinesData.map((p) => (
                <CommandItem
                  key={p.slug}
                  value={`pipeline ${p.slug} ${p.displayName}`}
                  onSelect={() => navigate(`${base}/pipelines/${p.slug}`)}
                >
                  <Workflow className="w-4 h-4 text-ink-3" />
                  <span>{p.displayName}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-4">
                    {p.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {jobsData.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Jobs">
              {jobsData.map((j) => (
                <CommandItem
                  key={j.slug}
                  value={`job ${j.slug} ${j.pipelineName ?? ""} ${j.status}`}
                  onSelect={() => navigate(`${base}/jobs/${j.slug}`)}
                >
                  <Play className="w-4 h-4 text-ink-3" />
                  <span className="font-mono text-xs">{j.slug}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-4">
                    {j.status}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {sourcesData.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Sources">
              {sourcesData.map((s) => (
                <CommandItem
                  key={s.slug}
                  value={`source ${s.slug} ${s.displayName} ${s.sourceType}`}
                  onSelect={() => navigate(`${base}/sources`)}
                >
                  <ArrowDownToLine className="w-4 h-4 text-ink-3" />
                  <span>{s.displayName}</span>
                  <span className="ml-auto font-mono text-[11px] text-ink-4">
                    {s.sourceType}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
