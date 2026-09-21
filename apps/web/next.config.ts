import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

/** Monorepo root — provider cache and geo snapshots resolve relative to this tree. */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const nextConfig: NextConfig = {
  transpilePackages: [
    "@travel-optimizer/domain",
    "@travel-optimizer/geo",
    "@travel-optimizer/optimizer",
    "@travel-optimizer/providers",
  ],
  serverExternalPackages: [],
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
