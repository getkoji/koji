"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    api
      .get<{ needed: boolean }>("/api/setup/status")
      .then((status) => {
        if (status.needed) {
          router.replace("/setup");
        } else {
          router.replace("/t/default");
        }
      })
      .catch(() => {
        // API unreachable — go to setup (it will show its own error)
        router.replace("/t/default");
      });
  }, [router]);

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center">
      <div className="animate-pulse font-mono text-[11px] text-ink-4">Loading...</div>
    </div>
  );
}
