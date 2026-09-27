// HTTP client for the Vangrid x402 API. Wraps fetch so a 402 answer is paid
// automatically with the agent's wallet, within the configured spend cap.

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';

const ARC_USDC = {
  'eip155:5042': '0x3600000000000000000000000000000000000000',
  'eip155:5042002': '0x3600000000000000000000000000000000000000',
};

export function loadClientConfig(env = process.env) {
  const apiUrl = (env.VANGRID_API_URL || 'https://data.vangrid.io').replace(/\/+$/, '');
  const network = (env.X402_NETWORK || 'eip155:8453').trim();
  const maxUsd = env.MAX_USD_PER_CALL == null || env.MAX_USD_PER_CALL === '' ? 0.05 : Number(env.MAX_USD_PER_CALL);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error('MAX_USD_PER_CALL must be a positive number');
  const maxUsdBounty = env.MAX_USD_PER_BOUNTY == null || env.MAX_USD_PER_BOUNTY === '' ? 500 : Number(env.MAX_USD_PER_BOUNTY);
  if (!Number.isFinite(maxUsdBounty) || maxUsdBounty <= 0) throw new Error('MAX_USD_PER_BOUNTY must be a positive number');
  const key = (env.EVM_PRIVATE_KEY || '').trim();
  if (key && !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('EVM_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  return { apiUrl, network, maxUsd, maxUsdBounty, privateKey: key || null };
}

/**
 * @returns {{ fetch: typeof fetch, address: string|null, paid: boolean }}
 */
export function buildFetch(cfg, baseFetch = globalThis.fetch) {
  if (!cfg.privateKey) {
    // Read-only mode: free routes work, paid routes surface the 402 as an error.
    return { fetch: baseFetch, address: null, paid: false };
  }
  const account = privateKeyToAccount(cfg.privateKey);
  const capUnits = String(Math.round(cfg.maxUsd * 1_000_000));
  const paidFetch = wrapFetchWithPaymentFromConfig(baseFetch, {
    schemes: [{ network: cfg.network, client: new ExactEvmScheme(account) }],
    // Only pay on the configured network; the API may offer several (Base, Arc).
    policies: [(_v, reqs) => reqs.filter((r) => r.network === cfg.network)],
    spendControls: {
      maxAmountPerPayment: `$${cfg.maxUsd}`,
      // USDC on Arc is the chain's native token behind a predeploy; the x402 SDK does not
      // list it as a default asset, so it has to be allowed by hand with the same cap.
      allowedAssets: ARC_USDC[cfg.network] ? [{ network: cfg.network, asset: ARC_USDC[cfg.network], maxAmountPerPayment: capUnits }] : [],
    },
  });
  return { fetch: paidFetch, address: account.address, paid: true };
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
  const url = `${cfg.apiUrl}${path}`;
  const res = await client.fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers || {}) } });
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
    const why = client.paid
      ? 'payment was attempted but not accepted (check wallet USDC balance on ' + cfg.network + ')'
      : 'no EVM_PRIVATE_KEY configured, so the server could not be paid';
    return {
      ok: false,
      status: 402,
      body,
      payment: null,
      message: `Payment required${usd != null ? ` (${usd} USDC per call)` : ''}: ${why}.`,
    };
  }
  return { ok: res.ok, status: res.status, body, payment };
}
