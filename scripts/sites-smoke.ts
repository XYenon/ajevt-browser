// Broad live check against common websites. Read-only except for the Selenium
// fixture form, whose submit case is explicitly authorized with allow_risky.
// Run with `pnpm smoke:sites`; every scenario needs a live Jev configuration and
// network access, so this is an opt-in check rather than part of `pnpm test`.
import { type AjevtBrowserParams, executeAjevtBrowser } from "../src/tool.js";
import type { HandoffStatus } from "../src/types.js";

interface Scenario {
  name: string;
  params: AjevtBrowserParams;
  expect: HandoffStatus[];
}

const SELENIUM_FORM = "https://www.selenium.dev/selenium/web/web-form.html";

const scenarios: Scenario[] = [
  {
    name: "static-read",
    expect: ["done"],
    params: {
      goal: "Confirm that this page visibly identifies itself as Example Domain; do not navigate away.",
      url: "https://example.com",
      max_steps: 3,
      allowed_domains: ["example.com"],
      verifiers: [{ type: "text_contains", text: "Example Domain" }],
    },
  },
  {
    name: "search-engine-submit",
    expect: ["done"],
    params: {
      goal: "Enter the supplied search value into the search field, submit the search, and stop when the results page visibly mentions the searched value.",
      url: "https://duckduckgo.com/",
      values: { Search: "web browser automation" },
      max_steps: 6,
      require_action: true,
      allowed_domains: ["duckduckgo.com"],
      verifiers: [{ type: "text_contains", text: "web browser automation" }],
    },
  },
  {
    name: "link-navigation",
    expect: ["done"],
    params: {
      goal: "Open the 'new' link from the top navigation and stop when the page URL ends with /newest.",
      url: "https://news.ycombinator.com/",
      max_steps: 4,
      require_action: true,
      allowed_domains: ["news.ycombinator.com"],
      verifiers: [{ type: "url_contains", text: "/newest" }],
    },
  },
  {
    name: "search-with-dialog",
    expect: ["done"],
    params: {
      goal: "Enter the supplied search value into the site search, submit the search, and stop when the page shows the documentation article for that value.",
      url: "https://developer.mozilla.org/en-US/",
      values: { Search: "fetch" },
      max_steps: 6,
      require_action: true,
      allowed_domains: ["developer.mozilla.org"],
      verifiers: [{ type: "url_contains", text: "developer.mozilla.org/en-US/docs" }],
    },
  },
  {
    name: "form-fill",
    expect: ["done"],
    params: {
      goal: "Enter the supplied text value into the 'Text input' field and stop. Do not submit the form.",
      url: SELENIUM_FORM,
      values: { "Text input": "ajevt-browser" },
      max_steps: 4,
      require_action: true,
      allowed_domains: ["selenium.dev"],
      verifiers: [{ type: "element_value_equals", name: "Text input", value: "ajevt-browser" }],
    },
  },
  {
    name: "select-dropdown",
    expect: ["done"],
    params: {
      goal: "Select the dropdown option 'Two' and stop when the dropdown shows Two as the selected option.",
      url: SELENIUM_FORM,
      max_steps: 5,
      require_action: true,
      allowed_domains: ["selenium.dev"],
      verifiers: [{ type: "element_value_equals", name: "Dropdown (select)", value: "2" }],
    },
  },
  {
    name: "commitment-needs-confirmation",
    expect: ["needs_confirmation"],
    params: {
      goal: "Enter the supplied text value into the 'Text input' field and submit the form; stop when the page says Received!.",
      url: SELENIUM_FORM,
      values: { "Text input": "ajevt-browser" },
      max_steps: 6,
      allowed_domains: ["selenium.dev"],
      verifiers: [{ type: "text_contains", text: "Received!" }],
    },
  },
  {
    name: "commitment-authorized",
    expect: ["done"],
    params: {
      goal: "Enter the supplied text value into the 'Text input' field and submit the form; stop when the page says Received!.",
      url: SELENIUM_FORM,
      values: { "Text input": "ajevt-browser" },
      allow_risky: true,
      max_steps: 6,
      allowed_domains: ["selenium.dev"],
      verifiers: [{ type: "text_contains", text: "Received!" }],
    },
  },
  {
    name: "login-flow",
    expect: ["done"],
    params: {
      goal: "Enter the supplied username and password, submit the sign-in form, and stop when the page lists Products.",
      url: "https://www.saucedemo.com/",
      values: { Username: "standard_user", Password: "secret_sauce" },
      max_steps: 6,
      allowed_domains: ["saucedemo.com"],
      verifiers: [{ type: "url_contains", text: "inventory.html" }],
    },
  },
  {
    name: "async-content",
    expect: ["done"],
    params: {
      goal: "Click the 'Start' button and stop when the page shows the text Hello World!.",
      url: "https://the-internet.herokuapp.com/dynamic_loading/1",
      max_steps: 6,
      require_action: true,
      allowed_domains: ["the-internet.herokuapp.com"],
      verifiers: [{ type: "text_contains", text: "Hello World!" }],
    },
  },
  {
    name: "cross-origin-blocked",
    expect: ["blocked"],
    params: {
      goal: "Confirm that this page identifies itself as Example Domain.",
      url: "https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com",
      max_steps: 3,
      allowed_domains: ["httpbin.org"],
      verifiers: [{ type: "text_contains", text: "Example Domain" }],
    },
  },
];

let failures = 0;
for (const scenario of scenarios) {
  const started = Date.now();
  let record: Record<string, unknown>;
  try {
    const handoff = await executeAjevtBrowser(scenario.params, { signal: AbortSignal.timeout(120_000) });
    const ok = scenario.expect.includes(handoff.status);
    if (!ok) failures += 1;
    record = {
      name: scenario.name,
      ok,
      status: handoff.status,
      expected: scenario.expect,
      steps: handoff.recent_actions.length,
      url: handoff.url,
      verification: handoff.verification?.passed,
      reason: handoff.reason,
      ms: Date.now() - started,
    };
  } catch (error) {
    failures += 1;
    record = {
      name: scenario.name,
      ok: false,
      status: "threw",
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    };
  }
  console.log(JSON.stringify(record));
}
if (failures) {
  console.error(`${failures} of ${scenarios.length} site scenarios failed`);
  process.exitCode = 1;
}
