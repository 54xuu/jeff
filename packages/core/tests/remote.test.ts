import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '../src/ipc/contract.js'
import { bytesToHex, utf8Decode } from '../src/remote/bytes.js'
import {
  FIXTURE_PRIV,
  REMOTE_POLICY,
  RemoteCipher,
  createStreamCoalescer,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  handshake,
  hexToBytes,
  referenceFixture,
  safetyCode,
  streamDelta,
} from '../src/remote/index.js'

describe('远程加密', () => {
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/remote-crypto-vectors.json')
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

  it('实现与提交的测试向量一致（Kotlin 用同一份文件）', () => {
    expect(referenceFixture()).toEqual(fixture)
  })

  it('对端用自己的接收密钥解开，重放序号会被拒绝', () => {
    const alicePub = hexToBytes(fixture.aliceStaticPub)
    const aliceEph = hexToBytes(fixture.aliceEphPub)
    const bob = handshake({
      myStaticPriv: FIXTURE_PRIV.bobStatic,
      myEphPriv: FIXTURE_PRIV.bobEph,
      peerStaticPub: alicePub,
      peerEphPub: aliceEph,
    })
    expect(bob.lowIsMe).toBe(true)
    expect(bytesToHex(bob.recvKey)).toBe(fixture.highToLow)
    const box = new RemoteCipher(bob.sendKey, bob.recvKey)
    expect(utf8Decode(box.open(0, hexToBytes(fixture.ciphertext0)))).toBe(fixture.plaintext)
    expect(utf8Decode(box.open(1, hexToBytes(fixture.ciphertext1)))).toBe(fixture.plaintext)
    expect(() => box.open(1, hexToBytes(fixture.ciphertext1))).toThrow(/序号不符/)
  })

  it('安全码与公钥顺序无关', () => {
    const a = hexToBytes(fixture.aliceStaticPub)
    const b = hexToBytes(fixture.bobStaticPub)
    expect(safetyCode(a, b)).toBe(fixture.safety)
    expect(safetyCode(b, a)).toBe(fixture.safety)
  })
})

describe('远程帧', () => {
  it('客户端帧往返，缺字段则拒绝', () => {
    const raw = encodeFrame({ t: 'ping' })
    expect(decodeClientFrame(raw)).toEqual({ t: 'ping' })
    expect(() => decodeClientFrame('{"t":"pair-open"}')).toThrow(/desktopName/)
    expect(() => decodeServerFrame(raw)).toThrow(/不是服务端帧/)
  })
})

describe('远程白名单', () => {
  it('每个 IPC 通道恰好一条规则', () => {
    const channels = Object.values(IPC)
    expect(new Set(channels).size).toBe(channels.length)
    expect(Object.keys(REMOTE_POLICY).sort()).toEqual([...channels].sort())
  })

  it('本机专属通道保持拒绝或替换', () => {
    const of = (policy: string) =>
      Object.entries(REMOTE_POLICY)
        .filter(([, r]) => r.policy === policy)
        .map(([k]) => k)
        .sort()
    expect(of('deny')).toEqual(
      ['browser:pageShot', 'browser:result', 'browser:state', 'debugLog:openDir', 'notify:desktop', 'smoke:done', 'smoke:shot'].sort(),
    )
    expect(of('replace')).toEqual(['dialog:pickDir', 'fs:openPath', 'plugin:import'].sort())
  })
})

describe('流式增量', () => {
  it('延伸文本只取增量，中途被替换则重置', () => {
    expect(streamDelta('你好', '你好世界')).toEqual({ reset: false, delta: '世界' })
    expect(streamDelta('你好世界', '你好')).toEqual({ reset: true, delta: '你好' })
  })

  it('未到间隔先攒着，force 立刻吐出', () => {
    let t = 0
    const c = createStreamCoalescer(200, () => t)
    expect(c.push('a', false)).toEqual({ reset: false, delta: 'a' })
    t = 50
    expect(c.push('b', false)).toBeNull()
    t = 80
    expect(c.push('新', true)).toBeNull()
    expect(c.push('', false, true)).toEqual({ reset: true, delta: '新' })
  })
})
