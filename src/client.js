// HTTP client for the Vangrid x402 API. Wraps fetch so a 402 answer is paid
// automatically with the agent's wallet, within the configured spend cap.

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, fallback, formatUnits } from 'viem';

const ARC_USDC = {
  'eip155:5042': '0x3600000000000000000000000000000000000000',
  'eip155:5042002': '0x3600000000000000000000000000000000000000',
};

// Networks the server can pay on, with the USDC contract and public RPCs used to read the
// wallet balance. RPCs are overridable per network (BASE_RPC_URL, ARC_RPC_URL).
// Reading a balance discloses the wallet address to whichever RPC answers; see SECURITY.md.
export const NETWORKS = {
  'eip155:8453': {
    name: 'Base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    rpcEnv: 'BASE_RPC_URL',
    rpcs: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'],
  },
  'eip155:5042': {
    name: 'Arc',
    usdc: '0x3600000000000000000000000000000000000000',
    rpcEnv: 'ARC_RPC_URL',
    rpcs: ['https://rpc.mainnet.arc.io'],
  },
  'eip155:84532': {
    name: 'Base Sepolia',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    rpcEnv: 'BASE_SEPOLIA_RPC_URL',
    rpcs: ['https://sepolia.base.org'],
  },
};
// Mainnets only: "auto" never selects a testnet, and never reads a balance on one.
const AUTO_ORDER = ['eip155:8453', 'eip155:5042'];
const BALANCE_ABI = [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const BALANCE_TTL_MS = 60_000;

export function loadClientConfig(env = process.env) {
  const apiUrl = (env.VANGRID_API_URL || 'https://data.vangrid.io').replace(/\/+$/, '');
  // "auto" (default): pay on whichever of Base and Arc holds the most USDC for this wallet.
  const network = (env.X402_NETWORK || 'auto').trim();
  if (network !== 'auto' && !NETWORKS[network] && !ARC_USDC[network]) {
    const known = [...new Set([...Object.keys(NETWORKS), ...Object.keys(ARC_USDC)])].join(', ');
    throw new Error(`X402_NETWORK must be auto or one of ${known}; got ${network}`);
  }
  const maxUsd = env.MAX_USD_PER_CALL == null || env.MAX_USD_PER_CALL === '' ? 0.05 : Number(env.MAX_USD_PER_CALL);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('MAX_USD_PER_CALL must be a positive number');
  const maxUsdBounty = env.MAX_USD_PER_BOUNTY == null || env.MAX_USD_PER_BOUNTY === '' ? 100 : Number(env.MAX_USD_PER_BOUNTY);
  if (!Number.isFinite(maxUsdBounty) || maxUsdBounty <= 0) throw new Error('MAX_USD_PER_BOUNTY must be a positive number');
  const httpTimeoutMs = env.VANGRID_HTTP_TIMEOUT_MS == null || env.VANGRID_HTTP_TIMEOUT_MS === '' ? 30_000 : Number(env.VANGRID_HTTP_TIMEOUT_MS);
  if (!Number.isFinite(httpTimeoutMs) || httpTimeoutMs <= 0) throw new Error('VANGRID_HTTP_TIMEOUT_MS must be a positive number of milliseconds');
  const key = (env.EVM_PRIVATE_KEY || '').trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  const rpc = {};
  for (const [id, n] of Object.entries(NETWORKS)) {
    const custom = (env[n.rpcEnv] || '').trim();
    rpc[id] = custom ? [custom, ...n.rpcs] : n.rpcs;
  }
  return { apiUrl, network, maxUsd, maxUsdBounty, httpTimeoutMs, privateKey: key || null, rpc };
}

/**
 * Networks whose balance is worth reading for this config: in auto mode the two mainnets that
 * "auto" chooses between, otherwise only the one network that will be paid on. Keeping this
 * narrow limits how many third-party RPCs learn the wallet address.
 */
export function balanceNetworks(cfg) {
  if (cfg.network === 'auto') return AUTO_ORDER;
  return NETWORKS[cfg.network] ? [cfg.network] : [];
}

/**
 * USDC balance of `address` on every network the server can pay on, in USD, cached for a
 * minute. A network that cannot be read comes back as null, not 0: unknown is not empty.
 */
const balanceCache = new Map();
export async function usdcBalances(cfg, address) {
  const ids = balanceNetworks(cfg);
  const cacheKey = `${address}|${ids.join(',')}`;
  const hit = balanceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.balances;
  const balances = {};
  await Promise.all(
    ids.map(async (id) => {
      const n = NETWORKS[id];
      try {
        const client = createPublicClient({ transport: fallback(cfg.rpc[id].map((u) => http(u, { timeout: 8_000 }))) });
        const raw = await client.readContract({ address: n.usdc, abi: BALANCE_ABI, functionName: 'balanceOf', args: [address] });
        balances[id] = Number(formatUnits(raw, 6));
      } catch {
        balances[id] = null;
      }
    }),
  );
  balanceCache.set(cacheKey, { at: Date.now(), balances });
  return balances;
}

/** "Base 4.2 USDC, Arc 0 USDC" for messages; unreadable networks say so. */
export function describeBalances(balances) {
  const ids = Object.keys(balances || {});
  if (!ids.length) return 'not read';
  return ids.map((id) => `${NETWORKS[id]?.name || id} ${balances[id] == null ? 'unreadable' : `${balances[id]} USDC`}`).join(', ');
}

/** Network to pay on for this call: the configured one, or in auto mode the richest one. */
export async function pickNetwork(cfg, address) {
  if (cfg.network !== 'auto') return { network: cfg.network, balances: null };
  const balances = await usdcBalances(cfg, address);
  let best = null;
  for (const id of AUTO_ORDER) {
    const b = balances[id];
    if (b != null && b > 0 && (best == null || b > balances[best])) best = id;
  }
  return { network: best, balances };
}

/** A fetch that pays on exactly one network, within the per-payment cap. */
function payingFetch(account, network, maxUsd, baseFetch) {
  const capUnits = String(Math.round(maxUsd * 1_000_000));
  return wrapFetchWithPaymentFromConfig(baseFetch, {
    schemes: [{ network, client: new ExactEvmScheme(account) }],
    // Only pay on this network; the API offers several (Base, Arc).
    policies: [(_v, reqs) => reqs.filter((r) => r.network === network)],
    spendControls: {
      maxAmountPerPayment: `$${maxUsd}`,
      // USDC on Arc is the chain's native token behind a predeploy; the x402 SDK does not
      // list it as a default asset, so it has to be allowed by hand with the same cap.
      allowedAssets: ARC_USDC[network] ? [{ network, asset: ARC_USDC[network], maxAmountPerPayment: capUnits }] : [],
    },
  });
}

/**
 * @returns {{ fetch: typeof fetch, fetchFor: (network: string) => typeof fetch, address: string|null, paid: boolean }}
 */
export function buildFetch(cfg, baseFetch = globalThis.fetch) {
  if (!cfg.privateKey) {
    // Read-only mode: free routes work, paid routes surface the 402 as an error.
    return { fetch: baseFetch, fetchFor: () => baseFetch, address: null, paid: false };
  }
  const account = privateKeyToAccount(cfg.privateKey);
  const perNetwork = new Map();
  const fetchFor = (network) => {
    if (!perNetwork.has(network)) perNetwork.set(network, payingFetch(account, network, cfg.maxUsd, baseFetch));
    return perNetwork.get(network);
  };
  return { fetch: baseFetch, fetchFor, address: account.address, paid: true };
}

function decodeRequired(res) {
  const h = res.headers.get('payment-required');
  if (!h) return null;
  try {
    return JSON.parse(Buffer.from(h, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Call the API; returns { ok, status, body, payment } with a readable message on 402. */
export async function callApi(client, cfg, path, init = {}) {
  try {
    return await attemptCall(client, cfg, path, init);
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: { error: timedOut ? 'api_timeout' : 'api_unreachable' },
      payment: null,
      message: timedOut
        ? `Vangrid API did not answer within ${cfg.httpTimeoutMs ?? 30_000} ms (${cfg.apiUrl}${path}). Raise VANGRID_HTTP_TIMEOUT_MS or retry.`
        : `Could not reach the Vangrid API at ${cfg.apiUrl}${path}: ${err?.message || err}`,
    };
  }
}

async function attemptCall(client, cfg, path, init) {
  const url = `${cfg.apiUrl}${path}`;
  // Without this the API call has no deadline and a hung server stalls the tool forever.
  // The budget covers the whole x402 exchange: the 402, the signature and the retry.
  const req = {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(cfg.httpTimeoutMs ?? 30_000),
    headers: { accept: 'application/json', ...(init.headers || {}) },
  };
  let chosen = null;
  let doFetch = client.fetch;
  if (client.paid) {
    chosen = await pickNetwork(cfg, client.address);
    if (!chosen.network) {
      // Auto mode and no USDC on any network: sign nothing, say exactly what is missing.
      const probe = await client.fetch(url, req);
      if (probe.status !== 402) return finish(probe, null, client, cfg);
      const offer = decodeRequired(probe)?.accepts?.[0];
      const usd = offer?.amount ? Number(offer.amount) / 1e6 : null;
      return {
        ok: false,
        status: 402,
        body: null,
        payment: null,
        message: `Payment required${usd != null ? ` (${usd} USDC per call)` : ''}: wallet ${client.address} has no USDC to pay with (${describeBalances(chosen.balances)}). Send USDC on Base or Arc to that address.`,
      };
    }
    doFetch = client.fetchFor(chosen.network);
  }
  return finish(await doFetch(url, req), chosen, client, cfg);
}

async function finish(res, chosen, client, cfg) {
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  let payment = null;
  const pr = res.headers.get('payment-response');
  if (pr) {
    try {
      payment = decodePaymentResponseHeader(pr);
    } catch {
      payment = { raw: pr };
    }
  }
  if (res.status === 402) {
    const req = decodeRequired(res);
    const offer = req?.accepts?.[0];
    const usd = offer?.amount ? Number(offer.amount) / 1e6 : null;
    // The server's own reason (e.g. facilitator_http_403) is the actual cause. Report it
    // verbatim first; guessing from the balance alone sends people to top up a funded wallet.
    const reported = body?.error || req?.error || body?.message || null;
    let why = 'no EVM_PRIVATE_KEY configured, so the server could not be paid';
    if (client.paid) {
      const balances = chosen?.balances || (await usdcBalances(cfg, client.address));
      const net = NETWORKS[chosen?.network]?.name || chosen?.network;
      why = `payment on ${net} from ${client.address} was not accepted; wallet balance: ${describeBalances(balances)}`;
      if (cfg.network !== 'auto') why += `. X402_NETWORK is fixed to ${cfg.network}: set it to auto, or to the network that holds the USDC`;
    }
    return {
      ok: false,
      status: 402,
      body,
      payment: null,
      message: `Payment required${usd != null ? ` (${usd} USDC per call)` : ''}: ${reported ? `server reported ${reported}; ` : ''}${why}.`,
    };
  }
  return { ok: res.ok, status: res.status, body, payment };
}
