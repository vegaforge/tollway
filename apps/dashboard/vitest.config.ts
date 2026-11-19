import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": `${here}src`,
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "dom",
          globals: true,
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/lib/auth*.test.ts", "src/app/api/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "server",
          globals: true,
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/lib/auth*.test.ts", "src/app/api/**/*.test.ts"],
        },
      },
    ],
  },
});
