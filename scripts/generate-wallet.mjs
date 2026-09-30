#!/usr/bin/env node
// Generate a fresh spending wallet for the Vangrid MCP server.
//   node scripts/generate-wallet.mjs [outfile]
// The private key is written to a 0600 file, never to stdout: anything printed here would
// survive in shell scrollback, tmux buffers and the terminal's own logging. Only the address
// and the path are printed. Refuses to overwrite an existing file.

import fs from 'node:fs';
import path from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const outfile = path.resolve(process.argv[2] || '.vangrid-wallet');

const key = generatePrivateKey();
const account = privateKeyToAccount(key);

try {
  fs.writeFileSync(outfile, `EVM_PRIVATE_KEY=${key}\n`, { mode: 0o600, flag: 'wx' });
} catch (err) {
  if (err.code === 'EEXIST') {
    process.stderr.write(`refusing to overwrite ${outfile}\nPass a different path, or move the existing file away.\n`);
    process.exit(1);
  }
  throw err;
}

process.stdout.write(`address:  ${account.address}\n`);
process.stdout.write(`key file: ${outfile} (mode 0600)\n\n`);
process.stdout.write('Fund the address with a few USDC on the network you set in X402_NETWORK\n');
process.stdout.write('(default auto: Base or Arc). To load the key, append the file to your .env:\n');
process.stdout.write(`  cat ${JSON.stringify(outfile)} >> .env\n\n`);
process.stdout.write('Shred the file once the key is in your MCP host config. Never share it.\n');
