import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StageError } from './rpc.mjs';

const RECOVERY = 'Install or update Codex/ChatGPT Desktop with Computer Use enabled, or set CODEX_HOME for this MCP server to the Codex home that holds the plugin.';

export function pluginRoot(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'unified-computer-use');
}

// Every installed plugin build that declares a cua_repl server, newest directory name first.
// Returns usable candidates and the reason each other build was skipped.
export function locate(env = process.env) {
  const root = pluginRoot(env);
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }) || (a < b ? 1 : -1));
  } catch (cause) {
    throw new StageError('locate', 'PLUGIN_NOT_FOUND', `No Computer Use plugin folder at ${root}.`, { cause, recovery: RECOVERY });
  }
  const candidates = [];
  const skipped = [];
  for (const name of names) {
    const manifest = join(root, name, '.mcp.json');
    try {
      const server = JSON.parse(readFileSync(manifest, 'utf8'))?.mcpServers?.cua_repl;
      const problem = invalid(server);
      if (problem) skipped.push({ name, reason: problem });
      else candidates.push({ name, manifest, server });
    } catch (error) {
      skipped.push({ name, reason: error.code === 'ENOENT' ? 'no .mcp.json' : `unreadable .mcp.json (${error.message})` });
    }
  }
  if (!candidates.length) {
    throw new StageError('locate', 'NO_USABLE_PLUGIN', `No usable Computer Use plugin build under ${root}.`, {
      detail: skipped.map(s => `${s.name}: ${s.reason}`).join('\n') || 'The folder is empty.', recovery: RECOVERY });
  }
  return { root, candidates, skipped };
}

// Minimal launch shape plus the runtime files the launch needs; arguments stay opaque and the backend handshake
// decides the rest.
function invalid(server) {
  if (!server || typeof server !== 'object') return 'no mcpServers.cua_repl entry';
  if (server.enabled === false) return 'cua_repl is disabled';
  if (typeof server.command !== 'string' || !server.command) return 'command is missing';
  if (server.args !== undefined && !(Array.isArray(server.args) && server.args.every(a => typeof a === 'string'))) return 'args is not a string array';
  if (server.env !== undefined && (typeof server.env !== 'object' || Array.isArray(server.env) || Object.values(server.env).some(v => typeof v !== 'string'))) return 'env is not a string map';
  if (server.cwd !== undefined && typeof server.cwd !== 'string') return 'cwd is not a string';
  for (const path of [server.command, server.env?.CUA_REPL_NODE_REPL_PATH]) {
    if (path && isAbsolute(path) && !statSync(path, { throwIfNoEntry: false })?.isFile()) return `missing file ${path}`;
  }
}
