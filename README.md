# ajevt-browser

A bounded Jev System-1 browser tool for Pi, OpenCode V2, Amp, and MCP. A single `ajevt_browser` call runs an observe/decide/validate/act loop using Vercel `agent-browser`.

## Architecture

```text
Pi extension (extensions/index.ts) / OpenCode V2 plugin (index.ts) / Amp plugin (.amp/plugins/ajevt-browser) / MCP server (packages/mcp)
  -> shared tool adapter (src/tool.ts)
  -> agent-browser adapter (session-scoped browser)
  -> snapshot -i observation + usefulness-ranked finite candidates
  -> one System One request/step (operation + speculative target heads + done/stuck/risky)
  -> strict probability/confidence/risk validation
  -> fresh snapshot guard
  -> agent-browser command
  -> deterministic verifier or compact structured handoff
```

Jev selects from finite operations and compatible targets derived from the current page. TYPE values come from `values`; missing values return `input_required`. Password, token, and secret values are redacted from Jev requests.

## Requirements

```bash
pnpm install
pnpm add -g agent-browser
agent-browser install
```

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

OpenCode `plugins[].options` can apply the highest-priority override using the same document shape:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/ajevt-browser",
      "options": { "decision": { "model": "jev-latest", "timeoutMs": 3000 } },
    },
  ],
}
```

Precedence is OpenCode options (OpenCode only), environment variables, explicit/default user config, then defaults. Configuration is resolved for each tool call so file and secret rotation take effect without reloading the plugin.

## Loading

Load into Pi:

```bash
pi -e .
# or
pi install /absolute/path/to/ajevt-browser
```

Load into OpenCode V2 from this checkout by adding the package directory to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/ajevt-browser"],
}
```

The package root exports the OpenCode V2 plugin, and the `pi.extensions` manifest registers `extensions/index.ts` with Pi. Both hosts provide the same `ajevt_browser` tool and shared execution behavior.

Pi renders themed progress and compact result summaries. Expanded tool rows show actions, verification evidence, session details, and next steps.

OpenCode loads the `./tui` export and presents concise tool results, structured handoff metadata, and lifecycle toasts.

### Amp Plugin

Amp discovers `.amp/plugins/ajevt-browser/index.ts` automatically when started in this checkout. This directory and its `index.ts` default export are the [official Amp plugin manifest/entry convention](https://ampcode.com/docs/customize/plugins); there is no separate plugin JSON manifest. The entry registers one agent-callable `ajevt_browser` tool using the shared schema, executor, and handoff formatter. Its text result includes a readable summary and the complete handoff JSON. Amp's tool API does not expose a cancellation signal or a separate structured-result field, unlike the MCP adapter.

For this checkout, run `pnpm install`, install `agent-browser` as above, configure Jev as above, then run `amp` here (or reload plugins in an existing Amp session). Check discovery with `amp plugins list`. The plugin requires `agent-browser` on the **Amp executor's PATH** (or `AGENT_BROWSER_BIN`), a working browser installation, and Jev credentials in the **executor's** environment/config file. In an orb these are not automatically inherited from your local machine. Amp configuration settings are not used for secrets; the existing per-call configuration and secret-file checks apply unchanged. Configuration errors return an `Ajevt Browser error:` tool result instead of aborting plugin loading.

To use it in another Amp project from a packaged checkout:

```bash
pnpm build:amp
mkdir -p /path/to/project/.amp/plugins/ajevt-browser
cp dist/ajevt-browser/index.js /path/to/project/.amp/plugins/ajevt-browser/index.js
```

`pnpm pack` runs `build:amp` automatically and includes `dist/ajevt-browser/index.js` in the tarball (`ajevt-browser/amp` package export). Copy that file from the unpacked package to the target project's `.amp/plugins/ajevt-browser/index.js`; it is bundled and has no project-relative source imports. Install and configure `agent-browser` and Jev in the target executor as above. Do not install it with `amp plugins add`: that command expects an Amp-hosted plugin URL, not an npm package or GitHub repository URL. The Amp plugin is a thin native tool adapter rather than an MCP subprocess or a skill, since the repository already has a shared executor and a single bounded operation; use the existing MCP server with other MCP clients.

Ask Amp to call `ajevt_browser` with a bounded goal, starting URL and deterministic `verifiers`. Provide known field contents via `values`. `likely_done` is not proof; `needs_confirmation` means inspect the pending action and explicitly retry with `allow_risky: true` only when authorized. The tool can navigate and submit forms, so review the URL/domain scope and risk policy before use.

### MCP

The `ajevt-browser-mcp` package provides a stdio MCP server and includes the MCP SDK runtime.

Run it from this checkout with:

```bash
pnpm --filter ajevt-browser-mcp start
```

For an MCP client configuration that launches this checkout directly:

```json
{
  "mcpServers": {
    "ajevt-browser": {
      "command": "pnpm",
      "args": [
        "--dir",
        "/absolute/path/to/ajevt-browser",
        "--filter",
        "ajevt-browser-mcp",
        "start"
      ]
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

Values can be keyed by `@ref`, exact field name, normalized lowercase name, or `role:name`. For dynamic pages where refs change after rerenders, prefer the `element_value_equals` verifier with a stable role/name match over ref-based `value_equals`.

## Safety and completion

- A second snapshot immediately before execution invalidates stale decisions.
- `allowed_domains` authorizes cross-origin navigation; boundary checks run before completion verification, and the allowlist is also passed to agent-browser.
- Destructive or commitment actions return `needs_confirmation`; `allow_risky: true` authorizes execution.
- Repeated actions and no-progress runs have small fixed budgets.
- `DONE` or high `goal_completed` returns `done` with passing verifiers and `likely_done` otherwise.
- Sessions close by default. `keep_session: true` returns a `session_id` that preserves cookies and page state for a follow-up call.
- Initial loads wait for DOM content, empty observations are retried briefly, and navigation-like actions receive a short settle delay.
- Read-only verifiers may pass on the initial page; set `require_action: true` for goals that must click, switch, or submit before completion.
- Development and tunneled environments can use `ignore_https_errors`, `ca_cert`, `proxy`, `proxy_bypass`, and structured `host_mappings`.
- Handoffs are one of: `done`, `likely_done`, `input_required`, `ambiguous`, `needs_confirmation`, `blocked`, `stuck`, `error`.

## Development checks

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
```

The suite covers malformed probabilities, low confidence, stale state, repeated actions, missing input, secret redaction, confirmation policy, custom endpoints, and a complete fake-browser/fake-Jev offline loop.
