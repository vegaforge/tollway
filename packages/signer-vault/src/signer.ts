import { bytesToBase64Url, type PublicJwk, type ReceiptSigner } from "@vegaforge/tollway-core";
import { z } from "zod";
import { trimSlashes } from "./trim.js";
import { type VaultTokenSource, VaultTransitError, vaultRequest } from "./vault.js";

/**
 * A `ReceiptSigner` whose private key lives in Vault Transit. The process
 * holds only a Vault token; every signature is a round trip to
 * `POST /v1/<mount>/sign/<name>`.
 *
 * The key version is resolved once, when the signer is created, and pinned
 * on every sign call. Transit signs with the latest version by default, so
 * without the pin a rotation in Vault would change the key behind a `keyId`
 * verifiers already trust. Picking up a rotation means creating a new
 * signer, which gets a new `keyId`.
 */

export type VaultTransitSignerOptions = {
  /** Vault's address, for example `https://vault.internal:8200`. */
  address: string;
  /**
   * A Vault token, or a function that returns one. The function is called
   * before every request, so it can renew or fetch a short-lived token.
   */
  token: VaultTokenSource;
  /** The Transit key's name. */
  keyName: string;
  /** Where the Transit engine is mounted. Defaults to `transit`. */
  mount?: string;
  /** Enterprise namespace, sent as `X-Vault-Namespace`. */
  namespace?: string;
  /** A key version to pin. Defaults to the key's latest version at creation. */
  keyVersion?: number;
  /** Milliseconds before a Vault request is abandoned. Defaults to 5000. */
  timeoutMs?: number;
  /** Aborts every Vault request this signer makes, now or later. */
  signal?: AbortSignal;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
};

/** A Vault-backed signer, with the public half of its pinned key version. */
export interface VaultTransitSigner extends ReceiptSigner {
  readonly algorithm: "Ed25519";
  readonly keyName: string;
  readonly mount: string;
  readonly keyVersion: number;
  /** The 32-byte Ed25519 public key of the pinned version. */
  readonly publicKey: Uint8Array;
  /** The pinned version's public key as a JWK, ready for a key-set document. */
  publicJwk(): PublicJwk;
}

const DEFAULT_MOUNT = "transit";
const DEFAULT_TIMEOUT_MS = 5_000;
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Vault names: letters, digits, dashes, underscores and dots. Mounts may nest. */
const KEY_NAME = /^[A-Za-z0-9_.-]+$/;
const MOUNT = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
/** Transit's signature format: `vault:v<version>:<standard base64>`. */
const VAULT_SIGNATURE = /^vault:v([1-9][0-9]*):([A-Za-z0-9+/]+={0,2})$/;

const keyInfoSchema = z.object({
  data: z.object({
    type: z.string(),
    latest_version: z.number().int().positive(),
    keys: z.record(z.string(), z.unknown()),
  }),
});

const keyVersionSchema = z.object({ public_key: z.string().min(1) });

const signResponseSchema = z.object({
  data: z.object({ signature: z.string() }),
});

/** Standard base64 (Vault's encoding) to bytes, strictly. */
function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeKey(text: string, what: string): Uint8Array {
  try {
    return base64ToBytes(text);
  } catch (error) {
    throw new VaultTransitError("invalid-response", `${what} is not base64`, { cause: error });
  }
}

/**
 * Parses a Transit signature and checks it was made by the pinned version.
 * A different version is an error, never a silent accept.
 */
export function parseVaultSignature(signature: string, pinnedVersion: number): Uint8Array {
  const match = VAULT_SIGNATURE.exec(signature);
  if (!match?.[1] || !match[2]) {
    throw new VaultTransitError(
      "invalid-response",
      "Vault returned a signature that is not in the vault:v<N>:<base64> form",
    );
  }
  const version = Number(match[1]);
  if (version !== pinnedVersion) {
    throw new VaultTransitError(
      "version-mismatch",
      `Vault signed with key version ${version}, but this signer is pinned to version ${pinnedVersion}`,
    );
  }
  const bytes = decodeKey(match[2], "the Vault signature");
  if (bytes.length !== ED25519_SIGNATURE_BYTES) {
    throw new VaultTransitError(
      "invalid-response",
      `an Ed25519 signature is ${ED25519_SIGNATURE_BYTES} bytes, Vault returned ${bytes.length}`,
    );
  }
  return bytes;
}

