# Solana settlement with Pay.sh

The agent pays for specialist calls per request. Today that runs in test USDC on Ethereum Sepolia over the x402
protocol. For Solana, settlement uses Pay.sh, the Solana agentic payment gateway launched in 2026. Pay.sh gates an
API behind an HTTP 402 response and settles each call in Solana USDC using the MPP charge protocol.

This repo reads the real Pay.sh contract in code. `src/paysh.ts` fetches a Pay.sh gated URL, reads the 402 charge
challenge, and parses out the network, the USDC mint, the amount, the recipient, the fee payer and the token
program. The signed settlement itself runs through the official `pay` command line tool, because its wallet setup
is bound to the device and should not be reimplemented.

## Versions, current as of 2026-11-23

- The `pay` tool: install with `brew install pay` on macOS, or build from source from the Solana Foundation pay
  repository. Note that the npm package named `@solana/pay` at version 1.0.26 is the older Solana Pay URL scheme
  library, which is a different thing.
- If a custom signer is built later: `@solana/web3.js` 3.2.1 or `@solana/kit` 8.6.0, and `@solana/spl-token` 0.4.15.

## Read the Pay.sh contract this code consumes, no wallet needed

```bash
node src/paysh.ts
node src/paysh.ts https://debugger.pay.sh/mpp/quote/AAPL
```

The output is the parsed charge spec: the network, the USDC mint, the amount, the recipient, the fee payer, the
token program, and the base64 charge request. This confirms the code correctly reads what Pay.sh asks a payer to
sign.

## A live settlement on the sandbox, no real money

```bash
brew install pay
pay --sandbox fetch https://debugger.pay.sh/mpp/quote/AAPL
```

In sandbox mode `pay fetch` generates a localnet wallet on first use, funds it from the sandbox validator, pays the
MPP charge and returns the paid response. A plain `curl https://debugger.pay.sh/mpp/quote/AAPL` returns a 402; the
`pay --sandbox` call handles the payment and returns the protected content, which is the proof that settlement
completed.

Verified live on 2026-11-24. The generated localnet wallet was
`CiN97jWN741oxc7x18PNjdjpb9F4huDcnAUmdq1hZb9M`, and the paid call returned the gated content:

```json
{"symbol":"AAPL","price":"44.41","currency":"USD","source":"mpp-demo"}
```

The sandbox validator at `402.surfnet.dev` is an ephemeral test network: the wallet is funded on first use and the
balance does not persist, so a later run may report the wallet empty until the sandbox refunds it. The point the run
establishes is that the full flow works end to end on Solana: a 402 charge, a localnet USDC payment, and the
protected resource returned.

## The MPP charge contract, for reference

The proof is returned in an `Authorization: Payment` header carrying a base64url encoded, RFC 8785 canonical JSON
token:

```jsonc
{
  "challenge": { "id": "...", "realm": "...", "method": "solana", "intent": "charge", "request": "<echoed base64url>" },
  "payload":   { "type": "transaction", "transaction": "<base64 serialized signed versioned tx>" },
  "source":    "<payer base58 pubkey, optional>"
}
```

For USDC, the client builds one transferChecked instruction, plus an idempotent associated token account creation
if needed, from the payer account to the recipient account, with the amount in base units and the decimals from
the charge details. When the fee payer flag is set, the client marks the server account as the transaction fee
payer and signs only as the transfer authority. The server co-signs the fee payer slot and broadcasts, so the
server pays gas and the client pays only the token amount. A successful call returns a Payment-Receipt header.

## Status

- Ethereum Sepolia settlement over x402 works today in `src/direct.ts`.
- The Pay.sh Solana contract is read in code and verified against the live sandbox. The signed settlement runs
  through the official `pay` tool with a configured wallet. A custom in-repo Solana signer is a documented next
  step and is not claimed as working.
