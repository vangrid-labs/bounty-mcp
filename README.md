# Vangrid MCP server

`bounty-mcp` is an MCP server that lets an agent buy anchored ground-level capture data from
Vangrid and commission new captures, paid per call in USDC. It is a thin, stateless client over
[data.vangrid.io](https://data.vangrid.io); the payment layer is [x402](https://x402.org) and the
agent pays from its own wallet. Docs: [docs.vangrid.io/api/pay-per-request](https://docs.vangrid.io/api/pay-per-request),
[docs.vangrid.io/api/agent-bounties](https://docs.vangrid.io/api/agent-bounties).

Install once, drop into any MCP client (Claude Desktop, Claude Code, Cursor), give it a wallet
with a few USDC on Base or Arc. No account, no API key.

## Tools

| Tool | Cost | Purpose |
| --- | --- | --- |
| `vangrid_verify_provenance` | free | is this sha256 an anchored Vangrid capture, and where |
| `vangrid_coverage_query` | ~$0.01 | captures inside an area of interest and time window |
| `vangrid_observation` | ~$0.005 | one capture by its sha256 |
| `vangrid_post_bounty` | the bounty amount | commission a capture; agent pays it upfront |
| `vangrid_bounty_status` | free | status, submissions with watermarked previews, model links after accept |
| `vangrid_accept_submission` | free | accept one submission; escrow released, reconstruction starts |
| `vangrid_cancel_bounty` | free | cancel while open; USDC returned to the paying wallet |

Prices are quoted by the server on every request as a `PAYMENT-REQUIRED` header and can move.
The client never signs a payment above `MAX_USD_PER_CALL` for data or `MAX_USD_PER_BOUNTY` for a
bounty.

On the two data routes the wallet signs an EIP-3009 authorization *before* the request is
validated, so a malformed request can produce a signature. Nothing is captured for one: x402
cancels settlement when the route answers 4xx. Bounty routes still validate before quoting.

Two tool calls are free but not harmless: `vangrid_accept_submission` releases the escrow and
`vangrid_cancel_bounty` ends the bounty, both irreversible and neither covered by the spend
caps, which only constrain signing. Gate them behind human approval for an unattended agent —
see [SECURITY.md](SECURITY.md).

## Setup

Three of the seven tools are paid — `vangrid_coverage_query`, `vangrid_observation` and
`vangrid_post_bounty`. They settle in USDC on Base or Arc from a wallet you point the server at.
This section walks through creating that wallet, funding it and confirming the server can talk
to the API.

Node 20 or newer. Nothing to install up front: the MCP host launches the server through `npx`
(see [Configure the MCP client](#configure-the-mcp-client)), which fetches `@vangrid/mcp` on
first run. Step 4 below is the check that it works.

To work from a checkout instead:

```bash
npm install
cp .env.example .env
```

### 1. Create a spending wallet

Use a **fresh, dedicated** wallet. Not your treasury; not the wallet a human uses. The private
key sits in a file the MCP host reads, and the agent will spend from it on its own.

Either use MetaMask (or any EVM wallet) and copy the private key out, or generate one from the
command line:

```bash
node scripts/generate-wallet.mjs
```

Prints the address and writes the private key to `.vangrid-wallet` with mode `0600` — it is
never printed, so it does not end up in shell scrollback or history. The file is git-ignored.
Append it to your `.env` (`cat .vangrid-wallet >> .env`), then delete it once the key is where
your MCP host reads it.

### 2. Configure `.env`

```
VANGRID_API_URL=https://data.vangrid.io
X402_NETWORK=auto                          # or eip155:8453 Base / eip155:5042 Arc
EVM_PRIVATE_KEY=0x<the key from step 1>
MAX_USD_PER_CALL=0.05                      # hard cap per data call
MAX_USD_PER_BOUNTY=100                     # hard cap per bounty
```

`.env` is git-ignored. Only this process reads it; the key is never sent over the network.

### 3. Fund the wallet

Send USDC to the address from step 1, on Base or on Arc. With `X402_NETWORK=auto` the server
reads the wallet's USDC balance on both and pays where the money is; the balances are printed
on start (`[vangrid-mcp] wallet USDC: Base 0 USDC, Arc 5 USDC`).

- Base: USDC at `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. Buy on a CEX and withdraw to
  Base, or bridge with [bridge.base.org](https://bridge.base.org). No ETH is needed: x402 uses
  a signed USDC transfer authorization and the settlement service submits it.
- Arc: USDC is the chain's native asset behind the ERC-20 predeploy
  `0x3600000000000000000000000000000000000000`. Bridge from Base with CCTP, or buy through a
  service that supports Arc. Gas on Arc is also USDC.

Start with $5 to try the flow, top up as the agent spends. `vangrid_verify_provenance` is
free, `vangrid_observation` is about $0.005, `vangrid_coverage_query` about $0.01. Bounties
cost the bounty amount, minimum $50.

### 4. Sanity check without spending

Run the server directly with the key blanked, to confirm it starts and reaches the API:

```bash
EVM_PRIVATE_KEY= npx @vangrid/mcp        # or, from a checkout: node src/index.js
```

You should see a single stderr line ending in `wallet=none (free tools only)`. Ctrl-C.

### 5. First real call

Add the server to your MCP host (next section). Ask the agent:

> Is `cf9642dae244a213bc9c0e6d325a84be44fe8fd1f57d9b362c64493769b74a48` a Vangrid capture?

That is `vangrid_verify_provenance`, free, and it confirms end-to-end connectivity. Then:

> Buy the observation for that sha256.

That is `vangrid_observation`, $0.005, and it confirms the wallet can pay. The reply carries
a `payment.transaction` hash you can open in the explorer for the chosen network.

## Configure the MCP client

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vangrid": {
      "command": "npx",
      "args": ["-y", "@vangrid/mcp"],
      "env": {
        "VANGRID_API_URL": "https://data.vangrid.io",
        "X402_NETWORK": "auto",
        "EVM_PRIVATE_KEY": "0x...",
        "MAX_USD_PER_CALL": "0.05",
        "MAX_USD_PER_BOUNTY": "100"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add vangrid -e EVM_PRIVATE_KEY=0x... -- npx -y @vangrid/mcp
```

From a checkout, point the host at the file instead: `node /absolute/path/to/bounty-mcp/src/index.js`.

## How the bounty flow works

`vangrid_post_bounty` signs the bounty amount and returns `{ bounty_id, agent_token }`. The
token is stored on disk at `~/.vangrid-mcp/bounties.json` with owner-only permissions, so the
other bounty tools only need the id. Vangrid posts the bounty to the board from its operator
wallet within a minute; a person films it (hours or days). Poll `vangrid_bounty_status`,
review the previews, then `vangrid_accept_submission`; the escrow is released on chain and the
reconstruction starts. Nothing worth accepting or a change of mind: `vangrid_cancel_bounty` or
let the deadline pass, USDC is refunded on the paying network.

## Environment

See `.env.example` for the full list. The essentials:

- `VANGRID_API_URL` — API base, defaults to `https://data.vangrid.io`.
- `X402_NETWORK` — `auto` (default): pay on whichever of Base and Arc holds the most USDC for the
  wallet. Or fix it: `eip155:8453` Base, `eip155:5042` Arc mainnet (`5042` is Arc mainnet, not a typo;
  `5042002` is Arc Testnet and is not accepted by data.vangrid.io).
- `EVM_PRIVATE_KEY` — spending wallet. Empty starts the server in read-only mode: the free
  tool works and paid tools return a clear "payment required" message.
- `MAX_USD_PER_CALL` / `MAX_USD_PER_BOUNTY` — hard caps per request. Defaults $0.05 and $100.
  They cap signing only; the free irreversible tools are not covered. See [SECURITY.md](SECURITY.md).
- `VANGRID_MCP_STORE` — override the bounty token file (default `~/.vangrid-mcp/bounties.json`).
- `VANGRID_HTTP_TIMEOUT_MS` — deadline for the whole API call including the x402 retry,
  default `30000`.
- `BASE_RPC_URL` / `ARC_RPC_URL` / `BASE_SEPOLIA_RPC_URL` — read the wallet balance through an
  RPC you control instead of the public defaults, which otherwise learn the wallet address.

## Read-only mode

Without a key the server still starts and `vangrid_verify_provenance` works. Every paid tool
answers with the price it would have charged and where to get USDC, so an agent can plan the
call before a wallet is attached.

## What the server does not do

- It does not upload, store or share the private key. The key is read from the environment on
  start and stays in the process.
- It does not talk to the outside network beyond the Vangrid API and the x402 facilitator that
  settles the payment on the chosen chain.
- It does not open a listening socket. Transport is stdio, one line on stderr on start.
- It does not persist anything besides the bounty token file above.

## Related

- API docs: [docs.vangrid.io/api](https://docs.vangrid.io/api/overview)
- x402 spec: [x402.org](https://x402.org)
- Circle Agent Marketplace listing (readiness check): [agents.circle.com](https://agents.circle.com)

## License

MIT — see [LICENSE](LICENSE).
