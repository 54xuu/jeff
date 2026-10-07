import nacl from 'tweetnacl'
import { AES } from '@stablelib/aes'
import { GCM } from '@stablelib/gcm'
import { HKDF } from '@stablelib/hkdf'
import { SHA256, hash } from '@stablelib/sha256'

// Keep the shared protocol's primitive interface. These implementations operate
// on byte arrays and work in WebView 60 without BigInt or a global crypto shim.
export const sha256 = hash
export function hkdf(_hash: typeof hash, key: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const kdf = new HKDF(SHA256, key, salt, info)
  try { return kdf.expand(length) } finally { kdf.clean() }
}

export const ed25519 = {
  utils: { randomPrivateKey: () => nacl.randomBytes(32) },
  getPublicKey: (seed: Uint8Array) => nacl.sign.keyPair.fromSeed(seed).publicKey,
  sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
    const pair = nacl.sign.keyPair.fromSeed(seed)
    try { return nacl.sign.detached(message, pair.secretKey) } finally { pair.secretKey.fill(0) }
  },
  verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) =>
    nacl.sign.detached.verify(message, signature, publicKey),
}

export const x25519 = {
  utils: { randomPrivateKey: () => nacl.randomBytes(32) },
  getPublicKey: (secret: Uint8Array) => nacl.scalarMult.base(secret),
  getSharedSecret(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
    const shared = nacl.scalarMult(secret, publicKey)
    if (shared.every(byte => byte === 0)) throw new Error('Invalid X25519 peer public key')
    return shared
  },
}

export function gcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) {
  // One fresh primitive per operation, and never return plaintext on tag failure.
  function run(input: Uint8Array, decrypt: boolean): Uint8Array {
    const aes = new AES(key)
    const cipher = new GCM(aes)
    try {
      const output = decrypt ? cipher.open(nonce, input, aad) : cipher.seal(nonce, input, aad)
      if (!output) throw new Error('AES-GCM authentication failed')
      return output
    } finally { cipher.clean(); aes.clean() }
  }
  return {
    encrypt: (plain: Uint8Array) => run(plain, false),
    decrypt: (sealed: Uint8Array) => run(sealed, true),
  }
}
