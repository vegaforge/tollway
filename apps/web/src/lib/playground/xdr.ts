/**
 * Decodes the Stellar transaction inside an x402 PAYMENT-SIGNATURE.
 *
 * `@stellar/stellar-base` is several hundred kilobytes, so it is imported
 * only when a signed payment is decoded. The docs pages and the rest of the
 * playground never load it.
 */

export type StellarTransfer = {
  /** Account that submits the transaction. */
  source: string;
  sequence: string;
  /** Fee in stroops. */
  fee: string;
  /** From the SEP-41 `transfer(from, to, amount)` call, when there is one. */
  payer: string | null;
  payee: string | null;
  /** Integer string in the asset's smallest unit. */
  amount: string | null;
};

type StellarBase = typeof import("@stellar/stellar-base");

function passphraseFor(stellar: StellarBase, network: string): string {
  if (network === "stellar:testnet") return stellar.Networks.TESTNET;
  if (network === "stellar:pubnet") return stellar.Networks.PUBLIC;
  throw new Error(
    `Unknown Stellar network "${network}"; expected stellar:testnet or stellar:pubnet.`,
  );
}

export async function decodeStellarTransfer(
  transactionXdr: string,
  network: string,
): Promise<StellarTransfer> {
  const stellar = await import("@stellar/stellar-base");
  const envelope = stellar.TransactionBuilder.fromXDR(
    transactionXdr,
    passphraseFor(stellar, network),
  );
  // A fee bump wraps the payer's transaction; the transfer is in the inner one.
  const transaction =
    envelope instanceof stellar.FeeBumpTransaction ? envelope.innerTransaction : envelope;

  const result: StellarTransfer = {
    source: transaction.source,
    sequence: transaction.sequence,
    fee: envelope.fee,
    payer: null,
    payee: null,
    amount: null,
  };

  for (const operation of transaction.operations) {
    if (operation.type !== "invokeHostFunction") continue;
    const func = operation.func;
    if (func.switch() !== stellar.xdr.HostFunctionType.hostFunctionTypeInvokeContract()) continue;
    const call = func.invokeContract();
    if (call.functionName().toString() !== "transfer") continue;
    const [from, to, amount] = call.args();
    if (from === undefined || to === undefined || amount === undefined) continue;
    result.payer = stellar.Address.fromScVal(from).toString();
    result.payee = stellar.Address.fromScVal(to).toString();
    result.amount = stellar.scValToBigInt(amount).toString();
    break;
  }
  return result;
}
