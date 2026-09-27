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
bounty. A malformed request is refused before a quote, so the wallet never signs for an error.

## Install

Node 20 or newer. From a checkout:

```bash
npm install
cp .env.example .env       # fill EVM_PRIVATE_KEY for the paid tools
```

Fund the wallet with a few USDC on Base (`X402_NETWORK=eip155:8453`) or Arc
(`X402_NETWORK=eip155:5042`). Gas is not needed on either: x402 uses a signed USDC transfer
authorization that the settlement service submits.

## Configure the MCP client

Claude Desktop (`claude_desktop_config.json`) or Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vangrid": {
      "command": "node",
      "args": ["/absolute/path/to/bounty-mcp/src/index.js"],
      "env": {
        "VANGRID_API_URL": "https://data.vangrid.io",
        "X402_NETWORK": "eip155:8453",
        "EVM_PRIVATE_KEY": "0x...",
        "MAX_USD_PER_CALL": "0.05",
        "MAX_USD_PER_BOUNTY": "500"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add vangrid -e EVM_PRIVATE_KEY=0x... -- node /absolute/path/to/bounty-mcp/src/index.js
```

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
- `X402_NETWORK` — CAIP-2 network to pay on: `eip155:8453` Base or `eip155:5042` Arc.
- `EVM_PRIVATE_KEY` — spending wallet. Empty starts the server in read-only mode: the free
  tool works and paid tools return a clear "payment required" message.
- `MAX_USD_PER_CALL` / `MAX_USD_PER_BOUNTY` — hard caps per request.
- `VANGRID_MCP_STORE` — override the bounty token file (default `~/.vangrid-mcp/bounties.json`).

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

MIT.
