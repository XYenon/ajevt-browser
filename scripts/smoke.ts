import { AgentBrowserAdapter } from "../src/agent-browser.js";

const browser = new AgentBrowserAdapter();
try {
  await browser.open("https://example.com", { allowedDomains: ["example.com"] });
  const observation = await browser.observe();
  if (
    observation.url !== "https://example.com/" ||
    !observation.elements.some((element) => element.name === "Learn more")
  ) {
    throw new Error(`unexpected observation: ${JSON.stringify(observation)}`);
  }
  console.log(
    JSON.stringify({
      ok: true,
      url: observation.url,
      title: observation.title,
      interactive: observation.elements.length,
    }),
  );
} finally {
  await browser.close();
}
