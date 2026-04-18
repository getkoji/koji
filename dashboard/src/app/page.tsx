"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api, projectsApi } from "@/lib/api";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    async function resolve() {
      try {
        const status = await api.get<{ needed: boolean }>("/api/setup/status");
        if (status.needed) {
          router.replace("/setup");
          return;
        }

        // Redirect to the user's first project
        const projectList = await projectsApi.list();
        const slug = projectList[0]?.slug;
        if (slug) {
          router.replace(`/t/${slug}`);
        } else {
          router.replace("/new-project");
        }
      } catch {
        router.replace("/setup");
      }
    }
    resolve();
  }, [router]);

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center">
      <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
    </div>
  );
}
