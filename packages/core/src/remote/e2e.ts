import { bytesToB64, b64ToBytes, utf8, utf8Decode } from './bytes.js'
import { RemoteCipher } from './crypto.js'

/** 端到端明文。中转站只看到 seal 之后的 body。 */
export type E2ePlain =
  | { t: 'hs'; eph: string }
  | { t: 'req'; id: string; ch: string; p?: unknown }
  | { t: 'res'; id: string; ok: boolean; r?: unknown; e?: string }
  | { t: 'push'; what: string; p?: unknown }

export function sealPlain(box: RemoteCipher, msg: E2ePlain): string {
  const { n, ct } = box.seal(utf8(JSON.stringify(msg)))
  return JSON.stringify({ n, ct: bytesToB64(ct) })
}

export function openPlain(box: RemoteCipher, body: string): E2ePlain {
  const wrap = JSON.parse(body) as { n?: unknown; ct?: unknown }
  if (typeof wrap.n !== 'number' || typeof wrap.ct !== 'string') throw new Error('密文封套非法')
  const json = utf8Decode(box.open(wrap.n, b64ToBytes(wrap.ct)))
  const msg = JSON.parse(json) as E2ePlain
  if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') throw new Error('明文帧非法')
  return msg
}
