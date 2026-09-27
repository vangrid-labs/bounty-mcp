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
from a wallet the operator funds. It calls one HTTP API over TLS. It does not open a listening
socket, does not run untrusted code and does not accept files from the network.

The main risk is the wallet spending more than the operator meant to: a bad quote from the
server, a compromised `data.vangrid.io`, or an agent that keeps calling paid tools. The main
countermeasure is the per-call and per-bounty caps enforced by the x402 client library before a
signature is produced. Independent of any server behaviour, the wallet cannot sign a payment
above `MAX_USD_PER_CALL` for data or `MAX_USD_PER_BOUNTY` for a bounty.

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
  read. The defaults ($0.05 per call, $500 per bounty) are convenient, not safe by construction.
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

The server does not talk to any other host.

## Supported versions

The `main` branch is the only supported version. Security fixes land there and are cut into a
new tag. Older tags are not patched.
