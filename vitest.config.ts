import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageSource = (name: string): string =>
  fileURLToPath(new URL(`packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
  resolve: {
    // Tests run against workspace sources, not built dist output.
    alias: {
      "@travel-optimizer/domain": packageSource("domain"),
      "@travel-optimizer/geo": packageSource("geo"),
      "@travel-optimizer/optimizer": packageSource("optimizer"),
      "@travel-optimizer/providers": packageSource("providers"),
    },
  },
});
