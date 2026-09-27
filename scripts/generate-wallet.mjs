#!/usr/bin/env node
// Generate a fresh spending wallet for the Vangrid MCP server.
//   node scripts/generate-wallet.mjs
// Prints one key and its address to stdout, nothing to a file. Copy the key into your
// .env or your MCP host config; the address is where you send USDC.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const key = generatePrivateKey();
const account = privateKeyToAccount(key);
process.stdout.write(`address:      ${account.address}\nprivate key:  ${key}\n\n`);
process.stdout.write('Fund this address with a few USDC on the network you set in X402_NETWORK\n');
process.stdout.write('(default eip155:8453 Base). Never share the private key.\n');
