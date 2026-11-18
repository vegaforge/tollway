import type { ReceiptSigner, ReceiptVerifier } from "@vegaforge/tollway-core";

async function digest(message: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", message as BufferSource));
}

export class MockReceiptSigner implements ReceiptSigner, ReceiptVerifier {
  readonly keyId = "mock-no-secret";
  readonly algorithm = "Mock-SHA-256";

  sign(message: Uint8Array): Promise<Uint8Array> {
    return digest(message);
  }

  async verify(input: {
    message: Uint8Array;
    signature: Uint8Array;
    keyId: string;
    algorithm: string;
  }): Promise<boolean> {
    const expected = await digest(input.message);
    return (
      input.keyId === this.keyId &&
      input.algorithm === this.algorithm &&
      expected.length === input.signature.length &&
      expected.every((byte, index) => byte === input.signature[index])
    );
  }
}
