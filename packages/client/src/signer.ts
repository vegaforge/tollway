/**
 * Agent signer abstraction (#205).
 *
 * Agents configure their payment identity once as an `AgentSigner`, and every
 * settler consumes it. Two implementations are provided:
 * - `createKeypairSigner`: classic `G...` Ed25519 keypair, usable across x402
 *   and MPP (charge and channel).
 * - `createSmartAccountSigner`: OpenZeppelin smart-account `C...` contract
 *   address with external `signAuthEntry` (and optional `signTransaction`)
 *   callbacks, usable for x402 where `@x402/stellar`'s `ClientStellarSigner`
 *   supports contract accounts.
 *
 * `@stellar/mpp` only accepts an Ed25519 `Keypair` today, so smart-account
 * signers are explicitly rejected by MPP settlers instead of failing silently
 * or pretending every signer works everywhere.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { type ClientStellarSigner, createEd25519Signer } from "@x402/stellar";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/** Classic Ed25519 keypair signer (`G...`). Works for both x402 and MPP. */
export type KeypairAgentSigner = {
  readonly kind: "keypair";
  readonly address: string;
  readonly network: StellarNetwork;
  readonly keypair: Keypair;
  readonly x402: ClientStellarSigner;
};

/**
 * Contract (`C...`) smart-account signer for OpenZeppelin smart accounts.
 * Supports x402 via `@x402/stellar`'s `ClientStellarSigner`; not supported by
 * `@stellar/mpp` today.
 */
export type SmartAccountAgentSigner = {
  readonly kind: "smart-account";
  readonly address: string;
  readonly network: StellarNetwork;
  readonly x402: ClientStellarSigner;
};

/** Unified agent identity consumed by Tollway settlers. */
export type AgentSigner = KeypairAgentSigner | SmartAccountAgentSigner;

export type KeypairSignerOptions =
  | {
      /** Stellar secret key (`S...`). Provide this or `keypair`, not both. */
      secretKey: string;
      keypair?: undefined;
      network: StellarNetwork;
    }
  | {
      /** Stellar `Keypair`. Provide this or `secretKey`, not both. */
      keypair: Keypair;
      secretKey?: undefined;
      network: StellarNetwork;
    };

export type SmartAccountSignerOptions = {
  /** Soroban contract account address (`C...`). */
  address: string;
  network: StellarNetwork;
  /** Signs a Soroban authorization entry for this smart account. */
  signAuthEntry: ClientStellarSigner["signAuthEntry"];
  /** Optional transaction signer when the smart-account flow needs it. */
  signTransaction?: ClientStellarSigner["signTransaction"];
};

/** Creates a classic `G...` Ed25519 {@link KeypairAgentSigner}. */
export function createKeypairSigner(options: KeypairSignerOptions): KeypairAgentSigner {
  if ((options.secretKey === undefined) === (options.keypair === undefined)) {
    throw new TypeError("createKeypairSigner: provide exactly one of secretKey or keypair");
  }
  let keypair: Keypair;
  try {
    keypair = options.keypair ?? Keypair.fromSecret(options.secretKey as string);
  } catch (error) {
    throw new TollwayError(
      "payment-failed",
      `invalid Stellar secret key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const x402 = createEd25519Signer(keypair.secret(), CAIP2[options.network]);
  return {
    kind: "keypair",
    address: keypair.publicKey(),
    network: options.network,
    keypair,
    x402,
  };
}

/** Creates a `C...` OpenZeppelin {@link SmartAccountAgentSigner} for x402. */
export function createSmartAccountSigner(
  options: SmartAccountSignerOptions,
): SmartAccountAgentSigner {
  if (!CONTRACT_ADDRESS.test(options.address)) {
    throw new TollwayError(
      "payment-failed",
      `invalid smart-account contract address "${options.address}": expected a C... Stellar contract ID`,
    );
  }
  const x402: ClientStellarSigner = {
    address: options.address,
    signAuthEntry: options.signAuthEntry,
    ...(options.signTransaction !== undefined ? { signTransaction: options.signTransaction } : {}),
  };
  return {
    kind: "smart-account",
    address: options.address,
    network: options.network,
    x402,
  };
}

/** Type guard for {@link KeypairAgentSigner}. */
export function isKeypairSigner(signer: AgentSigner): signer is KeypairAgentSigner {
  return signer.kind === "keypair";
}

/**
 * Ensures `signer` is a {@link KeypairAgentSigner} for protocols (such as MPP)
 * that require an Ed25519 `Keypair`.
 */
export function assertKeypairSigner(signer: AgentSigner, protocol: string): KeypairAgentSigner {
  if (!isKeypairSigner(signer)) {
    throw new TollwayError(
      "payment-failed",
      `${protocol} requires a keypair signer; smart-account signers (${signer.address}) are only supported for x402`,
    );
  }
  return signer;
}
