#!/usr/bin/env node
import { Supervisor } from './supervisor.mjs';
import { log } from './rpc.mjs';

const supervisor = new Supervisor({ input: process.stdin, output: process.stdout });
const stop = () => supervisor.shutdown().finally(() => process.exit());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
process.stdout.on('error', stop);

// After stdin ends the process exits once the runtime is gone and stdout has drained.
supervisor.run().catch(error => {
  log(`Stopped: ${error.stack || error}`);
  process.exitCode = 1;
  stop();
});
