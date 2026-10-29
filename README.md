# Codex Desktop CUA MCP Wrapper

A local stdio MCP server that runs the Computer Use runtime bundled with Codex/ChatGPT Desktop for any MCP client. It uses Node.js built-ins, PowerShell 7, and a native Windows confirmation dialog.

## Requirements

- Windows 11 with an interactive desktop session.
- Node.js 22+ and PowerShell 7 (`pwsh`) on `PATH`.
- Codex/ChatGPT Desktop with Computer Use enabled, which installs the `unified-computer-use` plugin.
- A stdio MCP client.
- For Chrome control: the official ChatGPT extension enabled in Chrome.

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

## How the runtime starts

On `initialize`, the wrapper reads every build under `CODEX_HOME/plugins/cache/openai-bundled/unified-computer-use` (`CODEX_HOME` defaults to `~/.codex`) and starts the `cua_repl` server from the newest build whose `.mcp.json` is complete and whose runtime answers the MCP handshake within the manifest's `startup_timeout_sec` (30 seconds when absent). Builds are ordered by folder name; there is no version allowlist. The command, arguments, working directory and environment come from the manifest, merged over the wrapper's own environment.

The plugin's browser-access bootstrap (an `--import` of a module that only sets `BROWSER_USE_ACCESS_EXECUTOR_ID` to an empty string) needs Desktop's browser-access host. The wrapper leaves that bootstrap out when it appears among the leading `--import`/`--require` options and none of `BROWSER_USE_ACCESS_EXECUTOR_ID`, `BROWSER_USE_ACCESS_PIPE_PATH`, `BROWSER_USE_ACCESS_VERIFYING_IDENTITY` or `CODEX_WINDOWS_REGISTERED_CORE` is set in the launch environment. Every other argument and preload is passed unchanged.

The runtime runs inside a Windows job object owned by `job-host.ps1`. When the runtime's root process exits, the wrapper exits, or the wrapper stops the runtime, every process in the job ends.

The wrapper serves the runtime's tools, including tools it does not know, with their schemas. It adds usage notes to the `js` tool description and makes the hook arguments of `turn_ended` optional.

## Errors

Wrapper failures name a stage and a code, such as `[locate/PLUGIN_NOT_FOUND]` or `[handshake/BACKEND_EXITED]`, and include the underlying cause and the next step. Startup failures are returned as the `initialize` error. A tool call that fails returns a tool result with `isError`, so the model reads it.

The wrapper stops a runtime that sends a message breaking the JSON-RPC 2.0 envelope, or closes its input or output, and treats it as exited; the message never reaches the client. If the runtime exits during a call, that call fails with `[backend/BACKEND_EXITED]`: its JavaScript state and any input in progress are lost, and the wrapper does not retry it. If it exits between calls, the next tool call fails with `[backend/STATE_LOST]` without running. The call after that starts a new runtime, and the client receives `notifications/tools/list_changed`.

The wrapper's diagnostics and the runtime's stderr go to stderr; stdout carries only MCP messages.

## Permissions

Confirmation requests from Computer Use and Chrome open a local dialog:

- **Decline:** refuse this request.
- **Allow once:** accept this request.
- **Allow until reconnect:** accept, and accept later requests for the same low-risk app, or the same exact site origin, with the same approval details until the MCP connection closes.
- **YOLO:** after a second confirmation, accept supported Computer Use and browser site requests, including high-risk ones, until the MCP connection closes. Use only for trusted tasks.

The default button counts down 15 seconds and then applies itself: **Allow until reconnect** for low-risk app access, **Decline** for everything else. Opening **Details** or **YOLO** stops the countdown. Enter selects the default; Escape and closing the window cancel.

The wrapper keeps its grants and YOLO in memory until the MCP connection closes. Desktop's browser service may also remember a browser decision for the conversation, including Allow once and Decline; the dialog shows this for browser requests.

Confirmations whose form asks for input go to the MCP client when it supports form requests, and are refused with `[consent/UNSUPPORTED_FORM]` otherwise. Nothing is approved on the user's behalf. Windows permissions and Desktop's own browser policies still apply.

## Use

Read the `js` tool's description. Start each new JavaScript session with:

```javascript
await cua.getState();
```

Select the exact target window, operate it, and verify the result from fresh app state or a screenshot. After a cancellation or failure, observe again before repeating any input.

For Chrome, list browsers with `agent.browsers.list()`. An empty list means the runtime found no connected browser: open Chrome if it is not running, then list again; if it is running, enable and connect the ChatGPT extension.

Allow 45 seconds for a confirmation in both the MCP tool timeout and any outer execution timeout. When a task ends or is interrupted, call `turn_ended` with no arguments, then `js_reset`. Tool calls without Codex turn metadata get this connection's session and current turn; a bare `turn_ended` closes the turn of the latest call, closing the browser tabs that turn opened, and the next call starts a new turn. Turn metadata and arguments the client sends are kept.

If a tool result reports that Computer Use could not reach Codex Desktop, start Desktop with Computer Use enabled, reconnect the MCP server so the wrapper reads the current plugin configuration, and observe the current state before repeating any input.

## Tests

Tests run the wrapper against `fixture-backend.mjs`, a synthetic MCP backend in a temporary Codex home; they never start the installed runtime.

```powershell
node --test
```

To include the native dialog test, which shows the dialog briefly and cancels it:

```powershell
$env:CUA_WRAPPER_GUI_TESTS = '1'
try { node --test }
finally { Remove-Item Env:CUA_WRAPPER_GUI_TESTS -ErrorAction SilentlyContinue }
```

Keep personal MCP configuration, logs, requests, and screenshots outside the repository. Desktop and the selected model provider retain their own licensing and data-handling policies.
