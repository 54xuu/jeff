import { gcm } from '@noble/ciphers/aes'
import { ed25519, x25519 } from '@noble/curves/ed25519'
import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { bytesToB64, bytesToHex, compareBytes, concatBytes, hexToBytes, nonceFor, utf8, utf8Decode } from './bytes.js'

const E2E_LABEL = 'jeff-remote-e2e-v1'
const SALT = utf8(E2E_LABEL)
const AUTH_LABEL = 'jeff-relay-auth-v1'

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function randomEd25519(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = ed25519.utils.randomPrivateKey()
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) }
}

export function ed25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey)
}

export function randomX25519(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = x25519.utils.randomPrivateKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function x25519PublicKey(secretKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secretKey)
}

/** 中转站 challenge 的签名原文。签名覆盖公钥本身，防止把别人的公钥拿来注册。 */
export function authMessage(nonce: string, role: string, id: string, signPubB64: string): Uint8Array {
  return utf8(`${AUTH_LABEL}\n${nonce}\n${role}\n${id}\n${signPubB64}`)
}

export function signAuth(secretKey: Uint8Array, nonce: string, role: string, id: string, signPubB64: string): Uint8Array {
  return ed25519.sign(authMessage(nonce, role, id, signPubB64), secretKey)
}

export function verifyAuth(publicKey: Uint8Array, sig: Uint8Array, nonce: string, role: string, id: string, signPubB64: string): boolean {
  return ed25519.verify(sig, authMessage(nonce, role, id, signPubB64), publicKey)
}

export interface HandshakeInput {
  myStaticPriv: Uint8Array
  myEphPriv: Uint8Array
  peerStaticPub: Uint8Array
  peerEphPub: Uint8Array
}

export interface HandshakeResult {
  /** 本端长期公钥的字节序更小。发送密钥取 low→high。 */
  lowIsMe: boolean
  ikm: Uint8Array
  info: Uint8Array
  lowToHigh: Uint8Array
  highToLow: Uint8Array
  sendKey: Uint8Array
  recvKey: Uint8Array
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(priv, pub)
}

/**
 * 一次连接的密钥协商。四次 X25519 按「公钥更小的一方为 low」固定顺序拼接，
 * 两边算出同一份 IKM，再 HKDF-SHA256 出两个方向的 AES-256 密钥。
 * 中转站不参与，也看不到这些密钥。
 */
export function handshake(input: HandshakeInput): HandshakeResult {
  const myStaticPub = x25519.getPublicKey(input.myStaticPriv)
  const myEphPub = x25519.getPublicKey(input.myEphPriv)
  const lowIsMe = compareBytes(myStaticPub, input.peerStaticPub) < 0
  const staticLow = lowIsMe ? myStaticPub : input.peerStaticPub
  const staticHigh = lowIsMe ? input.peerStaticPub : myStaticPub
  const ephLow = lowIsMe ? myEphPub : input.peerEphPub
  const ephHigh = lowIsMe ? input.peerEphPub : myEphPub
  const ss1 = dh(input.myEphPriv, input.peerEphPub)
  const ss2 = lowIsMe ? dh(input.myEphPriv, input.peerStaticPub) : dh(input.myStaticPriv, input.peerEphPub)
  const ss3 = lowIsMe ? dh(input.myStaticPriv, input.peerEphPub) : dh(input.myEphPriv, input.peerStaticPub)
  const ss4 = dh(input.myStaticPriv, input.peerStaticPub)
  const ikm = concatBytes(ss1, ss2, ss3, ss4)
  const info = concatBytes(utf8(`${E2E_LABEL}|`), staticLow, staticHigh, ephLow, ephHigh)
  const okm = hkdf(sha256, ikm, SALT, info, 64)
  const lowToHigh = okm.slice(0, 32)
  const highToLow = okm.slice(32, 64)
  return {
    lowIsMe,
    ikm,
    info,
    lowToHigh,
    highToLow,
    sendKey: lowIsMe ? lowToHigh : highToLow,
    recvKey: lowIsMe ? highToLow : lowToHigh,
  }
}

export function aadFor(n: number): Uint8Array {
  return utf8(`jeff-frame-v1:${n}`)
}

/** 一个方向一把密钥，计数器只增不减。序号对不上就拒绝，防重放。 */
export class RemoteCipher {
  private sendN = 0
  private recvN = 0
  private readonly sendKey: Uint8Array
  private readonly recvKey: Uint8Array
  constructor(sendKey: Uint8Array, recvKey: Uint8Array) {
    this.sendKey = sendKey
    this.recvKey = recvKey
  }

  seal(plain: Uint8Array): { n: number; ct: Uint8Array } {
    const n = this.sendN
    this.sendN += 1
    const ct = gcm(this.sendKey, nonceFor(n), aadFor(n)).encrypt(plain)
    return { n, ct }
  }

