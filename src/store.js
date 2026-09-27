// Bounty tokens the agent received from vangrid_post_bounty, kept on disk so later
// calls only need the bounty id. One JSON file, owner-only permissions.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = process.env.VANGRID_MCP_STORE || path.join(os.homedir(), '.vangrid-mcp', 'bounties.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

function save(obj) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

export function rememberToken(bountyId, token) {
  const all = load();
  all[bountyId] = { token, savedAt: new Date().toISOString() };
  save(all);
}

export function tokenFor(bountyId) {
  return load()[bountyId]?.token || null;
}

export function listRemembered() {
  return Object.keys(load());
}
