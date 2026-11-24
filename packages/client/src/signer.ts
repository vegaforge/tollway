/**
 * The agent's payment identity (#205). An agent configures one `AgentSigner`
 * and hands it to every settler, instead of passing a raw secret to each.
 *
 * A signer declares what it can do per protocol, because the protocols do not
 * accept the same keys:
 *
 * - `x402`: signs Soroban authorization entries. This is `@x402/stellar`'s
 *   `ClientStellarSigner`, which works for classic (`G...`) and contract
 *   (`C...`) accounts, so a smart account or a remote key can provide it.
 * - `mppCharge` and `mppChannel`: hand over an Ed25519 `Keypair`, because
 *   `@stellar/mpp@0.7.1` accepts only `secretKey` or `keypair` for charge and
 *   `commitmentKey` or `commitmentSecret` for channel commitments. Only a key
 *   held in process can provide them.
 *
 * A settler asked to pay with a signer that lacks its capability throws a
 * `SignerCapabilityError` when it is created, before any network call.
 * `signerModels` tells the router which models a signer can pay.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { type SettlementModel, type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { type ClientStellarSigner, createEd25519Signer } from "@x402/stellar";

const CAIP2: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;

/**
 * Hands an MPP client the Ed25519 key it signs with. A function rather than
 * a property, so the key never sits on an enumerable field of the signer and
 * `JSON.stringify(signer)` cannot print it.
 */
export type MppKeyCapability = {
  keypair(): Keypair;
};

/** What a signer can sign, per protocol. A missing entry means "cannot". */
export type AgentSignerCapabilities = {
  /** Soroban auth-entry signing for x402, as `ExactStellarScheme` expects it. */
  readonly x402?: ClientStellarSigner;
  /** The key `@stellar/mpp`'s charge client signs the transfer with. */
  readonly mppCharge?: MppKeyCapability;
  /** The key `@stellar/mpp`'s channel client signs commitments with. */
  readonly mppChannel?: MppKeyCapability;
};

/** The name of one capability: `x402`, `mppCharge` or `mppChannel`. */
export type AgentSignerCapability = keyof AgentSignerCapabilities;

/**
 * One payment identity, consumed by every settler. Any object of this shape
 * works, so a remote or KMS-backed signer can provide the `x402` capability
 * with async callbacks and never expose a key.
 */
export type AgentSigner = {
  /** The Stellar account that pays: `G...` for a keypair, `C...` for a smart account. */
  readonly address: string;
  readonly network: StellarNetwork;
  readonly capabilities: AgentSignerCapabilities;
};

export type SmartAccountSignerOptions = {
  /** The smart account's contract address (`C...`). */
  contractId: string;
  network: StellarNetwork;
  /**
   * Signs one Soroban authorization entry for the smart account. It receives
   * the base64 XDR `HashIdPreimage` preimage exactly as `ExactStellarScheme`
   * passes it, and returns the signature in the form the account's
   * `__check_auth` expects.
   */
  signAuthEntry: ClientStellarSigner["signAuthEntry"];
  /** Signs a whole transaction, for flows that need it. */
  signTransaction?: ClientStellarSigner["signTransaction"];
};

/** Which capability each settlement model needs. */
const MODEL_CAPABILITY: Record<SettlementModel, AgentSignerCapability> = {
  x402: "x402",
  "mpp-charge": "mppCharge",
  "mpp-channel": "mppChannel",
};

/**
 * Thrown when a settler is given a signer that cannot sign for its protocol.
 * Code `payment-failed`; `capability` names what was missing.
 */
export class SignerCapabilityError extends TollwayError {
  readonly capability: AgentSignerCapability;
  constructor(capability: AgentSignerCapability, model: SettlementModel, address: string) {
    super(
      "payment-failed",
      `the signer for ${address} has no ${capability} capability, so it cannot pay ${model}`,
    );
    this.name = "SignerCapabilityError";
    this.capability = capability;
  }
}

