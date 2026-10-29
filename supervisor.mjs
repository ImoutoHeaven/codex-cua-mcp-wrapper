import { randomUUID } from 'node:crypto';
import { locate } from './locator.mjs';
import { plan, spawnBackend, terminate } from './launcher.mjs';
import { Consent } from './consent.mjs';
import { records, writer, StageError, log } from './rpc.mjs';

const RESTART_SPACING_MS = 1000;
const TURN_KEY = 'x-codex-turn-metadata';
const HOOK_ARGS = ['hook_event_name', 'session_id', 'turn_id'];
const SERVER_INFO = { name: 'codex-desktop-cua', version: '2.0.0' };

const INSTRUCTIONS = 'Use the js tool to control Windows apps and, when a browser is connected, Chrome. Approval requests open a local dialog; ' +
  'treat Decline or a cancelled approval as the user\'s answer. Never retry input whose result is uncertain; observe the current state first. ' +
  'When a task that used computer or browser control ends or is interrupted, call turn_ended with no arguments, then js_reset.';
const JS_GUIDANCE = '\n\nOn Windows, `cua.getApp` accepts only `{ windowId }` from `cua.listApps()` or `cua.listWindows()`. ' +
  'If the first observation after input looks unchanged, observe again before acting.\n\n' +
  'An empty `agent.browsers.list()` means this runtime found no connected browser. If Chrome is not running, open it through the ' +
  'computer surface when the user\'s task allows, then list browsers again. If Chrome is already running, ask the user to enable and ' +
  'connect the ChatGPT extension.\n\nWhen the task ends or is interrupted, call `turn_ended` with no arguments, then `js_reset`.';
const TURN_GUIDANCE = '\n\nCall with no arguments: the session and turn of the latest tool call are filled in, and the next call starts a new turn.';
const EMPTY_INVENTORY = 'No connected browser was found. If Chrome is not running, open it through the computer surface when the user\'s task ' +
  'allows, then call agent.browsers.list() again. If Chrome is already running, ask the user to enable and connect the ChatGPT extension.';
const PIPE_HINT = 'Computer Use could not reach Codex Desktop. Start ChatGPT or Codex Desktop with Computer Use enabled, reconnect this MCP ' +
  'server to load its current configuration, and observe the current state before repeating any input.';
const PIPE_FAILURE = /(?:native pipe|named pipe).*(?:unavailable|timed out|closed|failed|not found)|failed to connect native pipe/i;
const LIST = String.raw`(?:await\s+)?agent\.browsers\.list\(\s*\)`;
const LISTED = String.raw`(?:${LIST}|JSON\.stringify\(\s*${LIST}\s*\))`;
// Code whose only output is the browser inventory, so a printed [] can only be that inventory.
const INVENTORY_CODE = new RegExp(String.raw`^\s*(?:return\s+)?(?:${LISTED}|console\.log\(\s*${LISTED}\s*\))\s*;?\s*$`);

const key = id => `${typeof id}:${id}`;

// The MCP server the client talks to, and the MCP client of one backend generation at a time.
export class Supervisor {
  constructor({ input, output, env = process.env, consent = new Consent() }) {
    Object.assign(this, { input, env, consent });
    const send = writer(output);
    this.send = message => send(message).catch(() => this.shutdown());
    this.client = undefined; // initialize params
    this.ready = false;
    this.backend = undefined;
    this.starting = undefined;
    this.waiting = [];
    this.generations = 0;
    this.lastStart = 0;
    this.nextId = 1;
    this.nextReverse = 1;
    this.calls = new Map(); // backend id -> { front, method, gen, tool, ending }
    this.fronts = new Map(); // key(client id) -> backend id
    this.reverse = new Map(); // id sent to the client -> { gen, id }
    this.session = randomUUID();
    this.turn = 1;
    this.active = undefined; // turn metadata of the latest tool call
  }

