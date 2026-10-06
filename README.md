# Codex Desktop CUA MCP Wrapper

A local stdio MCP bridge to the Windows Computer Use runtime installed by Codex/ChatGPT Desktop. Uses Node.js built-ins and a native Windows confirmation dialog.

## Requirements

- Windows 11 with an interactive desktop session.
- Node.js 22+ and PowerShell 7 (`pwsh`) on `PATH`.
- Codex/ChatGPT Desktop running with Computer Use enabled and its plugin configuration generated.
- A stdio MCP client.
- For Chrome control: the Chrome plugin enabled in Desktop and the official ChatGPT extension enabled in Chrome.

Desktop's internal interfaces may change between releases.

## Connect

Keep the project files together. From the project directory, run PowerShell:

```powershell
$node = (Get-Command node -ErrorAction Stop).Source
$wrapper = (Resolve-Path -LiteralPath './wrapper.mjs').Path

# Pi: user-level registration
pi mcp add codex-desktop-cua --exposure codemode -- $node $wrapper
pi mcp list
```

For Codex CLI, use `codex mcp add codex-desktop-cua -- $node $wrapper`.
For other clients, set `command` to `$node` and `args` to `@($wrapper)` in their MCP configuration.
Reconnect the client after changes; Pi supports `/reload`.

The wrapper discovers the newest complete `unified-computer-use` plugin under `CODEX_HOME`, defaulting to `~/.codex`. Runtime paths and the local pipe address come from that plugin's configuration. Set `CODEX_HOME` in the client's environment for a custom installation. The wrapper enables the computer surface, and the browser surface when the plugin configures Desktop's browser service.

## Permissions

Choose in the local confirmation dialog:

- **Decline:** leave the request unauthorized.
- **Allow once:** accept the current request.
- **Allow this app:** accept, and reuse the approval for low-risk access to the same app for this connection.
- **Allow this site:** accept, and reuse the approval for browser access to the same exact origin for this connection.
- **YOLO:** automatically accept supported Computer Use and browser site confirmations for this connection, including higher-risk requests. Use only for trusted tasks.

Site confirmations appear when Desktop's browser approval setting asks before site access. Approvals stay within the connection; the wrapper never saves them to Desktop.

After a 15-second countdown, the dialog applies its default: **Allow this app** for low-risk app access, **Decline** otherwise. Enter selects the default. Escape and closing the dialog cancel. Unsupported forms also cancel. Reconnecting clears session approvals; `js_reset` keeps them. Windows permission boundaries still apply.

## Use

Read the `js` tool's runtime instructions. Initialize each new JavaScript session with:

```javascript
await cua.getState();
```

Select the exact target window, operate it, and verify the result from fresh app state or a screenshot. After cancellation, observe again before retrying input.

Allow 45 seconds for confirmation in both the MCP tool timeout and any outer execution timeout. Call `turn_ended` with no arguments, then `js_reset`, when a task ends or is interrupted. The wrapper supplies a connection session and turn to `js` calls that lack Codex turn metadata; `turn_ended` fills missing arguments from the latest `js` call's turn, closes that turn's browser tabs, and ends the local Computer Use indication; after it closes a wrapper turn, the next `js` call starts a new one. Supplied turn metadata and arguments are kept.

If the local pipe fails, start Desktop, enable Computer Use, and reconnect MCP to refresh its configuration.

## Tests

Default tests use a simulated backend and skip GUI tests:

```powershell
node --test wrapper.test.mjs consent.test.mjs
```

To include native dialog display and cancellation tests:

```powershell
$env:CUA_WRAPPER_GUI_TESTS = '1'
try { node --test wrapper.test.mjs consent.test.mjs }
finally { Remove-Item Env:CUA_WRAPPER_GUI_TESTS -ErrorAction SilentlyContinue }
```

Keep personal MCP configuration, logs, requests, and screenshots outside the repository. Desktop and the selected model provider retain their own licensing and data-handling policies.