/**
 * A signer backed by a classic Stellar keypair. It can pay every model. The
 * secret is held in closures only: it is not on any property of the signer
 * and never appears in an error message.
 */
export function createKeypairSigner(
  secret: string | Keypair,
  network: StellarNetwork,
): AgentSigner {
  let keypair: Keypair;
  if (typeof secret === "string") {
    try {
      keypair = Keypair.fromSecret(secret);
    } catch {
      // The SDK's message is generic today, but it is not ours to promise
      // that it never echoes input, so it is not passed on.
      throw new TollwayError("invalid-signing-key", "the agent secret is not a Stellar secret key");
    }
  } else {
    keypair = secret;
  }
  if (!keypair.canSign()) {
    throw new TollwayError(
      "invalid-signing-key",
      `the keypair for ${keypair.publicKey()} has no secret, so it cannot sign`,
    );
  }
  const mppKey: MppKeyCapability = { keypair: () => keypair };
  return {
    address: keypair.publicKey(),
    network,
    capabilities: {
      x402: createEd25519Signer(keypair.secret(), CAIP2[network]),
      mppCharge: mppKey,
      mppChannel: mppKey,
    },
  };
}

/**
 * A signer for an OpenZeppelin Stellar smart account (`C...`). It adapts the
 * caller's `signAuthEntry` to `@x402/stellar`'s `ClientStellarSigner`, so it
 * pays x402 only: `@stellar/mpp` cannot sign from a contract account.
 *
 * Tollway does not build the smart-account signature itself. The callback
 * returns whatever the account's `__check_auth` verifies; see the client
 * README, "Signers", for the OpenZeppelin source this follows.
 */
export function createSmartAccountSigner(options: SmartAccountSignerOptions): AgentSigner {
  if (!CONTRACT_ADDRESS.test(options.contractId)) {
    throw new TollwayError(
      "invalid-signing-key",
      `the smart account "${options.contractId}" is not a Stellar contract address (C...)`,
    );
  }
  const x402: ClientStellarSigner = {
    address: options.contractId,
    signAuthEntry: options.signAuthEntry,
    ...(options.signTransaction === undefined ? {} : { signTransaction: options.signTransaction }),
  };
  return { address: options.contractId, network: options.network, capabilities: { x402 } };
}

/** The settlement models a signer can pay, in the router's preference order. */
export function signerModels(signer: AgentSigner): SettlementModel[] {
  return (["x402", "mpp-charge", "mpp-channel"] as const).filter(
    (model) => signer.capabilities[MODEL_CAPABILITY[model]] !== undefined,
  );
}

function assertSameNetwork(signer: AgentSigner, model: SettlementModel, network: StellarNetwork) {
  if (signer.network !== network) {
    throw new TollwayError(
      "payment-failed",
      `the ${model} settler is configured for ${network}, but the signer is on ${signer.network}`,
    );
  }
}

/** The signer's x402 capability. Throws `SignerCapabilityError` when it has none. */
export function requireX402Capability(
  signer: AgentSigner,
  network: StellarNetwork,
): ClientStellarSigner {
  assertSameNetwork(signer, "x402", network);
  const x402 = signer.capabilities.x402;
  if (x402 === undefined) throw new SignerCapabilityError("x402", "x402", signer.address);
  return x402;
}

/** The signer's MPP key for `model`. Throws `SignerCapabilityError` when it has none. */
export function requireMppKey(
  signer: AgentSigner,
  model: "mpp-charge" | "mpp-channel",
  network: StellarNetwork,
): MppKeyCapability {
  assertSameNetwork(signer, model, network);
  const capability = MODEL_CAPABILITY[model];
  const key =
    model === "mpp-charge" ? signer.capabilities.mppCharge : signer.capabilities.mppChannel;
  if (key === undefined) throw new SignerCapabilityError(capability, model, signer.address);
  return key;
}

/** True for an `AgentSigner`, false for a bare `ClientStellarSigner`. */
export function isAgentSigner(value: AgentSigner | ClientStellarSigner): value is AgentSigner {
  return "capabilities" in value && typeof value.capabilities === "object";
}
