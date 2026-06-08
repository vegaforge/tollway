import { base64UrlToBytes, bytesToBase64Url } from "../encoding.js";

/**
 * Signing sits behind an interface so the key can live wherever a deployment
 * needs it: in process, a KMS, an HSM. Ed25519 over WebCrypto is the default
 * and runs in both Node and edge runtimes.
 */

export interface ReceiptSigner {
  readonly keyId: string;
  readonly algorithm: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface ReceiptVerifier {
  verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean>;
}

const ED25519 = "Ed25519";

export class Ed25519Signer implements ReceiptSigner {
  readonly algorithm = ED25519;
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  private readonly privateKey: CryptoKey;

  private constructor(keyId: string, publicKey: Uint8Array, privateKey: CryptoKey) {
    this.keyId = keyId;
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }

  /**
   * Generates a keypair. keyId defaults to the base64url public key; pass a
   * name if you rotate keys and want stable ids.
   */
  static async generate(keyId?: string): Promise<Ed25519Signer> {
    const pair = (await crypto.subtle.generateKey(ED25519, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    return new Ed25519Signer(keyId ?? bytesToBase64Url(publicKey), publicKey, pair.privateKey);
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
      await crypto.subtle.sign(ED25519, this.privateKey, message as BufferSource),
    );
  }
}

/**
 * Verifies against a set of trusted public keys by keyId. An unknown key or a
 * different algorithm returns false rather than throwing.
 */
export class Ed25519Verifier implements ReceiptVerifier {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(publicKeys: Record<string, Uint8Array | string>) {
    for (const [keyId, key] of Object.entries(publicKeys)) {
      this.keys.set(keyId, typeof key === "string" ? base64UrlToBytes(key) : key);
    }
  }

  static forSigner(signer: Ed25519Signer): Ed25519Verifier {
    return new Ed25519Verifier({ [signer.keyId]: signer.publicKey });
  }

  async verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean> {
    if (input.algorithm !== ED25519) {
      return false;
    }
    const raw = this.keys.get(input.keyId);
    if (!raw) {
      return false;
    }
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, ED25519, false, [
      "verify",
    ]);
    return crypto.subtle.verify(
      ED25519,
      key,
      input.signature as BufferSource,
      input.message as BufferSource,
    );
  }
}
