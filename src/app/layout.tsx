import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ACE — Sports Betting Intelligence",
  description: "AI-powered sports betting research and analytics platform",
  icons: {
    icon: "/favicon.png",
    apple: "/favicon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
