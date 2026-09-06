#!/usr/bin/env node
// 生成 Jeff 应用图标（纯 Node PNG 编码，无外部依赖）
// 设计（v1.2，参考 zcode 风格）：绿底圆角方块 + 白色粗体「JF」字
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build')

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

/** 圆角矩形内测 */
function inRoundedRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r || (x >= r && x < size - r) || (y >= r && y < size - r)
}

// 「JF」字母几何（相对坐标矩形 [x, y, w, h]），粗体无衬线风格
const JF_RECTS = [
  // J：右侧竖笔 + 底部横笔 + 左侧短扬
  [0.36, 0.26, 0.095, 0.48],
  [0.225, 0.645, 0.23, 0.095],
  [0.225, 0.50, 0.095, 0.24],
  // F：左竖笔 + 顶横 + 中横
  [0.545, 0.26, 0.095, 0.48],
  [0.545, 0.26, 0.245, 0.095],
  [0.545, 0.44, 0.205, 0.095],
]

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const S = size
  const green = [0x07, 0xc1, 0x60]
  const greenDark = [0x06, 0xad, 0x56]
  const white = [255, 255, 255]
  const cornerR = S * 0.22
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4
      if (!inRoundedRect(x, y, S, cornerR)) continue // 透明背景
      // 渐变绿底
      const t = (x + y) / (2 * S)
      const inLetter = JF_RECTS.some(([rx, ry, rw, rh]) => x >= rx * S && x < (rx + rw) * S && y >= ry * S && y < (ry + rh) * S)
      const base = [
        Math.round(green[0] + (greenDark[0] - green[0]) * t * 0.6),
        Math.round(green[1] + (greenDark[1] - green[1]) * t * 0.6),
        Math.round(green[2] + (greenDark[2] - green[2]) * t * 0.6),
      ]
      const c = inLetter ? white : base
      rgba[i] = c[0]
      rgba[i + 1] = c[1]
      rgba[i + 2] = c[2]
      rgba[i + 3] = 255
    }
  }
  return encodePng(S, S, rgba)
}

fs.mkdirSync(outDir, { recursive: true })
for (const size of [512, 256, 128, 64, 32]) {
  fs.writeFileSync(path.join(outDir, `icon-${size}.png`), drawIcon(size))
}
fs.copyFileSync(path.join(outDir, 'icon-512.png'), path.join(outDir, 'icon.png'))
fs.copyFileSync(path.join(outDir, 'icon-32.png'), path.join(outDir, 'tray.png'))
console.log('[gen-icon] 生成完成 →', outDir)
