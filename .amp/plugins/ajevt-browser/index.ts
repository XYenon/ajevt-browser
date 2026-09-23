import type { PluginAPI } from "@ampcode/plugin";
import { formatHandoff } from "../../../src/format.js";
import { ajevtBrowserJsonSchema } from "../../../src/schema.js";
import { type AjevtBrowserParams, executeAjevtBrowser, TOOL_DESCRIPTION, TOOL_NAME } from "../../../src/tool.js";

export const description =
  "Run bounded browser tasks through agent-browser and Jev, with deterministic verification and a structured handoff.";

export default function (amp: PluginAPI): void {
  amp.registerTool({
    name: TOOL_NAME,
    title: "Ajevt Browser",
    description: `${TOOL_DESCRIPTION} Supply field contents via values; treat likely_done as unverified and prefer verifiers. Risky actions require allow_risky: true.`,
    inputSchema: { ...ajevtBrowserJsonSchema, required: [...ajevtBrowserJsonSchema.required] },
    async execute(input) {
      try {
        // Config and secret references are resolved by the shared executor on every call.
        const result = await executeAjevtBrowser(input as unknown as AjevtBrowserParams);
        return `${formatHandoff(result)}\n\nHandoff JSON:\n${JSON.stringify(result)}`;
      } catch (error) {
        return `Ajevt Browser error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
