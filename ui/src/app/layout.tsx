import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Providers } from "./providers";
import { ServiceWorkerRegister } from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "ftown — Remote coding agent orchestration",
  description:
    "Self-hosted dashboard to stream Claude Code, Cursor Agent, and other CLI agents with local-first/P2P terminals and scheduled loops.",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  themeColor: "#060608",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "ftown",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased min-h-screen">
        <ServiceWorkerRegister />
        <Providers>{children}</Providers>
        {/* Solo promises no telemetry; the same-origin analytics script would 404 anyway but must not be requested. */}
        {process.env.NEXT_PUBLIC_SOLO !== "1" && <Analytics />}
      </body>
    </html>
  );
}
