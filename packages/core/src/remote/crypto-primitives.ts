/** Desktop/relay primitives. Mobile substitutes its BigInt-free implementation
 * at build time; protocol framing, key derivation labels and counters stay shared. */
export { gcm } from '@noble/ciphers/aes'
export { ed25519, x25519 } from '@noble/curves/ed25519'
export { hkdf } from '@noble/hashes/hkdf'
export { sha256 } from '@noble/hashes/sha2'
