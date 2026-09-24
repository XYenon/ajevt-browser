# ajevt-browser-mcp

The stdio MCP server for [ajevt-browser](https://github.com/XYenon/ajevt-browser). It exposes one `ajevt_browser` tool backed by the shared executor, returns a concise text summary plus the complete handoff in `structuredContent`, and supports cancellation and progress notifications.

## Install

The server drives the `agent-browser` runtime, so install and provision it once:

```bash
npm install -g agent-browser
agent-browser install
```

Configure Jev as described in the [configuration section](https://github.com/XYenon/ajevt-browser#configuration) of the main README.

## MCP client configuration

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

## Tool input

```json
{
  "goal": "Enter the supplied query and stop when the results page visibly contains Example Domain",
  "url": "https://example.test/search",
  "values": { "Search": "Example Domain" },
  "max_steps": 8,
  "verifiers": [{ "type": "text_contains", "text": "Example Domain" }]
}
```

See the [MCP section](https://github.com/XYenon/ajevt-browser#mcp) of the main README for the full input schema, the verifier types, and the safety and completion policy.

## License

[AGPL-3.0-only](https://github.com/XYenon/ajevt-browser/blob/master/LICENSE)
