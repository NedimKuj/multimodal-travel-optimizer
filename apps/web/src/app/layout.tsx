import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
});

const display = Fraunces({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Trip Explorer",
  description: "Search complete trips with the travel optimizer",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      <body
        style={{
          fontFamily: "var(--font-sans), var(--sans)",
        }}
      >
        <div className="mx-auto min-h-screen w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
          <header className="mb-8 border-b border-[var(--line)] pb-4">
            <p
              className="text-sm font-medium tracking-wide text-[var(--accent)] uppercase"
              style={{ fontFamily: "var(--font-mono), var(--mono)" }}
            >
              Travel optimizer
            </p>
            <h1
              className="mt-1 text-3xl font-semibold tracking-tight text-[var(--ink)] sm:text-4xl"
              style={{ fontFamily: "var(--font-display), var(--display)" }}
            >
              Trip Explorer
            </h1>
            <p className="mt-2 max-w-2xl text-[var(--ink-muted)]">
              Search complete trips — transport, transfers, and accommodation state —
              with real optimizer results. Prices are never invented.
            </p>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
