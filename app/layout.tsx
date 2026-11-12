import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev IVR Studio — Deterministic Pipecat Phone Menus",
  description:
    "Design deterministic v2 menu.json voice graphs, test Jev probabilities live, and run in Pipecat.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
