import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const appDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Ne a szülőkönyvtár package-lock.json-ját válassza (server action / build root).
  turbopack: {
    root: appDir,
  },
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // pdf-parse v2 + pdfjs worker: ne bundle-ölje az SSR chunkokba, különben
  // a pdf.worker.mjs path elromlik (Setting up fake worker failed).
  serverExternalPackages: ['pdf-parse', '@napi-rs/canvas'],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

export default withNextIntl(nextConfig);
