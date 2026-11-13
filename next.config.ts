import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // PGlite ships WASM + data files that must be loaded from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  // Sample documents are pre-parsed into src/lib/sample-data.json at build time
  // (scripts/build-samples.ts), so the raw files don't need to ship with the server.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
