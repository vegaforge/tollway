import { Mppx, Challenge, Credential, Receipt } from "mppx";
import { stellar } from "@stellar/mpp/charge/client";
import { Asset } from "@stellar/stellar-sdk";

export type TollwayNetwork = "testnet" | "mainnet";

export interface PaymentOffer {
  amount: string;
  asset: string;
  payTo: string;
  network: string;
  model: string;
}

export interface TollwayReceipt {
  model: string;
  settlement?: { txHash?: string };
  [key: string]: unknown;
}

export interface ClientSettler {
  readonly model: string;
  pay(input: { url: string; offer: PaymentOffer; fetch: typeof fetch }): Promise<{ response: Response; receipt: TollwayReceipt }>;
}

export class TollwayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TollwayError";
    this.code = code;
  }
}

export interface MppChargeSettlerOptions {
  keypair?: unknown;
  secretKey?: string;
  network: TollwayNetwork;
  rpcUrl?: string;
  mode?: "pull" | "push";
  fetch?: typeof fetch;
  receiptHeader?: string;
}

const NETWORK_IDS: Record<TollwayNetwork, string> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const NETWORK_PASSPHRASES: Record<TollwayNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

export function createMppChargeSettler(options: MppChargeSettlerOptions): ClientSettler {
  if (!options.keypair && !options.secretKey) {
    throw new TollwayError("config", "keypair or secretKey is required");
  }
  const networkId = NETWORK_IDS[options.network];
  if (!networkId) {
    throw new TollwayError("config", `unsupported network: ${String(options.network)}`);
  }
  const baseFetch = options.fetch ?? globalThis.fetch;
  const receiptHeader = options.receiptHeader ?? "Tollway-Receipt";
  const passphrase = NETWORK_PASSPHRASES[options.network];

  const methodOptions: Record<string, unknown> = {
    decimals: 7,
    mode: options.mode ?? "pull",
    ...(options.keypair ? { keypair: options.keypair } : { secretKey: options.secretKey }),
    ...(options.rpcUrl ? { rpcUrl: options.rpcUrl } : {}),
  };

  const expectedCurrency = (offer: PaymentOffer): string => {
    const asset = offer.asset;
    if (asset.startsWith("C")) return asset;
    const [code, issuer] = asset.split(":");
    if (!code || !issuer) {
      throw new TollwayError("asset", `unrecognized asset: ${asset}`);
    }
    return new Asset(code, issuer).contractId(passphrase);
  };

  return {
    model: "mpp-charge",
    async pay({ url, offer, fetch: callerFetch }) {
      const doFetch = options.fetch ?? callerFetch ?? baseFetch;
      const first = await doFetch(url);
      if (first.status !== 402) {
        throw new TollwayError("no_challenge", `expected 402 challenge, got ${first.status}`);
      }

      let paid = false;
      const client = Mppx.create({
        methods: [stellar.charge(methodOptions as never)],
        fetch: doFetch,
        polyfill: false,
        onChallenge: async (challenge: any, { createCredential }: any) => {
          if (paid) {
            throw new TollwayError("second_challenge", "server returned a second 402 after payment");
          }
          if (challenge.method !== "stellar" || challenge.intent !== "charge") {
            throw new TollwayError("challenge_mismatch", "challenge is not a Stellar charge");
          }
          const req = challenge.request ?? {};
          if (String(req.amount) !== String(offer.amount)) {
            throw new TollwayError("challenge_mismatch", "challenge amount does not match offer");
          }
          if (req.recipient !== offer.payTo) {
            throw new TollwayError("challenge_mismatch", "challenge recipient does not match offer");
          }
          if (req.currency !== expectedCurrency(offer)) {
            throw new TollwayError("challenge_mismatch", "challenge currency does not match offer asset");
          }
          if (req.methodDetails?.network !== networkId || offer.network !== networkId) {
            throw new TollwayError("challenge_mismatch", "challenge network does not match offer");
          }
          paid = true;
          return createCredential();
        },
      });

      const response = await client.fetch(url);
      if (response.status === 402) {
        throw new TollwayError("second_challenge", "server returned 402 after payment");
      }

      const headerValue = response.headers.get(receiptHeader);
      if (!headerValue) {
        throw new TollwayError("missing_receipt", `response missing ${receiptHeader} header`);
      }
      let receipt: TollwayReceipt;
      try {
        receipt = JSON.parse(headerValue) as TollwayReceipt;
      } catch {
        throw new TollwayError("missing_receipt", "Tollway receipt header is not valid JSON");
      }
      if (receipt.model !== "mpp-charge") {
        throw new TollwayError("receipt_mismatch", `receipt model is ${receipt.model}, expected mpp-charge`);
      }

      const mppHeader = response.headers.get("Payment-Receipt");
      if (mppHeader) {
        const mppReceipt = Receipt.fromResponse(response) as { reference?: string };
        if (mppReceipt.reference && receipt.settlement?.txHash !== mppReceipt.reference) {
          throw new TollwayError("receipt_mismatch", "settlement txHash does not match MPP receipt reference");
        }
      }

      return { response, receipt };
    },
  };
}
