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

## Capture a live settlement receipt on the sandbox, no real money

```bash
brew install pay
pay --version
pay setup
pay whoami
pay --sandbox curl https://debugger.pay.sh/mpp/quote/AAPL
```

For contrast, a plain `curl https://debugger.pay.sh/mpp/quote/AAPL` returns a 402, while the `pay --sandbox` call
handles the payment and returns the paid response. Keep the paid response and the Payment-Receipt header as
evidence.

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
