# Security policy

## Reporting a vulnerability

Email [security@vangrid.io](mailto:security@vangrid.io). Please include steps to reproduce and,
if you have one, a proof of concept; do not open a public issue for a suspected vulnerability.
We reply within two working days and coordinate a fix and disclosure timeline with you.

## Scope

- This repository: the MCP server code, its dependencies as pinned in `package-lock.json`, and
  the way it reads configuration from the environment.
- Interaction with `data.vangrid.io` and the x402 facilitator, insofar as the server drives it.

Out of scope: bugs in the Vangrid API itself (report through the same address, but treat as a
service issue), and third-party MCP hosts.

## Threat model, in one page

The server runs on the agent's machine as a stdio process, started by an MCP host that already
has full access to that machine. It holds one long-lived secret, `EVM_PRIVATE_KEY`, and spends
from a wallet the operator funds. It calls the Vangrid API, an x402 facilitator and a public
Ethereum RPC over TLS (see "What runs on the wire"). It does not open a listening socket, does
not run untrusted code and does not accept files from the network.

The first risk is the wallet spending more than the operator meant to: a bad quote from the
server, a compromised `data.vangrid.io`, or an agent that keeps calling paid tools. The main
countermeasure is the per-call and per-bounty caps enforced by the x402 client library before a
signature is produced. Independent of any server behaviour, the wallet cannot sign a payment
above `MAX_USD_PER_CALL` for data or `MAX_USD_PER_BOUNTY` for a bounty.

The second risk is larger, and the caps do not touch it. `vangrid_accept_submission` costs
nothing, signs nothing and is irreversible: it releases the whole escrow of a bounty that was
already paid for. A spend cap only constrains signing a payment, so it does not apply. An agent
that has been prompt-injected — through a bounty brief, a submission title, a web page it read
earlier, anything in its context — can accept a worthless submission and burn the full bounty
without the wallet ever producing a signature. `vangrid_cancel_bounty` is the same shape: free,
irreversible, and it ends a bounty that may be about to receive good work.

There is no in-process defence against this, because the server cannot tell an instructed call
from an injected one. The mitigations are outside it:

- Require human approval for `vangrid_accept_submission` and `vangrid_cancel_bounty` in the MCP
  host. Most hosts can allow-list tools individually; these two are the ones to withhold.
- Size bounties so that losing one to a bad accept is tolerable. `MAX_USD_PER_BOUNTY` caps what
  a single bounty can cost, which is also the most an injected accept can waste.
- Review submission previews yourself before accepting. The preview URL from
  `vangrid_bounty_status` is the only evidence that the work is real.

## What the server does with secrets

- `EVM_PRIVATE_KEY` is read once from the environment. It is used only to sign x402 payment
  payloads for `data.vangrid.io`; it is never sent over the network, written to disk or logged.
- `agent_token` values returned by `vangrid_post_bounty` are stored in
  `~/.vangrid-mcp/bounties.json`. The parent directory and file are created with owner-only
  permissions (`0700` and `0600`); the location is overridable with `VANGRID_MCP_STORE`.
- No other credentials are collected.

## What we ask of operators

- Use a dedicated spending wallet. Do not point `EVM_PRIVATE_KEY` at a wallet with anything you
  are not ready to spend.
- Set `MAX_USD_PER_CALL` and `MAX_USD_PER_BOUNTY` to real ceilings, not to defaults you have not
  read. The defaults ($0.05 per call, $100 per bounty) are convenient, not safe by construction.
- Withhold `vangrid_accept_submission` and `vangrid_cancel_bounty` from unattended agents, or
  gate them behind human approval in the MCP host. See the threat model above for why the spend
  caps do not cover them.
- Keep the process out of shared shells: environment variables leak through `ps -eE` and
  `/proc/*/environ` on some hosts.
- Update the dependencies regularly; see below.

## Supply chain

Dependencies are pinned by `package-lock.json`. The runtime set is intentionally small:

- `@modelcontextprotocol/sdk` — stdio MCP transport and tool registration.
- `@x402/fetch`, `@x402/evm`, `viem` — x402 client and EVM signing.
- `zod` — input validation for the tools.
- `dotenv` — reading `.env` in local runs.

Run `npm audit` before each release and after a lockfile change; a known critical vulnerability
in the runtime set blocks a release.

## What runs on the wire

- HTTPS to `data.vangrid.io` (unless `VANGRID_API_URL` is set to something else). TLS is not
  disabled anywhere in the code.
- HTTPS to whichever facilitator the server chooses to settle on; the URL is inside the 402
  offer returned by `data.vangrid.io`.
- HTTPS to a public Ethereum RPC, to read the wallet's USDC balance. This is a third party and
  it is worth being precise about, because the balance read discloses the wallet address:

  | Network | Default RPCs | Override |
  | --- | --- | --- |
  | Base | `mainnet.base.org`, `base-rpc.publicnode.com`, `base.llamarpc.com` | `BASE_RPC_URL` |
  | Arc | `rpc.mainnet.arc.io` | `ARC_RPC_URL` |
  | Base Sepolia | `sepolia.base.org` | `BASE_SEPOLIA_RPC_URL` |

  The RPCs are tried in order until one answers, so in the normal case only the first is
  contacted. What is sent is an `eth_call` carrying the wallet address; the private key is not
  involved and no signature is produced. It happens once at startup, then at most once a minute
  (the balance is cached for 60s), and again when a payment fails.

  Two ways to avoid the third party: set the override variables above to an RPC you control, or
  set `X402_NETWORK` to a fixed network instead of `auto`. With a fixed network the server only
  reads the balance for that one network rather than for every candidate.

Beyond those three, the server does not talk to any other host.

## Supported versions

The `main` branch is the only supported version. Security fixes land there and are cut into a
new tag. Older tags are not patched.
