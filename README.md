# ajevt-browser

[![npm version](https://img.shields.io/npm/v/ajevt-browser.svg)](https://www.npmjs.com/package/ajevt-browser) [![ajevt-browser-mcp on npm](https://img.shields.io/npm/v/ajevt-browser-mcp.svg?label=ajevt-browser-mcp)](https://www.npmjs.com/package/ajevt-browser-mcp) [![license: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](https://github.com/XYenon/ajevt-browser/blob/master/LICENSE) [![node](https://img.shields.io/node/v/ajevt-browser.svg)](https://github.com/XYenon/ajevt-browser/blob/master/package.json)

A bounded Jev System-1 browser tool for Pi, OpenCode V2, Amp, and MCP. A single `ajevt_browser` call runs an observe/decide/validate/act loop using Vercel `agent-browser`.

## Architecture

```text
Pi extension (extensions/index.ts) / OpenCode V2 plugin (index.ts) / Amp plugin (.amp/plugins/ajevt-browser) / MCP server (packages/mcp)
  -> shared tool adapter (src/tool.ts)
  -> agent-browser adapter (session-scoped browser)
  -> snapshot -i + rendered page text observation + usefulness-ranked finite candidates
  -> one System One request/step (operation + speculative target heads + done/stuck/risky)
  -> strict probability/confidence/risk validation
  -> fresh snapshot guard
  -> agent-browser command
  -> deterministic verifier or compact structured handoff
```

Jev selects from finite operations and compatible targets derived from the current page. TYPE values come from `values`; missing values return `input_required`. Password, token, and secret values are redacted from Jev requests, and a field that already holds the caller's value is not offered again, so a filled secret field is never retyped. The operation question states that PRESS Enter submits a filled form with no visible submit control, which keeps the model from stalling on search boxes that render no button.

## Install

Install and provision the `agent-browser` runtime once, on the machine that runs the tool:

```bash
npm install -g agent-browser
agent-browser install
```

Then install the package for the host you use. Every host provides the same `ajevt_browser` tool, shares one executor, and reads the [configuration file](#configuration) below.

### Pi

```bash
pi install npm:ajevt-browser
pi -e npm:ajevt-browser   # try it without installing
```

### OpenCode V2

Add the package to `opencode.jsonc`. The package root exports the plugin:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["ajevt-browser"],
}
```

The package root exports the OpenCode V2 plugin, and the `pi.extensions` manifest registers `extensions/index.ts` with Pi. Both hosts provide the same `ajevt_browser` tool and shared execution behavior.

Pi renders themed progress and compact result summaries. Expanded tool rows show actions, verification evidence, session details, and next steps.

OpenCode loads the `./tui` export and presents concise tool results, structured handoff metadata, and lifecycle toasts.

### Amp

Install the plugin globally and link its bundled build into the [system plugin directory](https://ampcode.com/docs/customize/plugins):

```bash
npm install -g ajevt-browser
mkdir -p ~/.config/amp/plugins/ajevt-browser
ln -sf "$(npm root -g)/ajevt-browser/dist/ajevt-browser/index.js" ~/.config/amp/plugins/ajevt-browser/index.js
```

Use `$XDG_CONFIG_HOME/amp/plugins/ajevt-browser` when `XDG_CONFIG_HOME` is set. The symlink keeps the plugin on whatever version is installed globally, so `npm install -g ajevt-browser@latest` updates it. `amp plugins add` does not work here: it only accepts Amp-hosted plugin URLs. Confirm discovery with `amp plugins list`, and reload plugins in a running Amp session.

The plugin needs `agent-browser` on the Amp executor's PATH (or `AGENT_BROWSER_BIN`) and Jev credentials in that executor's environment or config file, which an orb does not inherit from your machine. Configuration errors return an `Ajevt Browser error:` tool result instead of failing plugin loading.

Ask Amp to call `ajevt_browser` with a bounded goal, a starting URL, deterministic `verifiers`, and known field contents in `values`.

### MCP

The `ajevt-browser-mcp` package provides a stdio MCP server and includes the MCP SDK runtime. Run the published server with `npx`:

```bash
npx -y ajevt-browser-mcp
```

An MCP client configuration:

```json
{
  "mcpServers": {
    "ajevt-browser": {
      "command": "npx",
      "args": ["-y", "ajevt-browser-mcp"]
    }
  }
}
```

MCP calls return a concise text summary and the complete handoff in `structuredContent`. The server supports cancellation and progress notifications.

Example tool input:

```json
{
  "goal": "Enter the supplied query and stop when the results page visibly contains Example Domain",
  "url": "https://example.test/search",
  "values": { "Search": "Example Domain" },
  "max_steps": 8,
  "allow_risky": false,
  "allowed_domains": ["example.test"],
  "proxy_bypass": ["example.test"],
  "host_mappings": { "example.test": "127.0.0.1" },
  "ignore_https_errors": false,
  "keep_session": true,
  "require_action": true,
  "verifiers": [{ "type": "text_contains", "text": "Example Domain" }]
}
```

Values can be keyed by `@ref`, exact field name, normalized lowercase name, or `role:name`. A key that only partly matches a field name (`Search` for `Search Wikipedia`) also binds, but only when exactly one typable field matches it; otherwise the call returns `input_required`. For dynamic pages where refs change after rerenders, prefer the `element_value_equals` verifier with a stable role/name match over ref-based `value_equals`.

Text verifiers read both the accessibility snapshot and the rendered page text, so `text_contains` matches prose such as a confirmation message that never appears in an interactive-only snapshot. Native `<select>` dropdowns are observed as option lists on their combobox, so they are driven with the `SELECT` operation instead of a click on an unclickable option.

## Configuration

Pi, OpenCode, Amp, and MCP use the same strict JSON configuration file:

```text
$XDG_CONFIG_HOME/ajevt-browser/config.json
# or ~/.config/ajevt-browser/config.json when XDG_CONFIG_HOME is unset
```

```json
{
  "decision": {
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "model": "jev-latest",
    "auth": { "env": "JEV_API_KEY" },
    "headers": { "x-provider-route": "fast" },
    "timeoutMs": 2000,
    "retries": 5
  }
}
```

Authentication can reference an environment variable or a protected absolute-path file:

```json
{ "decision": { "auth": { "file": "/run/secrets/jev-api-key" } } }
```

Secret files are regular files up to 16 KiB and, on Unix, are accessible only to their owner. Custom headers accept non-reserved header names and secret references. Jev endpoints use HTTPS, with HTTP accepted for loopback endpoints.

Set `AJEVT_BROWSER_CONFIG` to an absolute path to select a config file. Environment overrides are available for each decision setting:

```bash
export JEV_ENDPOINT='https://api.typesafe.ai/v1/systemone'
export JEV_API_KEY='...'
export JEV_MODEL='jev-latest'
export JEV_HEADERS='{"x-provider-route":"fast"}'
export JEV_TIMEOUT_MS='2000' # timeout for each attempt
export JEV_RETRIES='5'       # retries after the first attempt; range 0-5
```

OpenCode `plugins[].options` can apply the highest-priority override using the same document shape. The `package` entry takes an npm name or a local path:

```jsonc
{
  "plugins": [
    {
      "package": "ajevt-browser",
      "options": { "decision": { "model": "jev-latest", "timeoutMs": 3000 } },
    },
  ],
}
```

Precedence is OpenCode options (OpenCode only), environment variables, explicit/default user config, then defaults. Configuration is resolved for each tool call so file and secret rotation take effect without reloading the plugin.

## Safety and completion

- A second snapshot immediately before execution invalidates stale decisions.
- `allowed_domains` authorizes cross-origin navigation; boundary checks run before completion verification. Each entry covers its own host and its subdomains, with or without a `*.` prefix. The list is also passed to agent-browser's browser-level containment, but only when the caller supplies one, because that containment breaks sites that detect it (Bing leaves the page for `about:blank`). Without `allowed_domains` the loop still refuses cross-origin navigation.
- A link that opens its own tab cannot inherit that containment: the action fails or the session lands on `about:blank`, and the handoff reports that cause instead of a bare timeout. Retry without `allowed_domains` or choose a link that stays in the same tab.
- Destructive or commitment actions return `needs_confirmation`; `allow_risky: true` authorizes execution.
- Repeated actions and no-progress runs have small fixed budgets.
- `DONE` or high `goal_completed` returns `done` with passing verifiers and `likely_done` otherwise.
- Sessions close by default. `keep_session: true` returns a `session_id` that preserves cookies and page state for a follow-up call.
- Initial loads wait for DOM content, empty observations are retried briefly, and navigation-like actions receive a short settle delay.
- Read-only verifiers may pass on the initial page; set `require_action: true` for goals that must click, switch, or submit before completion.
- Development and tunneled environments can use `ignore_https_errors`, `ca_cert`, `proxy`, `proxy_bypass`, and structured `host_mappings`.
- Handoffs are one of: `done`, `likely_done`, `input_required`, `ambiguous`, `needs_confirmation`, `blocked`, `stuck`, `error`.

## Development

Clone the repository and install the workspace dependencies:

```bash
git clone https://github.com/XYenon/ajevt-browser
cd ajevt-browser
pnpm install
```

The checkout runs the same code as the published packages and each host can load it directly:

- **Pi**: `pi -e .`, or `pi install /absolute/path/to/ajevt-browser`
- **OpenCode V2**: use the checkout path in `opencode.jsonc`, `"plugins": ["/absolute/path/to/ajevt-browser"]`
- **Amp**: Amp loads `.amp/plugins/ajevt-browser/index.ts` when started in the checkout, so no install is needed; `pnpm build:amp` writes the bundle the published package ships to `dist/ajevt-browser/index.js`
- **MCP**: `pnpm --filter ajevt-browser-mcp start`, or point a client at the checkout with `pnpm --dir /absolute/path/to/ajevt-browser --filter ajevt-browser-mcp start`

### Checks

```bash
pnpm check          # lint, formatting, and import organization
pnpm check:fix      # apply safe lint, formatting, and import fixes
pnpm lint
pnpm format:check
pnpm format
pnpm test
pnpm typecheck
pnpm build:amp      # standalone Amp plugin bundle; pnpm pack runs this too
pnpm smoke          # real, read-only agent-browser smoke test against example.com
pnpm smoke:live     # read-only page test with a live Jev decision using JEV_* environment variables
pnpm smoke:complex  # local form: live Jev TYPE → CLICK → deterministic completion proof
pnpm smoke:sites    # broad live check against common websites (search, links, forms, dropdowns, login, async content, commitments, domain boundary)
```

The suite covers malformed probabilities, low confidence, stale state, repeated actions, missing input, secret redaction, confirmation policy, custom endpoints, and a complete fake-browser/fake-Jev offline loop.

### Publishing

Both packages ship from this workspace. Commit your changes first, because pnpm refuses to publish from a dirty working tree, then publish in dependency order:

```bash
pnpm -r publish
```

`pnpm --recursive` walks the workspace topologically, so `ajevt-browser` is published before `ajevt-browser-mcp`, and the `workspace:*` range in the MCP package is rewritten to the published version. The root package's `prepack` builds `dist/ajevt-browser/index.js` (the bundled Amp plugin) before packing, so it is always in the tarball. Both packages are unscoped and public.

## License

[AGPL-3.0-only](https://github.com/XYenon/ajevt-browser/blob/master/LICENSE)
