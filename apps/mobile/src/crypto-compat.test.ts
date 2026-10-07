import { gcm as desktopGcm } from '@noble/ciphers/aes'
import { ed25519 as desktopEd25519 } from '@noble/curves/ed25519'
import { describe, expect, it, vi } from 'vitest'
import fixture from '../../../packages/core/tests/fixtures/remote-crypto-vectors.json'
import { referenceFixture, signAuth, verifyAuth, FIXTURE_PRIV, RemoteCipher, hexToBytes } from '@jeff/core/remote'
import { x25519, ed25519, gcm } from './crypto-primitives'
import { nonceFor } from '../../../packages/core/src/remote/bytes'

describe('WebView without BigInt', () => {
  it('runs the real mobile protocol against the desktop/Kotlin vectors', () => {
    vi.stubGlobal('BigInt', undefined)
    try { expect(referenceFixture()).toEqual(fixture) } finally { vi.unstubAllGlobals() }
  })
  it('signs relay authentication and rejects changed challenges', () => {
    // Signing keys are Ed25519 rather than the fixture X25519 public key.
    const signingPub = ed25519.getPublicKey(FIXTURE_PRIV.aliceStatic)
    const sig = signAuth(FIXTURE_PRIV.aliceStatic, 'challenge', 'phone', 'id', 'public')
    expect(verifyAuth(signingPub, sig, 'challenge', 'phone', 'id', 'public')).toBe(true)
    expect(verifyAuth(signingPub, sig, 'changed', 'phone', 'id', 'public')).toBe(false)
    expect(() => x25519.getSharedSecret(FIXTURE_PRIV.aliceStatic, new Uint8Array(32))).toThrow()
  })
  it('interoperates with the desktop primitives for signatures and AES-GCM', () => {
    const message = new TextEncoder().encode('relay challenge: 非 ASCII 内容')
    const signed = ed25519.sign(message, FIXTURE_PRIV.aliceStatic)
    expect(signed).toEqual(desktopEd25519.sign(message, FIXTURE_PRIV.aliceStatic))
    expect(desktopEd25519.verify(signed, message, ed25519.getPublicKey(FIXTURE_PRIV.aliceStatic))).toBe(true)
    const key = hexToBytes(fixture.lowToHigh)
    for (const length of [0, 1, 15, 16, 17, 1024]) {
      const plain = Uint8Array.from({ length }, (_, index) => index % 256)
      const nonce = nonceFor(length)
      const sealed = gcm(key, nonce, message).encrypt(plain)
      expect(sealed).toEqual(desktopGcm(key, nonce, message).encrypt(plain))
      expect(gcm(key, nonce, message).decrypt(sealed)).toEqual(plain)
      expect(desktopGcm(key, nonce, message).decrypt(sealed)).toEqual(plain)
    }
  })
  it('rejects corrupted ciphertext without advancing the receive counter', () => {
    const box = new RemoteCipher(hexToBytes(fixture.lowToHigh), hexToBytes(fixture.highToLow))
    const bad = hexToBytes(fixture.ciphertext0); bad[0] ^= 1
    expect(() => box.open(0, bad)).toThrow(/authentication/)
    expect(box.open(0, hexToBytes(fixture.ciphertext0)).length).toBeGreaterThan(0)
    expect(() => box.open(0, hexToBytes(fixture.ciphertext0))).toThrow(/序号/)
  })
  it('encodes safe counter boundaries exactly and rejects unsafe counters', () => {
    expect(Array.from(nonceFor(Number.MAX_SAFE_INTEGER))).toEqual([0,0,0,0,0,31,255,255,255,255,255,255])
    expect(() => nonceFor(Number.MAX_SAFE_INTEGER + 1)).toThrow()
    expect(() => nonceFor(-1)).toThrow()
  })
})
