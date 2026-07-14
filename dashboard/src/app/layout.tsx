import type { Metadata } from "next";
import { Fraunces, Instrument_Sans, JetBrains_Mono } from "next/font/google";

import "./globals.css";
import { PageTitleProvider } from "@/lib/use-page-title";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  axes: ["opsz", "SOFT"],
});

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

// Note: no `title` here. The dashboard is overwhelmingly Client Components,
// which can't use `export const metadata` for titles, and a static metadata
// title clobbers the client-set one on hard loads. `PageTitleProvider` owns
// the document title app-wide via a hoisted `<title>`; pages set it with
// `usePageTitle`. See src/lib/use-page-title.tsx.
export const metadata: Metadata = {
  description: "Documents in. Structured data out.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${instrumentSans.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <PageTitleProvider>{children}</PageTitleProvider>
      </body>
    </html>
  );
}
