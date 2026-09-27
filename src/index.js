#!/usr/bin/env node
// Vangrid MCP server (stdio). Seven tools over the x402 API on data.vangrid.io:
// three for anchored capture data, four for commissioning captures through bounties.
// Paid tools settle in USDC on Base or Arc from the wallet in EVM_PRIVATE_KEY (network picked
// by balance unless X402_NETWORK fixes it). Data calls are
// capped by MAX_USD_PER_CALL, bounties by MAX_USD_PER_BOUNTY. Without a key the free
// tools still work and paid ones explain what is missing.

import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadClientConfig, buildFetch, callApi, usdcBalances, describeBalances } from './client.js';
import { rememberToken, tokenFor, listRemembered } from './store.js';

const cfg = loadClientConfig();
const client = buildFetch(cfg);
const bountyClient = buildFetch({ ...cfg, maxUsd: cfg.maxUsdBounty });

function result(r, extra = {}) {
  const payload = r.ok ? { ...r.body, ...extra } : { error: r.body?.error || `http_${r.status}`, message: r.message || r.body?.message || '' };
  if (r.payment) payload.payment = { network: r.payment.network, transaction: r.payment.transaction };
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: !r.ok };
}

const server = new McpServer({ name: 'vangrid', version: '0.2.0' });

// ---------------------------------------------------------------- data ---------

server.registerTool(
  'vangrid_coverage_query',
  {
    title: 'Vangrid coverage query',
    description:
      'Find anchored ground-level captures inside an area and time window. Each observation carries a coarse location (geohash precision 6), capture time and the EAS attestation on Base that anchors it. ' +
      'Paid per call in USDC on Base (eip155:8453) or Arc mainnet (eip155:5042), about $0.01. Area: GeoJSON Point with radius_m (max 5000) or a Polygon whose bounding box is at most 100 km².',
    inputSchema: {
      aoi: z.object({ type: z.enum(['Point', 'Polygon']), coordinates: z.any() }).describe('GeoJSON geometry: Point [lng, lat] or Polygon [[[lng, lat], ...]]'),
      radius_m: z.number().min(1).max(5000).optional().describe('Point only: radius in metres, default 500'),
      from: z.string().optional().describe('ISO-8601 start, default 7 days before "to"'),
      to: z.string().optional().describe('ISO-8601 end, default now'),
      limit: z.number().int().min(1).max(1000).optional().describe('default 100'),
    },
  },
  async (args) =>
    result(await callApi(client, cfg, '/api/v1/spatial/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) })),
);

server.registerTool(
  'vangrid_observation',
  {
    title: 'Vangrid observation',
    description: 'Fetch one anchored capture by its sha256 (with or without 0x): coarse location, capture time and EAS attestation on Base. Paid per call in USDC on Base (eip155:8453) or Arc mainnet (eip155:5042), about $0.005.',
    inputSchema: { id: z.string().describe('sha256 hex of the capture') },
  },
  async ({ id }) => result(await callApi(client, cfg, `/api/v1/observations/${encodeURIComponent(id)}`)),
);

server.registerTool(
  'vangrid_verify_provenance',
  {
    title: 'Vangrid provenance check',
    description: 'Free. Check whether a sha256 is a capture anchored by Vangrid on Base. Returns verified true/false and, when true, the capture time, coarse location and the attestation reference.',
    inputSchema: { hash: z.string().describe('sha256 hex of the capture') },
  },
  async ({ hash }) => result(await callApi(client, cfg, `/api/v1/provenance/${encodeURIComponent(hash)}`)),
);

// -------------------------------------------------------------- bounties -------

server.registerTool(
  'vangrid_post_bounty',
  {
    title: 'Commission a capture (post a bounty)',
    description:
      'Commission a ground-level 3D capture of a real place. You pay the bounty amount in USDC on Base or Arc mainnet right away; Vangrid posts it to its bounty board, a contributor films it, and you review submissions with vangrid_bounty_status and accept one with vangrid_accept_submission to receive the reconstruction. ' +
      'If nothing is accepted by the deadline, or you cancel while open, the USDC comes back to your wallet. Amount is whole USDC between the limits the server quotes (by default 50 to 5000). The bounty token is kept locally; later tools only need bounty_id.',
    inputSchema: {
      title: z.string().min(3).max(200).describe('Short name of the place or task'),
      brief: z.string().min(20).max(4000).describe('What to film, where exactly, what must be in frame, daylight or not'),
      amount_usdc: z.number().int().min(1).describe('Bounty amount in whole USDC; this is what you pay now'),
      deadline_days: z.number().int().min(1).max(30).optional().describe('Days until the bounty expires, default 7'),
    },
  },
  async (args) => {
    const r = await callApi(bountyClient, cfg, '/api/v1/bounties', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
    if (r.ok && r.body?.bounty_id && r.body?.agent_token) {
      rememberToken(r.body.bounty_id, r.body.agent_token);
      const { agent_token, ...rest } = r.body;
      return result({ ...r, body: rest }, { token_stored: true });
    }
    return result(r);
  },
);

const withBounty = (fn) => async ({ bounty_id, ...rest }) => {
  const token = tokenFor(bounty_id);
  if (!token) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_bounty', message: `No stored token for ${bounty_id}. Known: ${listRemembered().join(', ') || 'none'}` }) }], isError: true };
  }
  return fn(bounty_id, token, rest);
};

server.registerTool(
  'vangrid_bounty_status',
  {
    title: 'Bounty status and submissions',
    description:
      'Free. Status of a bounty you posted (paid, open, accepting, accepted, cancelled, expired_refunded, failed), its on-chain id and board link, and the submissions received: each with a short preview video URL (valid 15 minutes) and quality status. After accept, links to the full capture and the 3D model appear on the accepted submission.',
    inputSchema: { bounty_id: z.string() },
  },
  withBounty(async (id, token) => result(await callApi(client, cfg, `/api/v1/bounties/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } }))),
);

server.registerTool(
  'vangrid_accept_submission',
  {
    title: 'Accept a submission',
    description: 'Free. Accept one submission on an open bounty you posted. The escrow is released on chain, reconstruction starts, and the full capture and model become available in vangrid_bounty_status. Irreversible.',
    inputSchema: { bounty_id: z.string(), submission_id: z.string() },
  },
  withBounty(async (id, token, { submission_id }) =>
    result(await callApi(client, cfg, `/api/v1/bounties/${encodeURIComponent(id)}/accept`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ submission_id }) }))),
);

server.registerTool(
  'vangrid_cancel_bounty',
  {
    title: 'Cancel a bounty',
    description: 'Free. Cancel a bounty you posted while it is still open. The escrow is withdrawn on chain and the USDC is sent back to the wallet that paid.',
    inputSchema: { bounty_id: z.string() },
  },
  withBounty(async (id, token) =>
    result(await callApi(client, cfg, `/api/v1/bounties/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }))),
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[vangrid-mcp] ready api=${cfg.apiUrl} network=${cfg.network} wallet=${client.address || 'none (free tools only)'} caps=$${cfg.maxUsd}/call $${cfg.maxUsdBounty}/bounty`,
);
if (client.address) {
  // One line with what the wallet can pay with, so a missing top-up shows up before the first call.
  usdcBalances(cfg, client.address)
    .then((b) => console.error(`[vangrid-mcp] wallet USDC: ${describeBalances(b)}`))
    .catch(() => {});
}
