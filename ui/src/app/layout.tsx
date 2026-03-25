import type { Metadata, Viewport } from "next";
import { Providers } from "./providers";
import { ServiceWorkerRegister } from "./sw-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "ftown - Claude Code Orchestrator",
  description: "Manage and view Claude Code sessions running on remote CLI bridges",
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
      </body>
    </html>
  );
}
