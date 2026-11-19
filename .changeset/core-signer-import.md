---
"@vegaforge/tollway-core": minor
---

Add `Ed25519Signer.fromPrivateKey(encodedKey, keyId?)`, which loads a persisted Ed25519 receipt key (a base64url 32-byte seed or 48-byte PKCS#8 document) with WebCrypto, so every instance of a serverless service signs with the same key. Adds the `invalid-signing-key` error code, thrown for a key that is not base64url, has the wrong length or is not Ed25519. The message never contains the key.
