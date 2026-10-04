import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { IPC } from '../src/ipc/contract.js'
import { bytesToHex, utf8Decode } from '../src/remote/bytes.js'
import os from 'node:os'
import {
  FIXTURE_PRIV,
  RELAY_CERT_SHA256,
  RELAY_URL,
  REMOTE_POLICY,
  remoteRequestTimeout,
  RemoteCipher,
  decodePairingQr,
  encodePairingQr,
  applyRemoteStream,
  createChatStreamGate,
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
import { listDirs, makeDir } from '../src/remote/dirs.js'

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

  it('原生层解开后，JS 只前进接收序号', () => {
    const alicePub = hexToBytes(fixture.aliceStaticPub)
    const aliceEph = hexToBytes(fixture.aliceEphPub)
    const bob = handshake({
      myStaticPriv: FIXTURE_PRIV.bobStatic,
      myEphPriv: FIXTURE_PRIV.bobEph,
      peerStaticPub: alicePub,
      peerEphPub: aliceEph,
    })
    const box = new RemoteCipher(bob.sendKey, bob.recvKey)
    expect(box.snapshotRecv()).toMatchObject({ recvN: 0 })
    box.acceptRecv(0)
    expect(box.snapshotRecv().recvN).toBe(1)
    expect(() => box.acceptRecv(0)).toThrow(/序号不符/)
    expect(utf8Decode(box.open(1, hexToBytes(fixture.ciphertext1)))).toBe(fixture.plaintext)
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

describe('配对码', () => {
  const full = {
    relay: 'ws://127.0.0.1:9',
    certSha256: 'TEST',
    desktopId: 'desk',
    desktopName: '家里的电脑',
    desktopX25519Pub: 'abc',
    token: 'tok',
  }

  it('正式环境省略中转站地址，旧的完整 JSON 仍能粘贴', () => {
    const compact = encodePairingQr({ ...full, relay: RELAY_URL, certSha256: RELAY_CERT_SHA256 })
    expect(compact).not.toContain('relay')
    expect(compact).not.toContain('certSha256')
    expect(decodePairingQr(compact)).toEqual({ ...full, relay: RELAY_URL, certSha256: RELAY_CERT_SHA256 })
    expect(decodePairingQr(`请粘贴：\n${JSON.stringify(full)}\n`)).toEqual(full)
    expect(() => decodePairingQr('不是绑定码')).toThrow(/绑定码不是配对内容/)
  })

  it('缺了电脑身份时说明缺哪个字段', () => {
    expect(() => decodePairingQr('{"token":"tok"}')).toThrow(/desktopId/)
  })
})

describe('远程白名单', () => {
  it('宣传选题状态机允许手机经加密 IPC 调用', () => {
    expect(REMOTE_POLICY[IPC.projectCampaign]).toEqual({ policy: 'allow' })
    expect(REMOTE_POLICY[IPC.projectReport]).toEqual({ policy: 'allow' })
    expect(REMOTE_POLICY[IPC.siyuanSearch]).toEqual({ policy: 'allow' })
    expect(REMOTE_POLICY[IPC.siyuanExport]).toEqual({ policy: 'allow' })
  })
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
      [
        'browser:pageShot',
        'browser:result',
        'browser:state',
        'debugLog:openDir',
        'notify:desktop',
        'remote:focus',
        'remote:pairConfirm',
        'remote:pairStart',
        'remote:reconnect',
        'remote:settings',
        'remote:status',
        'remote:unbind',
        'siyuan:configGet',
        'siyuan:configSave',
        'smoke:done',
        'smoke:shot',
      ].sort(),
    )
    expect(of('replace')).toEqual(['dialog:pickDir', 'fs:openPath', 'plugin:import'].sort())
  })
})

describe('手机远程调用超时', () => {
  it('报告模型生成走长任务时限，配置保存仍使用普通请求时限', () => {
    expect(remoteRequestTimeout(IPC.projectReport, { action: 'generate' })).toBe(95 * 60 * 1000)
    expect(remoteRequestTimeout(IPC.projectReport, { action: 'save_template' })).toBe(30_000)
    expect(remoteRequestTimeout(IPC.groupSend, {})).toBe(95 * 60 * 1000)
    expect(remoteRequestTimeout(IPC.projectReport, { action: 'generate' }, 5_000)).toBe(5_000)
  })
})

describe('流式增量', () => {
  it('延伸文本只取增量，中途被替换则重置', () => {
    expect(streamDelta('你好', '你好世界')).toEqual({ reset: false, delta: '世界' })
    expect(streamDelta('你好世界', '你好')).toEqual({ reset: true, delta: '你好' })
  })

  it('累计全文收成增量，结束帧带长度', () => {
    let t = 0
    const gate = createChatStreamGate(180, () => t)
    const base = { kind: 'private' as const, agentId: 'a', messageId: 'm', tools: undefined, done: false }
    expect(gate.push({ ...base, text: '你', reasoning: '' })).toMatchObject({ textDelta: '你', textLen: 1, done: false })
    t = 20
    expect(gate.push({ ...base, text: '你好', reasoning: '' })).toBeNull()
    t = 200
    const mid = gate.push({ ...base, text: '你好世界', reasoning: '想' })
    expect(mid).toMatchObject({ reset: false, textDelta: '好世界', reasoningDelta: '想', textLen: 4, done: false })
    const acc = applyRemoteStream({ text: '你', reasoning: '' }, mid!)
    expect(acc).toEqual({ text: '你好世界', reasoning: '想', ok: true })
    const done = gate.push({ ...base, text: '', reasoning: '', done: true })
    expect(done).toMatchObject({ textDelta: '', textLen: 4, reasoningLen: 1, done: true })
  })

  it('目录列表只含子目录，新建文件夹落在父目录下', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jeff-dirs-'))
    try {
      fs.mkdirSync(path.join(root, 'box'))
      fs.writeFileSync(path.join(root, 'note.txt'), 'x')
      fs.mkdirSync(path.join(root, '.hidden'))
      const listed = listDirs(root)
      expect(listed.entries.map((e) => e.name)).toEqual(['box'])
      const created = makeDir(path.join(root, 'box', 'inner'))
      expect(fs.statSync(created).isDirectory()).toBe(true)
      expect(() => makeDir(path.join(root, 'missing', 'nope'))).toThrow(/上级目录不存在/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