  async run() {
    for await (const { message, error } of records(this.input)) {
      if (error) this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: error } });
      else {
        try { this.fromClient(message); } catch (failure) {
          log(`Could not handle a client message: ${failure.stack || failure}`);
          if (message.method && message.id !== undefined) this.reply(message.id, { error: { code: -32603, message: String(failure.message) } });
        }
      }
    }
    await this.shutdown();
  }

  reply(id, body) {
    this.send({ jsonrpc: '2.0', id, ...body });
  }

  fromClient(message) {
    const { id, method } = message;
    if (method === undefined && ('result' in message || 'error' in message)) {
      const target = this.reverse.get(id);
      if (target && message.jsonrpc === '2.0') {
        this.reverse.delete(id);
        if (this.backend?.n === target.gen) this.backend.send({ ...message, id: target.id });
      }
      return;
    }
    if (message.jsonrpc !== '2.0' || typeof method !== 'string' || (id !== undefined && !validId(id))) {
      return this.reply(validId(id) ? id : null, { error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request: it needs jsonrpc "2.0", a string method and a string or number id.' } });
    }
    if (id === undefined) return this.notification(message);
    if (method === 'ping') return this.reply(id, { result: {} });
    if (method === 'initialize') return this.initialize(message);
    if (!this.ready && !this.initializing) return this.reply(id, { error: { code: -32600, message: 'Send initialize first.' } });
    if (this.fronts.has(key(id)) || this.waiting.some(m => m.id !== undefined && key(m.id) === key(id))) {
      return this.reply(id, { error: { code: -32600, message: `Request id ${JSON.stringify(id)} is already in flight.` } });
    }
    // The model learns about a runtime that exited while idle before anything runs on its replacement.
    if (method === 'tools/call' && this.unreported) {
      const error = this.unreported;
      this.unreported = undefined;
      return this.fail(message, error);
    }
    this.toBackend(message);
  }

  notification(message) {
    if (message.method === 'notifications/initialized') return;
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId;
      const queued = this.waiting.findIndex(m => m.id !== undefined && key(m.id) === key(requestId));
      if (queued !== -1) return void this.waiting.splice(queued, 1);
      const id = this.fronts.get(key(requestId));
      const call = this.calls.get(id);
      if (!call || call.internal) return;
      // A cancelled request is finished for the client: its id may be reused and a late response is dropped.
      this.calls.delete(id);
      this.fronts.delete(key(requestId));
      this.consent.cancelled(id);
      this.ownerDone(id, true);
      if (this.backend?.n === call.gen) this.backend.send({ ...message, params: { ...message.params, requestId: id } });
      return;
    }
    if (this.starting) this.waiting.push(message);
    else this.backend?.send(message);
  }

  async initialize(message) {
    if (this.ready || this.initializing) {
      return this.reply(message.id, { error: { code: -32600, message: this.ready ? 'Already initialized.' : 'Initialize is already in progress.' } });
    }
    this.initializing = true;
    this.client = message.params && typeof message.params === 'object' ? message.params : {};
    try {
      await this.ensureBackend(gen => {
        const caps = gen.init.capabilities || {};
        this.ready = true;
        this.reply(message.id, { result: {
          protocolVersion: gen.init.protocolVersion,
          capabilities: caps.tools ? { ...caps, tools: { ...caps.tools, listChanged: true } } : caps,
          serverInfo: SERVER_INFO,
          instructions: [gen.init.instructions, INSTRUCTIONS].filter(Boolean).join('\n\n'),
        } });
      });
    } catch (error) {
      this.reply(message.id, { error: rpcError(error) });
    } finally {
      this.initializing = false;
    }
  }

  toBackend(message) {
    if (this.backend && !this.starting) return this.dispatch(message, this.backend);
    this.waiting.push(message);
    this.ensureBackend().catch(() => {});
  }

  // Starts a backend when none is running. Messages that arrive meanwhile wait in order.
  ensureBackend(onReady) {
    if (this.backend) return Promise.resolve(this.backend);
    if (this.closing) return Promise.reject(new StageError('launch', 'SHUTTING_DOWN', 'The wrapper is shutting down.'));
    return this.starting ||= (async () => {
      try {
        const wait = this.lastStart + RESTART_SPACING_MS - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        this.lastStart = Date.now();
        const gen = await this.start();
        if (this.closing) {
          await terminate(gen.child);
          throw new StageError('launch', 'SHUTTING_DOWN', 'The wrapper is shutting down.');
        }
        if (!gen.alive) throw new StageError('handshake', 'BACKEND_EXITED', `Runtime ${gen.name} exited right after initialize.`, { detail: gen.tail.trim() });
        const restarted = this.ready;
        this.backend = gen;
        this.starting = undefined;
        onReady?.(gen);
        if (restarted) this.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        for (const message of this.waiting.splice(0)) {
          if (message.id === undefined) gen.send(message);
          else this.dispatch(message, gen);
        }
        return gen;
      } catch (error) {
        this.starting = undefined;
        for (const message of this.waiting.splice(0)) if (message.id !== undefined) this.fail(message, error);
        throw error;
      }
    })();
  }

  async start() {
    const { candidates, skipped } = locate(this.env);
    for (const { name, reason } of skipped) log(`Skipped plugin build ${name}: ${reason}.`);
    const failures = [];
    for (const candidate of candidates) {
      if (this.closing) break;
      const launch = plan(candidate, this.env);
      for (const note of launch.notes) log(note);
      try {
        return await this.handshake(launch);
      } catch (error) {
        log(`Plugin build ${candidate.name} did not start: ${error.text?.() || error.message}`);
        failures.push(`${candidate.name}: ${error.text?.() || error.message}`);
      }
    }
    throw new StageError('launch', 'NO_RUNTIME_STARTED', 'No installed Computer Use runtime completed the MCP handshake.', {
      detail: failures.join('\n'),
      recovery: 'Update or repair Codex/ChatGPT Desktop, then call again. The wrapper log on stderr has each runtime\'s own output.',
    });
  }

  handshake(launch) {
    const n = ++this.generations;
    const child = spawnBackend(launch);
    const gen = { n, child, name: launch.name, alive: true, tail: '', dialogs: new Set() };
    this.launching = gen;
    const send = writer(child.stdin);
    // Ends the generation for a protocol or channel failure: pending requests fail first, then its processes end.
    const stop = reason => {
      if (finished || gen.lost) return;
      gen.lost = reason;
      finish({});
      this.retire(gen);
    };
    // A closed input or output channel ends the generation unless the process is already exiting.
    const broken = reason => setTimeout(() => stop(reason), 2000);
    gen.send = message => { if (gen.alive) send(message).catch(error => broken(`stopped accepting input (${error.message})`)); };
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => {
      process.stderr.write(chunk);
      gen.tail = (gen.tail + chunk).slice(-1500);
    });
    let finished = false, timer;
    const finish = info => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.exited(gen, info);
    };
    child.once('error', error => finish({ error }));
    // A descendant holding stdio delays close; the root's exit decides after a short drain.
    child.once('exit', (code, signal) => { timer = setTimeout(() => finish({ code, signal }), 2000); });
    child.once('close', (code, signal) => finish({ code, signal }));
    (async () => {
      for await (const { message, error } of records(child.stdout)) {
        if (error) log(`Ignored backend output that is not MCP: ${error}.`);
        else if (!gen.alive) continue;
        else if (envelopeProblem(message)) stop(`sent an invalid JSON-RPC message (${envelopeProblem(message)})`);
        else this.fromBackend(gen, message);
      }
      broken('closed its output');
    })().catch(error => broken(`output failed (${error.message})`));

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const limit = setTimeout(() => {
        this.calls.delete(id);
        if (this.launching === gen) this.launching = undefined;
        reject(new StageError('handshake', 'INIT_TIMEOUT', `Runtime ${launch.name} did not answer initialize within ${launch.startupMs / 1000} s.`, { detail: gen.tail.trim() }));
        this.retire(gen);
      }, launch.startupMs);
      this.calls.set(id, { gen: n, internal: (response, error) => {
        clearTimeout(limit);
        if (this.launching === gen) this.launching = undefined;
        if (error) return reject(error);
        const result = response.result;
        if (response.error || !isObject(result) || typeof result.protocolVersion !== 'string' || !isObject(result.capabilities)) {
          reject(new StageError('handshake', 'INIT_REJECTED', `Runtime ${launch.name} did not complete initialize: ${response.error?.message || 'the result lacks protocolVersion or capabilities'}.`));
          return this.retire(gen);
        }
        gen.init = response.result;
        gen.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        log(`Started runtime ${launch.name} (generation ${n}).`);
        resolve(gen);
      } });
      const caps = { ...(this.client.capabilities || {}) };
      // Local confirmations are answered here, so the backend may always ask for form confirmations.
      caps.elicitation = { ...(caps.elicitation || {}), form: caps.elicitation?.form || {} };
      gen.send({ jsonrpc: '2.0', id, method: 'initialize', params: { ...this.client, capabilities: caps } });
    });
  }

  // Stops a generation: it sends and receives nothing more, and its processes end.
  retire(gen) {
    gen.alive = false;
    if (this.backend === gen) this.backend = undefined;
    terminate(gen.child).then(clean => { if (!clean) log(`A process started by runtime generation ${gen.n} outlived it and kept its output open.`); });
  }

  exited(gen, { code, signal, error }) {
    gen.alive = false;
    if (this.backend === gen) this.backend = undefined;
    const how = gen.lost || (error ? `could not run (${error.message})` : `exited (${signal ? `signal ${signal}` : `code ${code}`})`);
    if (!this.closing) log(`Runtime generation ${gen.n} ${how}.`);
    for (const abort of gen.dialogs) abort();
    let reported = false;
    for (const [id, call] of this.calls) {
      if (call.gen !== gen.n) continue;
      this.calls.delete(id);
      if (call.internal) {
        call.internal(undefined, new StageError('handshake', 'BACKEND_EXITED', `Runtime ${gen.name} ${how} before completing initialize.`, { detail: gen.tail.trim() }));
        continue;
      }
      this.fronts.delete(key(call.front));
      this.consent.settled(id);
      reported ||= call.method === 'tools/call';
      this.fail({ id: call.front, method: call.method }, new StageError('backend', 'BACKEND_EXITED',
        `The Computer Use runtime (generation ${gen.n}) ${how} while this request was running. Its JavaScript state and any input in progress were lost; the request was not retried.`,
        { detail: gen.tail.trim().slice(-600), recovery: 'Observe the current state with a new call before repeating anything; the next call starts a new runtime.' }));
    }
    if (!reported && gen.init && !this.closing) {
      this.unreported = new StageError('backend', 'STATE_LOST',
        `The Computer Use runtime (generation ${gen.n}) ${how} while idle. Its JavaScript state was lost, and this call was not run.`,
        { detail: gen.tail.trim().slice(-600), recovery: 'Call again to start a new runtime, and observe the current state before acting.' });
    }
    for (const [id, target] of this.reverse) {
      if (target.gen !== gen.n) continue;
      this.reverse.delete(id);
      this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'The Computer Use runtime exited.' } });
    }
    if (gen.child.stdout.readable) this.retire(gen);
  }

  fail(message, error) {
    if (message.method === 'tools/call') this.reply(message.id, { result: toolError(error) });
    else this.reply(message.id, { error: rpcError(error) });
  }

  dispatch(message, gen) {
    const id = this.nextId++;
    const tool = message.method === 'tools/call' ? message.params?.name : undefined;
    const call = { front: message.id, method: message.method, gen: gen.n, tool, code: message.params?.arguments?.code };
    if (tool !== undefined) this.adaptCall(message.params, id, call);
    this.calls.set(id, call);
    this.fronts.set(key(message.id), id);
    gen.send({ ...message, id });
  }

  turnMeta() {
    return { session_id: this.session, turn_id: `${this.session}:${this.turn}` };
  }

  // Supplies the Codex turn identity that standalone clients do not send, and the arguments a bare turn_ended needs.
  adaptCall(params, id, call) {
    if (params.name === 'turn_ended' || params.name === 'js_reset') {
      this.consent.cancelAll();
      this.withdraw(() => true);
    }
    if (params.name === 'js_reset') return;
    if (params.name === 'turn_ended') {
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : (params.arguments = {});
      const target = this.active || this.turnMeta();
      args.hook_event_name ??= 'Stop';
      args.session_id ??= target.session_id;
      args.turn_id ??= target.turn_id;
      // The next call starts the next wrapper turn now, so it cannot join the closing one.
      if (args.session_id === this.session && args.turn_id === this.turnMeta().turn_id) {
        call.ending = { meta: this.turnMeta(), turn: this.turn };
        this.turn++;
        this.active = undefined;
      }
      return;
    }
    const meta = params._meta && typeof params._meta === 'object' ? params._meta : (params._meta = {});
    meta[TURN_KEY] ??= this.turnMeta();
    this.active = parseMeta(meta[TURN_KEY]);
  }

  fromBackend(gen, message) {
    const { id, method } = message;
    if (method === undefined) return this.response(gen, message);
    if (id === undefined) {
      if (method === 'notifications/cancelled') {
        const requestId = message.params?.requestId;
        const local = [...gen.dialogs].find(d => key(d.id) === key(requestId));
        if (local) return local();
        for (const [wrapped, target] of this.reverse) {
          if (target.gen === gen.n && key(target.id) === key(requestId)) {
            this.reverse.delete(wrapped);
            return this.send({ ...message, params: { ...message.params, requestId: wrapped } });
          }
        }
        return;
      }
      return this.send(message);
    }
    if (method === 'elicitation/create') return this.elicit(gen, message);
    this.forwardToClient(gen, message);
  }

  // owners: for a forwarded approval, the tool calls that may own it, as for local confirmations.
  forwardToClient(gen, message, owners) {
    const wrapped = `cua-${this.nextReverse++}`;
    this.reverse.set(wrapped, { gen: gen.n, id: message.id, owners });
    this.send({ ...message, id: wrapped });
  }

  // A forwarded approval ends, answered as cancelled, when a call that may own it is cancelled or all of them finish.
  ownerDone(id, cancelled) {
    this.withdraw(owners => cancelled ? owners.has(id) : owners.delete(id) && !owners.size);
  }

  // Withdraws the forwarded approvals that match: the client is told, and the runtime gets cancel.
  withdraw(matches) {
    for (const [wrapped, target] of this.reverse) {
      if (!target.owners || !matches(target.owners)) continue;
      this.reverse.delete(wrapped);
      this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: wrapped, reason: 'The tool call that asked for this approval ended.' } });
      if (this.backend?.n === target.gen) this.backend.send({ jsonrpc: '2.0', id: target.id, result: { action: 'cancel' } });
    }
  }

  // An approval belongs to a client request still running on this runtime; one that arrives with none is cancelled.
  elicit(gen, message) {
    const owners = new Set([...this.calls].filter(([, c]) => c.gen === gen.n && !c.internal).map(([id]) => id));
    if (!owners.size || this.closing) {
      log('Cancelled an approval request that no running client request can own.');
      return gen.send({ jsonrpc: '2.0', id: message.id, result: { action: 'cancel' } });
    }
    const handle = this.consent.request(message.params, owners);
    if (handle) {
      const abort = Object.assign(() => handle.abort(), { id: message.id });
      gen.dialogs.add(abort);
      handle.result.then(result => {
        gen.dialogs.delete(abort);
        gen.send({ jsonrpc: '2.0', id: message.id, result });
      });
      return;
    }
    const supports = this.client?.capabilities?.elicitation;
    const mode = message.params?.mode ?? 'form';
    const formOk = supports && typeof supports === 'object' && (mode === 'form' ? (!supports.url || supports.form) : !!supports[mode]);
    if (formOk) return this.forwardToClient(gen, message, owners);
    log('Refused an approval form this wrapper cannot show; nothing was approved.');
    gen.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601,
      message: 'codex-desktop-cua cannot show this approval form and the MCP client does not accept forms; nothing was approved. [consent/UNSUPPORTED_FORM]',
      data: { stage: 'consent', code: 'UNSUPPORTED_FORM' } } });
  }

  response(gen, message) {
    const call = this.calls.get(message.id);
    if (!call || call.gen !== gen.n) return;
    this.calls.delete(message.id);
    if (call.internal) return call.internal(message);
    this.fronts.delete(key(call.front));
    this.consent.settled(message.id);
    this.ownerDone(message.id, false);
    const result = message.result;
    const failed = !!message.error || result?.isError === true;
    if (call.ending && failed && call.ending.turn === this.turn - 1) this.active ||= call.ending.meta;
    if (call.method === 'tools/list' && Array.isArray(result?.tools)) adaptTools(result.tools);
    if (call.method === 'tools/call' && result && Array.isArray(result.content)) {
      const text = result.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
      if (result.isError && PIPE_FAILURE.test(text)) result.content.push({ type: 'text', text: PIPE_HINT });
      if (!result.isError && call.tool === 'js' && typeof call.code === 'string' && INVENTORY_CODE.test(call.code) &&
        text.split('\n').some(line => line.trim() === '[]')) result.content.push({ type: 'text', text: EMPTY_INVENTORY });
    }
    if (message.error && PIPE_FAILURE.test(message.error.message || '')) message.error.message += `\n${PIPE_HINT}`;
    this.send({ ...message, id: call.front });
  }

  shutdown() {
    return this.stopping ||= (async () => {
      this.closing = true;
      this.consent.cancelAll();
      if (this.launching) this.retire(this.launching);
      await this.starting?.catch(() => {});
      const gen = this.backend;
      if (gen) {
        this.backend = undefined;
        const clean = await terminate(gen.child);
        if (!clean) log(`A process started by runtime generation ${gen.n} outlived it and kept its output open.`);
      }
    })();
  }
}

