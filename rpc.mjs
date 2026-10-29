export const LOG = '[codex-desktop-cua]';
export const log = message => process.stderr.write(`${LOG} ${message}\n`);
const MAX_RECORD = 64 * 1024 * 1024;

// Yields { message } per NDJSON record, or { error } for a record that is not JSON or exceeds the size limit.
// Splits on LF only: U+2028/U+2029 are valid inside JSON strings.
export async function* records(stream) {
  stream.setEncoding('utf8');
  let buffer = '';
  let skipping = false;
  for await (const chunk of stream) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (skipping) skipping = false;
      else if (line.length > MAX_RECORD) yield { error: 'Record exceeds 64 MiB' };
      else if (line) yield parse(line);
    }
    if (buffer.length > MAX_RECORD) {
      if (!skipping) yield { error: 'Record exceeds 64 MiB' };
      skipping = true;
      buffer = '';
    }
  }
  if (buffer.trim() && !skipping) yield parse(buffer.trim());
}

function parse(line) {
  try {
    const message = JSON.parse(line);
    return message && typeof message === 'object' && !Array.isArray(message) ? { message } : { error: 'Record is not a JSON object' };
  } catch {
    return { error: 'Record is not valid JSON' };
  }
}

// Serializes writes and honours backpressure; a failed stream rejects every later write.
export function writer(stream) {
  let tail = Promise.resolve();
  return message => (tail = tail.then(async () => {
    if (stream.destroyed || stream.writableEnded) throw new Error('stream closed');
    if (stream.write(JSON.stringify(message) + '\n')) return;
    await new Promise((resolve, reject) => {
      const settle = drained => () => {
        stream.off('drain', onDrain);
        stream.off('close', onClose);
        drained ? resolve() : reject(new Error('stream closed'));
      };
      const onDrain = settle(true), onClose = settle(false);
      stream.on('drain', onDrain);
      stream.on('close', onClose);
    });
  }));
}

// A wrapper failure with the stage that failed, a stable code and the user's next step.
export class StageError extends Error {
  constructor(stage, code, message, { recovery, cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    Object.assign(this, { stage, code, recovery, detail });
  }

  text() {
    return [`${this.message} [${this.stage}/${this.code}]`, this.detail, this.cause?.message && `Cause: ${this.cause.message}`,
      this.recovery].filter(Boolean).join('\n');
  }

  rpcError() {
    return { code: -32603, message: this.text(), data: { stage: this.stage, code: this.code, recovery: this.recovery } };
  }

  toolResult() {
    return { isError: true, content: [{ type: 'text', text: this.text() }] };
  }
}
