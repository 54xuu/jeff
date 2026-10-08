import crypto from 'node:crypto'

function readArchive(data) {
  if (!Buffer.isBuffer(data) || data.length < 16) throw new Error('ASAR archive is too short')
  const pickleSize = data.readUInt32LE(4)
  const jsonSize = data.readUInt32LE(12)
  const jsonStart = 16
  const jsonEnd = jsonStart + jsonSize
  const dataStart = 8 + pickleSize
  if (jsonEnd > data.length || dataStart < jsonEnd || dataStart > data.length) {
    throw new Error('ASAR header boundaries are invalid')
  }
  let header
  try {
    header = JSON.parse(data.subarray(jsonStart, jsonEnd).toString('utf8'))
  } catch (error) {
    throw new Error(`ASAR header JSON is invalid: ${error.message}`)
  }
  if (!header.files || typeof header.files !== 'object') throw new Error('ASAR header has no root files')
  return { header, dataStart }
}

export function verifyAsarBuffer(data, { expectedVersion, expectedMain } = {}) {
  const { header, dataStart } = readArchive(data)
  const files = []
  const walk = (nodes, prefix = '') => {
    for (const [name, entry] of Object.entries(nodes)) {
      const filePath = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry.files, filePath)
      else if (entry.link) continue
      else if (Object.hasOwn(entry, 'offset')) files.push({ filePath, entry })
    }
  }
  walk(header.files)
  const failures = []
  const ranges = []
  const contents = new Map()
  for (const { filePath, entry } of files) {
    const offset = Number(entry.offset)
    const size = entry.size
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 0) {
      failures.push({ path: filePath, reason: 'invalid offset or size' })
      continue
    }
    const start = dataStart + offset
    const end = start + size
    if (end > data.length || end < start) {
      failures.push({ path: filePath, reason: 'file extends beyond ASAR data' })
      continue
    }
    const content = data.subarray(start, end)
    const expectedHash = entry.integrity?.hash
    if (content.length !== size) failures.push({ path: filePath, reason: 'stored size mismatch' })
    if (!/^[a-f\d]{64}$/i.test(expectedHash || '')) {
      failures.push({ path: filePath, reason: 'missing SHA-256 integrity metadata' })
    } else {
      const actualHash = crypto.createHash('sha256').update(content).digest('hex')
      if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) failures.push({ path: filePath, reason: 'SHA-256 mismatch' })
    }
    ranges.push({ path: filePath, start, end })
    contents.set(filePath, content)
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) failures.push({ path: ranges[i].path, reason: `overlaps ${ranges[i - 1].path}` })
  }

  let packageJson
  const packageBytes = contents.get('package.json')
  if (!packageBytes) failures.push({ path: 'package.json', reason: 'root package.json is missing or unreadable' })
  else {
    try { packageJson = JSON.parse(packageBytes.toString('utf8')) }
    catch (error) { failures.push({ path: 'package.json', reason: `invalid JSON: ${error.message}` }) }
  }
  if (packageJson && expectedVersion && packageJson.version !== expectedVersion) {
    failures.push({ path: 'package.json', reason: `version ${packageJson.version} does not match ${expectedVersion}` })
  }
  if (packageJson && expectedMain && packageJson.main !== expectedMain) {
    failures.push({ path: 'package.json', reason: `main ${packageJson.main} does not match ${expectedMain}` })
  }
  if (files.length === 0) failures.push({ path: '<archive>', reason: 'no file entries found' })

  return {
    ok: failures.length === 0,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    entries: files.length,
    failures,
    package: packageJson ? { version: packageJson.version, main: packageJson.main } : undefined,
  }
}
