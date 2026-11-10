import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Phone menu",
  description: "Build a Vapi menu that listens with Deepgram Flux, lets Jev pick the stored line, and speaks it with Deepgram.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
