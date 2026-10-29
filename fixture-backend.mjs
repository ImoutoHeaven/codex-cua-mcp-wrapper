// Synthetic MCP backend for tests. It speaks NDJSON on stdio and never touches Computer Use.
import { spawn } from 'node:child_process';

const out = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const seen = [];
const cancelled = [];
const answers = [];
const waiting = new Map(); // our request id -> tool call id
let ours = 0;

const TOOLS = [
  { name: 'js', description: 'Run JavaScript.', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'turn_ended', description: 'End the turn.', inputSchema: { type: 'object', properties: { hook_event_name: {}, session_id: {}, turn_id: {}, reason: {} }, required: ['hook_event_name', 'session_id', 'turn_id', 'reason'] } },
  { name: 'js_reset', description: 'Reset.', inputSchema: { type: 'object' } },
  { name: 'mystery_tool', description: 'Unknown to the wrapper.', inputSchema: { type: 'object', properties: { depth: { type: 'integer', minimum: 1 } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
];

function call(q) {
  const { name, arguments: args = {}, _meta: meta } = q.params;
  if (name === 'turn_ended') return out({ id: q.id, result: args.hook_event_name === 'fail' ? { isError: true, content: [{ type: 'text', text: 'cleanup failed' }] } : text({ args }) });
  if (name !== 'js') return out({ id: q.id, result: text({ name, args, meta }) });
  const code = String(args.code);
  seen.push(code);
  if (code === 'env') return out({ id: q.id, result: text({ execArgv: process.execArgv, argv: process.argv.slice(2), executor: process.env.BROWSER_USE_ACCESS_EXECUTOR_ID ?? null, marker: process.env.FIXTURE_MARKER ?? null, surfaces: process.env.CUA_REPL_ENABLED_SURFACES ?? null, services: process.env.NODE_REPL_TRUSTED_SERVICES ?? null, hostArgv: process.env.CUA_JOB_HOST_ARGV ?? null, pid: process.pid }) });
  if (code === 'die') { process.stderr.write('fixture: crashing on request\n'); process.exit(7); }
  if (code === 'hang') return;
  if (code === 'bad-envelope') return out({ jsonrpc: 'BROKEN', id: q.id, result: text('leaked') });
  if (code === 'exit-soon') { out({ id: q.id, result: text('bye') }); return setTimeout(() => process.exit(9), 100); }
  if (code === 'state') return out({ id: q.id, result: text({ seen, cancelled, answers, pid: process.pid }) });
  if (code === 'pipe') return out({ id: q.id, result: { isError: true, content: [{ type: 'text', text: 'Computer Use native pipe is unavailable: os error 2' }] } });
  // A helper process that does not hold the backend's stdio, and one that does while the root exits.
  if (code === 'helper') {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    return out({ id: q.id, result: text({ helper: helper.pid }) });
  }
  if (code === 'orphan') {
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
    out({ id: q.id, result: text({ helper: helper.pid }) });
    return setTimeout(() => process.exit(5), 300);
  }
  if (code.includes('agent.browsers.list()') || code === '[]') {
    return out({ id: q.id, result: { content: [{ type: 'text', text: 'Runtime notes: browsers are listed below.' }, { type: 'text', text: process.env.FIXTURE_BROWSERS ?? '[]' }] } });
  }
  // ask: waits for the answer before completing the call; post: completes the call at once; later: asks after completing it.
  if (code.startsWith('later:')) {
    out({ id: q.id, result: text('done') });
    return setTimeout(() => out({ id: `fixture-${++ours}`, method: 'elicitation/create', params: JSON.parse(code.slice(6))[1] }), 100);
  }
  if (code.startsWith('ask:') || code.startsWith('post:')) {
    const [method, params] = JSON.parse(code.slice(code.indexOf(':') + 1));
    ++ours;
    if (code.startsWith('ask:')) waiting.set(ours, q.id);
    out({ id: `fixture-${ours}`, method, params });
    if (code.startsWith('post:')) out({ id: q.id, result: text('posted') });
    return;
  }
  out({ id: q.id, result: text({ code, meta }) });
}

process.stdin.setEncoding('utf8');
let buffer = '';
for await (const chunk of process.stdin) {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const q = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (q.method === 'notifications/cancelled') { cancelled.push(q.params.requestId); continue; }
    if (q.method === undefined) {
      answers.push(q.result ?? q.error);
      const owner = waiting.get(Number(String(q.id).slice('fixture-'.length)));
      if (owner !== undefined) out({ id: owner, result: text({ answer: q.result ?? null, error: q.error ?? null }) });
      continue;
    }
    if (q.id === undefined) continue;
    if (q.method === 'initialize') {
      if (process.env.FIXTURE_INIT === 'exit') { process.stderr.write('fixture: refusing to start\n'); process.exit(3); }
      if (process.env.FIXTURE_INIT === 'empty') { out({ id: q.id, result: {} }); continue; }
      if (process.env.FIXTURE_INIT === 'silent') continue;
      if (process.env.FIXTURE_INIT === 'array-caps') { out({ id: q.id, result: { protocolVersion: q.params.protocolVersion, capabilities: [] } }); continue; }
      out({ id: q.id, result: { protocolVersion: q.params.protocolVersion, capabilities: { tools: {}, logging: {} }, serverInfo: { name: 'fixture', version: '1' }, instructions: `backend instructions; client elicitation ${JSON.stringify(q.params.capabilities?.elicitation)}` } });
    } else if (q.method === 'tools/list') {
      out({ id: q.id, result: q.params?.cursor === 'page-2' ? { tools: [{ name: 'late_tool', inputSchema: { type: 'object' } }] } : { tools: TOOLS, nextCursor: 'page-2' } });
    } else if (q.method === 'tools/call') call(q);
    else if (q.method === 'custom/ask') { waiting.set(++ours, q.id); out({ id: `fixture-${ours}`, method: 'elicitation/create', params: q.params }); }
    else out({ id: q.id, error: { code: -32601, message: `fixture: no method ${q.method}` } });
  }
}
