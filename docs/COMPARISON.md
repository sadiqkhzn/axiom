# Model on its own versus a ranked, verified specialist

The question these runs answer: what is the real difference between an agent that just uses a language model and
an agent that buys independently ranked, verified specialist intelligence. The measure is correctness, cost,
latency, and whether the answer is something you can actually act on.

Same task, two paths, same platform:

- Baseline: the agent answers from its own model with specialists turned off. Reproduce with
  `node src/route.mjs --baseline "<task>"`.
- Agent: the task is routed to the ranked specialist and paid per call. The answer carries a receipt that is
  checked against the network's public record. Reproduce with `node src/direct.ts "<task>"`.

## Results, run live on 2026-11-23

### 1. Counterparty sanctions check

Task: Is "Rosoboronexport" on the OFAC sanctions list?

| | Model on its own | Agent with the specialist |
| --- | --- | --- |
| Answer | "is listed, added around 2014 under EO 13662, consult OFAC for the exact date" | "Listed. Matches JSC ROSOBORONEXPORT on the EU consolidated list and the US OFAC list. Block the transaction." |
| Names a source | no | yes, the specific listed entity on named lists |
| Receipt you can verify | none | yes, checked against the node record |
| Cost and latency | none, 6.5s | 0.01 USD, 6.9s |
| Usable for a decision | no, unverifiable and hedged on the date | yes, cited and receipted |

A plausible, roughly correct answer is not enough to authorize or block a real transaction. The specialist gives a
cited result with a receipt.

### 2. Entity identity

Task: What is the exact LEI of Citigold Corporation Limited?

| | Model on its own | Agent with the specialist |
| --- | --- | --- |
| Answer | "I cannot provide the exact LEI without a lookup" | LEI 529900C4YHWJ2XJ8A350, jurisdiction AU, status ACTIVE, headquarters Fortitude Valley |
| Names a source | no, it declines | yes, the global entity register |
| Receipt you can verify | none | yes, checked against the node record |
| Cost and latency | none, 8.3s | 0.01 USD, about 4s |
| Usable for a decision | no | yes, an exact identifier that can be checked |

The model declines, which is the honest outcome and also the exact gap the specialist fills.

## Reproducing this

The baseline is a language model, so its exact wording changes from run to run. The point does not: with
specialists off it answers from memory with no source and no receipt, and with the specialist it returns a cited,
receipted answer. The quotes above are from the runs on 2026-11-23. Each specialist call is a fresh purchase, so a
re-run produces a new receipt hash for the same answer.

## What the two runs show

- One integration served both a sanctions check and an identity lookup. There is no code per domain. Adding a
  domain is one row in a map.
- Every specialist answer is a paid purchase with a receipt the network confirms. That is what makes the output
  usable for a decision that matters.
- The direct-by-id path keeps working while the ranked route is degraded.
- Each call costs about 0.01 USD.
