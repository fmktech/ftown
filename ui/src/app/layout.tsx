import type { Metadata, Viewport } from "next";
import { InvitationSafeAnalytics } from "@/lib/auth-mode";
import { Providers } from "./providers";
import { ServiceWorkerRegister } from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "ftown — Remote coding agent orchestration",
  description:
    "Manage coding agents with local-first terminals and MCP fleet control. Inspect sessions, send mail, and follow durable attention requests across computers.",
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
        {process.env.NEXT_PUBLIC_SOLO !== "1" && <InvitationSafeAnalytics />}
      </body>
    </html>
  );
}
