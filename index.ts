import type { Plugin as OpenCodePlugin } from "@opencode/plugin/promise/plugin";
import { formatHandoff } from "./src/format.js";
import { ajevtBrowserJsonSchema } from "./src/schema.js";
import { type AjevtBrowserParams, executeAjevtBrowser, TOOL_DESCRIPTION, TOOL_NAME } from "./src/tool.js";

const plugin = {
  id: "ajevt-browser",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        input: ajevtBrowserJsonSchema,
        async execute(input, context) {
          await context.progress({ tool: TOOL_NAME, step: 0, phase: "starting" });
          const result = await executeAjevtBrowser(input as AjevtBrowserParams, {
            signal: context.signal,
            hostOptions: ctx.options,
            async onProgress(event) {
              await context.progress({ tool: TOOL_NAME, ...event });
            },
          });
          return {
            content: [{ type: "text", text: formatHandoff(result) }],
            metadata: result,
          };
        },
      });
    });
  },
} satisfies OpenCodePlugin;

export default plugin;
