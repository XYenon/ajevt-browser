import { AgentBrowserAdapter } from "../src/agent-browser.js";
import { resolveJevConfig } from "../src/config.js";
import { FetchJevTransport } from "../src/jev.js";
import { runBrowserLoop } from "../src/loop.js";

const config = resolveJevConfig();
const result = await runBrowserLoop(new AgentBrowserAdapter(), new FetchJevTransport(config), {
  goal: "Confirm that this page visibly identifies itself as Example Domain; do not navigate away.",
  url: "https://example.com",
  maxSteps: 3,
  allowedDomains: ["example.com"],
  verifiers: [{ type: "text_contains", text: "Example Domain" }],
  model: config.model,
  onProgress: (event) =>
    console.error(`step ${event.step}: ${event.phase}${event.operation ? ` ${event.operation}` : ""}`),
});
console.log(JSON.stringify(result, null, 2));
if (result.status !== "done") process.exitCode = 1;
