import "./globals.css";

import { Space_Mono, Syne } from "next/font/google";

import type { Metadata } from "next";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const spaceMono = Space_Mono({
  variable: "--font-space-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "Interdimensional Cable | AI late-night shows on MiniMax",
  description: "An autonomous AI showrunner. Pick a format, give it a topic, and MiniMax-M3 writes, Speech 2.8 HD voices, MiniMax-H3 renders and Music 3.0 scores a late-night episode, all served through GMI Cloud.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${syne.variable} ${spaceMono.variable} antialiased`}
        style={{ fontFamily: "var(--font-syne), system-ui, sans-serif" }}
      >
        {children}
      </body>
    </html>
  );
}
