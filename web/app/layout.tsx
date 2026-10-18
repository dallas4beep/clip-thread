import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Clipthread", template: "%s · Clipthread" },
  description: "Collect, moderate and publish video stories.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