function adaptTools(tools) {
  for (const tool of tools) {
    if (tool?.name === 'js' && typeof tool.description === 'string') tool.description += JS_GUIDANCE;
    if (tool?.name === 'turn_ended') {
      const required = tool.inputSchema?.required;
      if (Array.isArray(required)) {
        tool.inputSchema.required = required.filter(name => !HOOK_ARGS.includes(name));
        if (!tool.inputSchema.required.length) delete tool.inputSchema.required;
      }
      if (typeof tool.description === 'string') tool.description += TURN_GUIDANCE;
    }
  }
}

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

// The JSON-RPC 2.0 envelope of a backend message; its method names and fields are not restricted.
function envelopeProblem(message) {
  if (message.jsonrpc !== '2.0') return 'jsonrpc is not "2.0"';
  if (message.method === undefined) {
    if (!validId(message.id)) return 'response id is not a string or number';
    if (('result' in message) === ('error' in message)) return 'response needs exactly one of result and error';
    if ('error' in message && !(isObject(message.error) && Number.isInteger(message.error.code) && typeof message.error.message === 'string')) return 'error is not a JSON-RPC error object';
    return;
  }
  if (typeof message.method !== 'string') return 'method is not a string';
  if (message.id !== undefined && !validId(message.id)) return 'request id is not a string or number';
  if (message.params !== undefined && !(isObject(message.params) || Array.isArray(message.params))) return 'params is not an object or array';
}

function parseMeta(meta) {
  try { return typeof meta === 'string' ? JSON.parse(meta) : meta; } catch { return undefined; }
}

const asStage = error => error instanceof StageError ? error : new StageError('wrapper', 'INTERNAL', error.message || String(error));
const rpcError = error => asStage(error).rpcError();
const toolError = error => asStage(error).toolResult();
