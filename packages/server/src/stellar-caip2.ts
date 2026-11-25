/**
 * The CAIP-2 network ids @x402/stellar speaks. They are written out here so
 * the gate's x402 path does not import @x402/stellar's package entry for
 * three strings: that entry also re-exports its signer and RPC helpers.
 * stellar-caip2.test.ts fails if they ever drift from upstream's.
 */
export const STELLAR_PUBNET_CAIP2 = "stellar:pubnet";
export const STELLAR_TESTNET_CAIP2 = "stellar:testnet";
export const STELLAR_WILDCARD_CAIP2 = "stellar:*";
