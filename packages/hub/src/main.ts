// Entry point: `npm run hub -- [--port 8080] [--data dir] [--inbox dir]`

import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HUB_PORT } from '@gcc/shared';
import { parseArgs } from '@gcc/shared/node';
import { Hub } from './hub.ts';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`GCode Controller hub: file library and sync server for the design Mac.

  --port <n>        port (default ${DEFAULT_HUB_PORT})
  --data <dir>      library directory (default ~/Library/Application Support/GCodeController/hub)
  --inbox <dir>     watched folder (default ~/GCode Inbox)
  --no-inbox        don't watch a folder
  --no-bonjour      don't advertise on the local network
  --name <text>     name shown in the UI`);
  process.exit(0);
}

const hub = new Hub({
  port: Number(args.port ?? DEFAULT_HUB_PORT),
  dataDir: String(args.data ?? join(homedir(), 'Library/Application Support/GCodeController/hub')),
  inboxDir: args['no-inbox'] ? undefined : String(args.inbox ?? join(homedir(), 'GCode Inbox')),
  advertise: !args['no-bonjour'],
  name: typeof args.name === 'string' ? args.name : undefined,
});

const port = await hub.start();
const lan = Object.values(networkInterfaces())
  .flat()
  .filter((i) => i && i.family === 'IPv4' && !i.internal)
  .map((i) => `http://${i!.address}:${port}`);

console.log(`GCode Controller hub "${hub.name}"`);
console.log(`  UI:      http://localhost:${port}`);
for (const u of lan) console.log(`           ${u}`);
console.log(`  Upload:  curl -X POST --data-binary @part.nc -H 'X-Filename: part.nc' http://localhost:${port}/api/jobs`);
if (hub.opts.inboxDir) console.log(`  Inbox:   ${hub.opts.inboxDir}`);

const shutdown = async () => {
  await hub.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
