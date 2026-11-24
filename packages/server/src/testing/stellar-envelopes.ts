import {
  Account,
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

/**
 * Real Stellar x402 exact payment envelopes for tests (#159), built with
 * `@stellar/stellar-sdk` the way a Stellar client builds them. Each option
 * breaks one property the facilitator checks, so a test can aim at a single
 * rejection reason.
 */

// USDC testnet SAC: a Soroban contract address, as x402 names the asset.
export const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const OTHER_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
export const PAY_TO = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
export const PAYER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));
export const AMOUNT = "10000";

export const REQUIREMENTS = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: ASSET,
  payTo: PAY_TO,
  amount: AMOUNT,
  maxTimeoutSeconds: 60,
  extra: {},
} as const;

type EnvelopeOptions = {
  asset?: string;
  functionName?: string;
  args?: xdr.ScVal[];
  to?: string;
  amount?: bigint;
  auth?: "address" | "source-account" | "none";
  expirationLedger?: number;
  operations?: "one" | "two" | "payment";
  hostFunction?: "invoke" | "upload";
};

/** Builds a signed x402 exact payment envelope the way a Stellar client does. */
export function envelope(options: EnvelopeOptions = {}): string {
  const args = options.args ?? [
    nativeToScVal(PAYER.publicKey(), { type: "address" }),
    nativeToScVal(options.to ?? PAY_TO, { type: "address" }),
    nativeToScVal(options.amount ?? BigInt(AMOUNT), { type: "i128" }),
  ];
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(options.asset ?? ASSET).toScAddress(),
    functionName: options.functionName ?? "transfer",
    args,
  });
  const credentials =
    options.auth === "source-account"
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: Address.fromString(PAYER.publicKey()).toScAddress(),
            nonce: xdr.Int64.fromString("42"),
            signatureExpirationLedger: options.expirationLedger ?? 1_000,
            signature: xdr.ScVal.scvVoid(),
          }),
        );
  const auth =
    options.auth === "none"
      ? []
      : [
          new xdr.SorobanAuthorizationEntry({
            credentials,
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
              function:
                xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(invokeArgs),
              subInvocations: [],
            }),
          }),
        ];
  const func =
    options.hostFunction === "upload"
      ? xdr.HostFunction.hostFunctionTypeUploadContractWasm(Buffer.from([0, 97, 115, 109]))
      : xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  const builder = new TransactionBuilder(new Account(PAYER.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  });
  if (options.operations === "payment") {
    builder.addOperation(Operation.bumpSequence({ bumpTo: "2" }));
  } else {
    builder.addOperation(Operation.invokeHostFunction({ func, auth }));
    if (options.operations === "two") {
      builder.addOperation(Operation.invokeHostFunction({ func, auth }));
    }
  }
  const transaction = builder.setTimeout(60).build();
  transaction.sign(PAYER);
  return transaction.toXDR();
}
