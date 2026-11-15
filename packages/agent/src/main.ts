// Entry point: `npm run agent -- [--simulate] [--hub http://host:8080] [--port 8081]`

import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_AGENT_PORT } from '@gcc/shared';
import { describeCode, parseArgs, RESTART_EXIT_CODE } from '@gcc/shared/node';
import { Agent } from './agent.ts';
import { listPorts } from './transport.ts';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`GCode Controller agent: runs next to the machine and owns the USB port.

  --simulate            use the built-in GRBL simulator instead of USB
  --sim-speed <n>       simulator speed multiplier (default 1)
  --serial <path>       serial device (default: auto-detect, e.g. /dev/cu.wchusbserial*)
  --baud <n>            baud rate (default 115200)
  --hub <url>           hub address, e.g. http://studio.local:8080 (default: find it with Bonjour)
  --no-hub              run standalone
  --port <n>            port for the local UI (default ${DEFAULT_AGENT_PORT})
  --name <text>         name shown to other browsers
  --data <dir>          cache directory
  --list-ports          list serial ports and exit`);
  process.exit(0);
}

if (args['list-ports']) {
  for (const p of await listPorts()) {
    console.log(`${p.likelyGrbl ? '*' : ' '} ${p.path}  ${p.manufacturer ?? ''} ${p.vendorId ? `${p.vendorId}:${p.productId}` : ''}`);
  }
  process.exit(0);
}

const agent = new Agent({
  port: Number(args.port ?? DEFAULT_AGENT_PORT),
  dataDir: String(args.data ?? join(homedir(), 'Library/Application Support/GCodeController/agent')),
  hubUrl: typeof args.hub === 'string' ? args.hub : undefined,
  discover: !args['no-hub'] && typeof args.hub !== 'string',
  simulate: !!args.simulate,
  sim: { speed: Number(args['sim-speed'] ?? 1) },
  serialPath: typeof args.serial === 'string' ? args.serial : undefined,
  baudRate: args.baud ? Number(args.baud) : undefined,
  name: typeof args.name === 'string' ? args.name : undefined,
  onRestart: () => void restartAfterUpdate(),
});

let port: number;
try {
  port = await agent.start();
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${(e as { port?: number }).port ?? '8081'} is already in use. Is the agent already running (in another window or the app)?`);
  } else {
    console.error(`Could not start the agent: ${e.message}`);
  }
  process.exit(1);
}
console.log(`GCode Controller agent "${agent.name}"`);
console.log(`  UI:      http://localhost:${port}`);
console.log(`  Machine: ${args.simulate ? 'GRBL simulator' : 'USB (auto-detect)'}`);
console.log(`  Hub:     ${typeof args.hub === 'string' ? args.hub : args['no-hub'] ? 'none' : 'searching with Bonjour…'}`);
agent.hub.on('url', (u) => console.log(`  Found hub at ${u}`));
agent.controller.on('console', (lines) => {
  for (const l of lines) if (l.dir === 'info' || l.dir === 'error') console.log(`  [${l.dir}] ${l.text}`);
});

console.log(`  Code:    ${describeCode(agent.code)}`);

// After an update: exit with RESTART_EXIT_CODE. The Mac app and the double-click launchers
// start the new code; run by hand, it says how.
async function restartAfterUpdate(): Promise<void> {
  await agent.stop();
  if (!agent.code.supervised) console.log('\nUpdated. Start it again with: npm run agent\n');
  process.exit(RESTART_EXIT_CODE);
}

const shutdown = async () => {
  await agent.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Launched by the Mac app: exit when the app goes away, even if it was force-quit,
// so no orphaned server keeps the port (or the USB connection) open.
if (args['exit-with-parent']) {
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.stdin.resume();
}