/** The `keyId` receipts carry: the mount, the key name and the pinned version. */
export function vaultKeyId(mount: string, keyName: string, keyVersion: number): string {
  return `vault-transit:${mount}/${keyName}:v${keyVersion}`;
}

/**
 * Creates a signer for an Ed25519 Transit key. Reads the key once to check
 * its type and to resolve and pin a version, so a misconfiguration fails
 * here, at startup, rather than on the first paid request.
 */
export async function createVaultTransitSigner(
  options: VaultTransitSignerOptions,
): Promise<VaultTransitSigner> {
  const mount = trimSlashes(options.mount ?? DEFAULT_MOUNT);
  if (!MOUNT.test(mount) || mount.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError(`mount must be a Vault path such as "transit", got "${mount}"`);
  }
  if (!KEY_NAME.test(options.keyName) || options.keyName === "." || options.keyName === "..") {
    throw new TypeError(
      `keyName may contain only letters, digits, "-", "_" and ".", got "${options.keyName}"`,
    );
  }
  if (
    options.keyVersion !== undefined &&
    !(Number.isSafeInteger(options.keyVersion) && options.keyVersion > 0)
  ) {
    throw new TypeError(`keyVersion must be a positive integer, got ${options.keyVersion}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError(`timeoutMs must be a positive number, got ${timeoutMs}`);
  }
  let address: URL;
  try {
    address = new URL(options.address);
  } catch (error) {
    throw new TypeError(`address must be a URL, got "${options.address}"`, { cause: error });
  }
  const request = {
    address: address.toString(),
    token: options.token,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    fetch: options.fetch ?? globalThis.fetch,
  };

  const { json, requestId } = await vaultRequest(
    request,
    "GET",
    `${mount}/keys/${options.keyName}`,
  );
  const info = keyInfoSchema.safeParse(json);
  if (!info.success) {
    throw new VaultTransitError(
      "invalid-response",
      `Vault's description of ${mount}/keys/${options.keyName} is not a Transit key`,
      requestId === undefined ? {} : { requestId },
    );
  }
  if (info.data.data.type !== "ed25519") {
    throw new VaultTransitError(
      "unsupported-key-type",
      `the Transit key ${options.keyName} is ${info.data.data.type}; only ed25519 keys are supported`,
    );
  }

  const keyVersion = options.keyVersion ?? info.data.data.latest_version;
  const versionEntry = keyVersionSchema.safeParse(info.data.data.keys[String(keyVersion)]);
  if (!versionEntry.success) {
    throw new VaultTransitError(
      "key-missing",
      `the Transit key ${options.keyName} has no version ${keyVersion} with a public key`,
      requestId === undefined ? {} : { requestId },
    );
  }
  const publicKey = decodeKey(versionEntry.data.public_key, "the Transit public key");
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    throw new VaultTransitError(
      "invalid-response",
      `an Ed25519 public key is ${ED25519_PUBLIC_KEY_BYTES} bytes, Vault returned ${publicKey.length}`,
    );
  }

  const keyId = vaultKeyId(mount, options.keyName, keyVersion);
  const signPath = `${mount}/sign/${options.keyName}`;

  return {
    keyId,
    algorithm: "Ed25519",
    keyName: options.keyName,
    mount,
    keyVersion,
    publicKey,
    publicJwk(): PublicJwk {
      return {
        kty: "OKP",
        crv: "Ed25519",
        x: bytesToBase64Url(publicKey),
        kid: keyId,
        alg: "EdDSA",
        use: "sig",
      };
    },
    async sign(message: Uint8Array): Promise<Uint8Array> {
      const { json: signed, requestId: signRequestId } = await vaultRequest(
        request,
        "POST",
        signPath,
        { input: bytesToBase64(message), key_version: keyVersion },
      );
      const parsed = signResponseSchema.safeParse(signed);
      if (!parsed.success) {
        throw new VaultTransitError(
          "invalid-response",
          `Vault's answer to ${signPath} carries no signature`,
          signRequestId === undefined ? {} : { requestId: signRequestId },
        );
      }
      return parseVaultSignature(parsed.data.data.signature, keyVersion);
    },
  };
}
