import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { AgentBrowserAdapter } from "../src/agent-browser.js";
import { resolveJevConfig } from "../src/config.js";
import { FetchJevTransport } from "../src/jev.js";
import { runBrowserLoop } from "../src/loop.js";

const html = await readFile(fileURLToPath(new URL("./fixtures/complex.html", import.meta.url)));
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": html.length });
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind smoke server");
const url = `http://127.0.0.1:${address.port}`;

try {
  const config = resolveJevConfig();
  const result = await runBrowserLoop(new AgentBrowserAdapter(), new FetchJevTransport(config), {
    goal: "Enter the supplied project search value, run the safe preview, and stop when the page visibly says Preview ready for ajevt-browser.",
    url,
    values: { "Project search": "ajevt-browser" },
    maxSteps: 6,
    allowedDomains: ["127.0.0.1"],
    verifiers: [{ type: "text_contains", text: "Preview ready for ajevt-browser" }],
    model: config.model,
    onProgress: (event) =>
      console.error(`step ${event.step}: ${event.phase}${event.operation ? ` ${event.operation}` : ""}`),
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "done" || result.recent_actions.length < 2) process.exitCode = 1;
} finally {
  server.close();
}
