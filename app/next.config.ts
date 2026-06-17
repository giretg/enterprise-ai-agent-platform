import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Ne a szülőkönyvtár package-lock.json-ját válassza (server action / build root).
  turbopack: {
    root: appDir,
  },
};

export default nextConfig;
