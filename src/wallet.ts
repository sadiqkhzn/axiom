// The paying fetch for Telegraph: an x402 client that signs exact test-USDC payments on the supported test networks with a burner key.
// The key comes from the environment only and is never logged, stored or returned.

import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount } from 'viem/accounts';
import { ETHEREUM_SEPOLIA, TelegraphError, TEST_NETWORKS, TEST_USDC, type PaymentGuard } from './telegraph.ts';

export function payingFetchFromKey(privateKey: string | undefined, guard: PaymentGuard): { fetch: typeof fetch; address: string } {
  if (!privateKey) throw new TelegraphError('NO_WALLET', 'EVM_PRIVATE_KEY is not set');
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new TelegraphError('BAD_WALLET_KEY', 'EVM_PRIVATE_KEY must be 0x followed by 64 hex characters');
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const client = new x402Client();
  for (const network of TEST_NETWORKS) client.register(network as `${string}:${string}`, new ExactEvmScheme(account));
  // x402 signs only for tokens it knows (Circle's USDC). Telegraph's test USDC on Ethereum Sepolia is its own
  // contract, so it is allowed by address; the PaymentGuard below still caps every amount.
  client.setSpendControls({ allowedAssets: [{ network: ETHEREUM_SEPOLIA, asset: TEST_USDC[ETHEREUM_SEPOLIA]! }] });
  client
    // Nothing is signed unless it matches the quote the TelegraphClient checked against its caps.
    // Authorising counts the payment against the caps before it is signed.
    .onBeforePaymentCreation(async ({ selectedRequirements: terms }) => {
      const reason = await guard.authorize(terms);
      return reason ? { abort: true as const, reason } : undefined;
    });
  return { fetch: wrapFetchWithPayment(fetch, client), address: account.address };
}
