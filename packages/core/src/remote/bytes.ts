const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** 无符号字节序比较；长度不同时较短者若为前缀则更小 */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex 长度必须为偶数')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToB64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
    s += i + 1 < b.length ? B64[(n >> 6) & 63] : '='
    s += i + 2 < b.length ? B64[n & 63] : '='
  }
  return s
}

export function b64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  if (clean.length % 4 === 1) throw new Error('base64 非法')
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64.indexOf(clean[i]) << 18) |
      ((B64.indexOf(clean[i + 1] ?? 'A')) << 12) |
      ((clean[i + 2] ? B64.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? B64.indexOf(clean[i + 3]) : 0)
    out.push((n >> 16) & 255)
    if (clean[i + 2]) out.push((n >> 8) & 255)
    if (clean[i + 3]) out.push(n & 255)
  }
  return Uint8Array.from(out)
}

/** 12 字节 nonce：前 4 字节为 0，后 8 字节是大端计数器 */
export function nonceFor(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`nonce 计数器非法：${n}`)
  const out = new Uint8Array(12)
  let x = n
  for (let i = 11; i >= 4; i--) {
    out[i] = x % 256
    x = Math.floor(x / 256)
  }
  return out
}