  open(n: number, ct: Uint8Array): Uint8Array {
    if (n !== this.recvN) throw new Error(`序号不符：期望 ${this.recvN}，收到 ${n}`)
    const plain = gcm(this.recvKey, nonceFor(n), aadFor(n)).decrypt(ct)
    this.recvN += 1
    return plain
  }

  /** 交给原生层解密后，JS 只前进接收序号，避免两边各解一次。 */
  acceptRecv(n: number): void {
    if (n !== this.recvN) throw new Error(`序号不符：期望 ${this.recvN}，收到 ${n}`)
    this.recvN += 1
  }

  snapshotRecv(): { recvKey: string; recvN: number } {
    return { recvKey: bytesToB64(this.recvKey), recvN: this.recvN }
  }
}

const BOOT_LABEL = 'jeff-remote-boot-v1'

/**
 * 临时公钥交换之前，用双方长期 X25519 算出一把引导密钥。
 * 中转站看得到长期公钥，但没有私钥，读不了也改不了这层密文。
 */
export function bootCipher(myStaticPriv: Uint8Array, peerStaticPub: Uint8Array): RemoteCipher {
  const myPub = x25519.getPublicKey(myStaticPriv)
  const ss = x25519.getSharedSecret(myStaticPriv, peerStaticPub)
  const lowIsMe = compareBytes(myPub, peerStaticPub) < 0
  const info = concatBytes(utf8(`${BOOT_LABEL}|`), lowIsMe ? myPub : peerStaticPub, lowIsMe ? peerStaticPub : myPub)
  const okm = hkdf(sha256, ss, utf8(BOOT_LABEL), info, 64)
  const lowToHigh = okm.subarray(0, 32)
  const highToLow = okm.subarray(32, 64)
  return new RemoteCipher(lowIsMe ? lowToHigh : highToLow, lowIsMe ? highToLow : lowToHigh)
}

/** 两边公钥派生的 6 位安全码，配对时人眼核对。顺序无关。 */
export function safetyCode(pubA: Uint8Array, pubB: Uint8Array): string {
  const [x, y] = compareBytes(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA]
  const hash = sha256(concatBytes(utf8('jeff-safety-v1'), x, y))
  const n = ((hash[0] << 16) | (hash[1] << 8) | hash[2]) % 1_000_000
  return String(n).padStart(6, '0')
}

/** 固定私钥。Kotlin 用同一组字节重算，对上 fixtures 里的每个字段。 */
export const FIXTURE_PRIV = {
  aliceStatic: hexToBytes('11'.repeat(32)),
  aliceEph: hexToBytes('22'.repeat(32)),
  bobStatic: hexToBytes('33'.repeat(32)),
  bobEph: hexToBytes('44'.repeat(32)),
}

export interface CryptoFixture {
  aliceStaticPub: string
  aliceEphPub: string
  bobStaticPub: string
  bobEphPub: string
  aliceIsLow: boolean
  ikm: string
  info: string
  lowToHigh: string
  highToLow: string
  nonce0: string
  nonce1: string
  aad0: string
  plaintext: string
  ciphertext0: string
  ciphertext1: string
  safety: string
}

export function referenceFixture(): CryptoFixture {
  const aliceStaticPub = x25519.getPublicKey(FIXTURE_PRIV.aliceStatic)
  const aliceEphPub = x25519.getPublicKey(FIXTURE_PRIV.aliceEph)
  const bobStaticPub = x25519.getPublicKey(FIXTURE_PRIV.bobStatic)
  const bobEphPub = x25519.getPublicKey(FIXTURE_PRIV.bobEph)
  const hs = handshake({
    myStaticPriv: FIXTURE_PRIV.aliceStatic,
    myEphPriv: FIXTURE_PRIV.aliceEph,
    peerStaticPub: bobStaticPub,
    peerEphPub: bobEphPub,
  })
  const plain = utf8('{"t":"ping","n":1}')
  const box = new RemoteCipher(hs.sendKey, hs.recvKey)
  const s0 = box.seal(plain)
  const s1 = box.seal(plain)
  return {
    aliceStaticPub: bytesToHex(aliceStaticPub),
    aliceEphPub: bytesToHex(aliceEphPub),
    bobStaticPub: bytesToHex(bobStaticPub),
    bobEphPub: bytesToHex(bobEphPub),
    aliceIsLow: hs.lowIsMe,
    ikm: bytesToHex(hs.ikm),
    info: bytesToHex(hs.info),
    lowToHigh: bytesToHex(hs.lowToHigh),
    highToLow: bytesToHex(hs.highToLow),
    nonce0: bytesToHex(nonceFor(0)),
    nonce1: bytesToHex(nonceFor(1)),
    aad0: utf8Decode(aadFor(0)),
    plaintext: utf8Decode(plain),
    ciphertext0: bytesToHex(s0.ct),
    ciphertext1: bytesToHex(s1.ct),
    safety: safetyCode(aliceStaticPub, bobStaticPub),
  }
}

export { b64ToBytes, bytesToB64, bytesToHex, hexToBytes } from './bytes.js'
