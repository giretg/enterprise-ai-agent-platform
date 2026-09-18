import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-local-auth/**",
    ".next-local-auth-verify/**",
    ".data/**",
    "uploads/**",
    "src/.next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: [
      "src/domain/gateway-services.ts",
      "src/domain/agent-definition/**",
      "src/domain/enterprise-tools/**",
      "src/domain/gateway-operation/**",
      "src/auth/mcp-principal.ts",
      "src/auth/mcp-server.ts",
      "src/auth/mcp-oauth-metadata.ts",
      "src/app/api/mcp/**",
      "src/app/.well-known/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/domain",
              message: "Target graph must not import the legacy @/domain services barrel.",
            },
            {
              name: "@/domain/index",
              message: "Target graph must not import the legacy @/domain services barrel.",
            },
            {
              name: "@/domain/index.ts",
              message: "Target graph must not import the legacy @/domain services barrel.",
            },
          ],
          patterns: [
            {
              group: [
                "@/domain/agent/*",
                "@/domain/gateway/*",
                "@/domain/dispatcher/*",
                "@/domain/conversation/*",
                "@/domain/channel/*",
                "@/harness/*",
              ],
              message: "Target graph must not import the legacy runtime/chat/dispatcher stack.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
