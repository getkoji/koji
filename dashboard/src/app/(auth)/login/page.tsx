import { KojiLogo } from "@/components/shell/KojiLogo";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center">
      <div className="w-full max-w-sm flex flex-col items-center gap-6">
        <KojiLogo className="w-12 h-12 text-ink" />
        <h1
          className="font-display text-2xl font-medium text-ink"
          style={{ fontVariationSettings: "'opsz' 144, 'SOFT' 30" }}
        >
          Sign in to Koji
        </h1>
        <p className="text-sm text-ink-3 text-center">
          Auth adapter not yet wired. This page is a stub for platform-17.
        </p>
        <a
          href="/t/acme-invoices"
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-sm text-sm font-medium bg-ink text-cream hover:bg-vermillion-2 transition-colors"
        >
          Continue as demo user →
        </a>
      </div>
    </div>
  );
}
