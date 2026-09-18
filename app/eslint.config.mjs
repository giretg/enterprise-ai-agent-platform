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
      "src/app/api/mcp/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/domain", "@/domain/index", "@/domain/index.ts"],
              message: "Target graph must not import the legacy @/domain services barrel.",
            },
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
