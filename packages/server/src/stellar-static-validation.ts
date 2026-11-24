import {
  Address,
  Networks,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { PaymentOffer } from "@vegaforge/tollway-core";
import type { PaymentRequirements } from "@x402/core/types";

export const MAX_PAYMENT_SIGNATURE_TRANSACTION_CHARS = 64 * 1024;

export type StaticPaymentCheck =
  | { valid: true }
  | { valid: false; reason: string };

function nativeAddress(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value;
}

function nativeAmount(value: unknown): string | undefined {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

/**
 * Checks the static part of an x402 Stellar exact payment. This rejects bad
 * envelopes before HTTP /verify is called. Simulation and on-chain checks remain
 * the facilitator's responsibility.
 */
export function checkStaticX402Payment(
  transactionBase64: string,
  requirements: PaymentRequirements,
  accepted: PaymentRequirements,
): StaticPaymentCheck {
  if (transactionBase64.length > MAX_PAYMENT_SIGNATURE_TRANSACTION_CHARS) {
    return { valid: false, reason: "payment transaction envelope is too large" };
  }

  if (accepted.scheme !== "exact") {
    return { valid: false, reason: "payment accepted a non-exact scheme" };
  }
  if (
    accepted.network !== requirements.network ||
    accepted.asset !== requirements.asset ||
    accepted.amount !== requirements.amount ||
    accepted.payTo !== requirements.payTo
  ) {
    return { valid: false, reason: "payment accepted terms do not match the configured offer" };
  }

  const passphrase =
    requirements.network === "stellar:testnet"
      ? Networks.TESTNET
      : requirements.network === "stellar:pubnet"
        ? Networks.PUBLIC
        : undefined;
  if (!passphrase) {
    return { valid: false, reason: "unsupported Stellar network" };
  }

  let transaction: ReturnType<typeof TransactionBuilder.fromXDR>;
  try {
    transaction = TransactionBuilder.fromXDR(transactionBase64, passphrase);
  } catch {
    return { valid: false, reason: "payment transaction envelope is invalid" };
  }

  if (!("operations" in transaction)) {
    return { valid: false, reason: "fee-bump transactions are not accepted for x402 exact payments" };
  }
  if (transaction.operations.length !== 1) {
    return { valid: false, reason: "payment transaction must contain exactly one operation" };
  }

  const operation = transaction.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    return { valid: false, reason: "payment transaction must invoke one Soroban contract" };
  }

  const invokeOperation = operation as typeof operation & {
    func: {
      switch(): { name: string };
      invokeContract(): {
        contractAddress(): Parameters<typeof Address.fromScAddress>[0];
        functionName(): Uint8Array;
        args(): unknown[];
      };
    };
  };
  if (invokeOperation.func.switch().name !== "hostFunctionTypeInvokeContract") {
    return { valid: false, reason: "payment transaction host function is not an invoke contract" };
  }

  let invocation;
  try {
    invocation = invokeOperation.func.invokeContract();
  } catch {
    return { valid: false, reason: "payment transaction has an invalid contract invocation" };
  }

  let contractAddress: string;
  let functionName: string;
  let args: unknown[];
  try {
    contractAddress = Address.fromScAddress(invocation.contractAddress()).toString();
    functionName = new TextDecoder().decode(invocation.functionName());
    args = invocation.args();
  } catch {
    return { valid: false, reason: "payment transaction has invalid invocation arguments" };
  }

  if (contractAddress !== requirements.asset) {
    return { valid: false, reason: "payment contract does not match the configured asset" };
  }
  if (functionName !== "transfer") {
    return { valid: false, reason: "payment contract function is not transfer" };
  }
  if (args.length !== 3) {
    return { valid: false, reason: "payment transfer must have exactly three arguments" };
  }

  let to: unknown;
  let amount: unknown;
  try {
    to = scValToNative(args[1]);
    amount = scValToNative(args[2]);
  } catch {
    return { valid: false, reason: "payment transfer arguments are invalid" };
  }

  const nativeTo = nativeAddress(to);
  if (nativeTo !== requirements.payTo) {
    return { valid: false, reason: "payment transfer recipient does not match the configured payee" };
  }
  const nativeAmount = nativeAmountValue(amount);
  if (nativeAmount !== requirements.amount) {
    return { valid: false, reason: "payment transfer amount does not match the configured amount" };
  }

  return { valid: true };
}

function nativeAmountValue(value: unknown): string | undefined {
  return nativeAmount(value);
}

export function checkStaticOfferPayment(
  transactionBase64: string,
  requirements: PaymentRequirements,
  accepted: PaymentRequirements,
): StaticPaymentCheck {
  return checkStaticX402Payment(transactionBase64, requirements, accepted);
}

export function toRequirementsInput(offer: PaymentOffer): unknown {
  return offer;
}
