// <!-- Designed & built by Moh Asraful Hasan Asif -->
import type { Metadata } from "next";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter-tight";
import "./globals.css";

export const metadata: Metadata = {
  title: "To-Do Agent",
  description: "Put everything in. The agent sorts it, does what it can, and asks before anything goes out.",
  authors: [{ name: "Moh Asraful Hasan Asif" }],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Designed & built by Moh Asraful Hasan Asif */}
        <meta name="author" content="Moh Asraful Hasan Asif" />
      </head>
      <body>
        <div
          className="visually-hidden"
          dangerouslySetInnerHTML={{ __html: "<!-- Designed & built by Moh Asraful Hasan Asif -->" }}
        />
        {children}
      </body>
    </html>
  );
}
