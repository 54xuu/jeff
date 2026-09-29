import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'

const ROOT = '/home/xujian/cdbox/jeff'
const CAIROSVG = '/home/xujian/.local/bin/cairosvg'

// 1. Base Cue Character SVG snippet
const CUE_CHARACTER = `
    <!-- Dome semicircle green body -->
    <path d="M 18,88 C 14,88 12,84 14,80 C 22,40 40,28 64,28 C 88,28 106,40 114,80 C 116,84 114,88 110,88 Z" fill="#10B981" />

    <!-- Cue eyes -->
    <circle cx="51" cy="62" r="11" fill="#FFFFFF" />
    <circle cx="52" cy="62" r="5.5" fill="#0F172A" />

    <circle cx="77" cy="62" r="11" fill="#FFFFFF" />
    <circle cx="78" cy="62" r="5.5" fill="#0F172A" />

    <!-- Smile -->
    <path d="M 60,76 Q 64,81 69,77" fill="none" stroke="#0F172A" stroke-width="3" stroke-linecap="round" />
`

// 2. SVG templates
// (a) Desktop / Standard app icon (white rounded rectangle)
const SVG_DESKTOP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <rect x="0" y="0" width="512" height="512" rx="112" fill="#FFFFFF" />
  <g transform="translate(38.4, 52) scale(3.4)">
    ${CUE_CHARACTER}
  </g>
</svg>`

// (b) Round icon (white circle) for Android ic_launcher_round
const SVG_ROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <circle cx="256" cy="256" r="256" fill="#FFFFFF" />
  <g transform="translate(38.4, 52) scale(3.4)">
    ${CUE_CHARACTER}
  </g>
</svg>`

// (c) Android Adaptive Icon Foreground (transparent background, scaled inside 66% safe zone)
const SVG_FOREGROUND = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <g transform="translate(76.8, 93.6) scale(2.8)">
    ${CUE_CHARACTER}
  </g>
</svg>`

// (d) Standalone Logo (with white background & transparent variants)
const SVG_STANDALONE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="100%" height="100%">
  ${CUE_CHARACTER}
</svg>`

fs.writeFileSync(path.join(ROOT, '.tmp/icon_desktop.svg'), SVG_DESKTOP)
fs.writeFileSync(path.join(ROOT, '.tmp/icon_round.svg'), SVG_ROUND)
fs.writeFileSync(path.join(ROOT, '.tmp/icon_foreground.svg'), SVG_FOREGROUND)
fs.writeFileSync(path.join(ROOT, 'docs/assets/logo.svg'), SVG_STANDALONE)

// Helper to convert SVG to PNG
function renderPng(svgPath, outPngPath, width, height) {
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true })
  execSync(`${CAIROSVG} "${svgPath}" -o "${outPngPath}" -W ${width} -H ${height}`, { stdio: 'inherit' })
}

// 1. Generate desktop icons
const desktopBuildDir = path.join(ROOT, 'apps/desktop/build')
fs.mkdirSync(desktopBuildDir, { recursive: true })
for (const size of [512, 256, 128, 64, 32]) {
  renderPng(path.join(ROOT, '.tmp/icon_desktop.svg'), path.join(desktopBuildDir, `icon-${size}.png`), size, size)
}
fs.copyFileSync(path.join(desktopBuildDir, 'icon-512.png'), path.join(desktopBuildDir, 'icon.png'))
fs.copyFileSync(path.join(desktopBuildDir, 'icon-32.png'), path.join(desktopBuildDir, 'tray.png'))
console.log('✓ Desktop icons generated.')

// 2. Generate docs assets
renderPng(path.join(ROOT, '.tmp/icon_desktop.svg'), path.join(ROOT, 'docs/assets/logo.png'), 512, 512)
console.log('✓ docs/assets/logo.png generated.')

// 3. Generate Android mipmap icons
const ANDROID_RES = path.join(ROOT, 'apps/mobile/android/app/src/main/res')
const MIPMAPS = [
  { dir: 'mipmap-mdpi', size: 48, fgSize: 108 },
  { dir: 'mipmap-hdpi', size: 72, fgSize: 162 },
  { dir: 'mipmap-xhdpi', size: 96, fgSize: 216 },
  { dir: 'mipmap-xxhdpi', size: 144, fgSize: 324 },
  { dir: 'mipmap-xxxhdpi', size: 192, fgSize: 432 },
]

for (const m of MIPMAPS) {
  const dirPath = path.join(ANDROID_RES, m.dir)
  // ic_launcher.png (legacy standard rounded icon)
  renderPng(path.join(ROOT, '.tmp/icon_desktop.svg'), path.join(dirPath, 'ic_launcher.png'), m.size, m.size)
  // ic_launcher_round.png (legacy round icon)
  renderPng(path.join(ROOT, '.tmp/icon_round.svg'), path.join(dirPath, 'ic_launcher_round.png'), m.size, m.size)
  // ic_launcher_foreground.png (adaptive icon foreground)
  renderPng(path.join(ROOT, '.tmp/icon_foreground.svg'), path.join(dirPath, 'ic_launcher_foreground.png'), m.fgSize, m.fgSize)
}
console.log('✓ Android mipmap icons generated.')
