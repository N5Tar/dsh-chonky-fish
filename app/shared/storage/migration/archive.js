import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { LIMITS } from '../../../../core/contracts/spec.js'
import { migrationFail } from '../../../../core/modules/migration/policy.js'

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0 }
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
export const sha256 = buffer => createHash('sha256').update(buffer).digest('hex')
const u16 = (b, n) => b.readUInt16LE(n)
const u32 = (b, n) => b.readUInt32LE(n)

// ZIP writer deliberately emits uncompressed entries. This keeps the implementation
// dependency-free and avoids decompression bombs on files produced by this plugin.
export function createZip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const [name, dataValue] of entries) {
    const nameBytes = Buffer.from(name, 'utf8')
    const data = Buffer.isBuffer(dataValue) ? dataValue : Buffer.from(dataValue)
    if (!name || nameBytes.length > 1024 || data.length > 0xffffffff) migrationFail('LIMIT_EXCEEDED')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); nameBytes.copy(local, 30)
    locals.push(local, data)
    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42); nameBytes.copy(central, 46)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0)
  if (entries.length > 0xffff || offset + centralSize > 0xffffffff) migrationFail('LIMIT_EXCEEDED')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

const safePath = name => typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !/^[A-Za-z]:/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..')

export function readZip(buffer, { maxArchiveBytes = LIMITS.migrationArchiveBytes, maxExpandedBytes = LIMITS.migrationExpandedBytes, maxEntries = 10000, maxRatio = 200 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length > maxArchiveBytes || buffer.length < 22) migrationFail('LIMIT_EXCEEDED')
  let eocd = -1
  const begin = Math.max(0, buffer.length - 65557)
  for (let i = buffer.length - 22; i >= begin; i--) if (u32(buffer, i) === 0x06054b50) { eocd = i; break }
  if (eocd < 0 || u16(buffer, eocd + 4) !== 0 || u16(buffer, eocd + 6) !== 0) migrationFail('INVALID_ARCHIVE')
  const count = u16(buffer, eocd + 10), centralSize = u32(buffer, eocd + 12), centralOffset = u32(buffer, eocd + 16), commentLength = u16(buffer, eocd + 20)
  if (eocd + 22 + commentLength !== buffer.length || commentLength !== 0 || count !== u16(buffer, eocd + 8) || count > maxEntries || centralOffset + centralSize !== eocd) migrationFail(count > maxEntries ? 'LIMIT_EXCEEDED' : 'INVALID_ARCHIVE')
  const out = new Map(), folded = new Set(), localOffsets = new Set()
  let pos = centralOffset, expanded = 0
  for (let i = 0; i < count; i++) {
    if (pos + 46 > eocd || u32(buffer, pos) !== 0x02014b50) migrationFail('INVALID_ARCHIVE')
    const flags = u16(buffer, pos + 8), method = u16(buffer, pos + 10), crc = u32(buffer, pos + 16), compressed = u32(buffer, pos + 20), size = u32(buffer, pos + 24)
    const nameLen = u16(buffer, pos + 28), extraLen = u16(buffer, pos + 30), commentLen = u16(buffer, pos + 32), external = u32(buffer, pos + 38), localOffset = u32(buffer, pos + 42)
    if (flags & 1 || flags & 8 || ![0, 8].includes(method) || localOffsets.has(localOffset)) migrationFail('INVALID_ARCHIVE')
    localOffsets.add(localOffset)
    let name
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(pos + 46, pos + 46 + nameLen)) } catch { migrationFail('INVALID_ARCHIVE') }
    if (!safePath(name) || name.endsWith('/') || out.has(name) || folded.has(name.toLowerCase())) migrationFail('UNSAFE_PATH')
    // Reject Unix symlinks and non-regular special files.
    const host = u16(buffer, pos + 4), mode = external >>> 16, type = mode & 0xf000
    if (host === 3 && type && type !== 0x8000) migrationFail('UNSAFE_PATH')
    if (size > maxExpandedBytes || compressed === 0 && size > 0 || compressed && size / compressed > maxRatio) migrationFail('LIMIT_EXCEEDED')
    expanded += size
    if (expanded > maxExpandedBytes) migrationFail('LIMIT_EXCEEDED')
    pos += 46 + nameLen + extraLen + commentLen
    if (pos > eocd || localOffset + 30 > centralOffset || u32(buffer, localOffset) !== 0x04034b50) migrationFail('INVALID_ARCHIVE')
    const localFlags = u16(buffer, localOffset + 6), localMethod = u16(buffer, localOffset + 8)
    const localName = u16(buffer, localOffset + 26), localExtra = u16(buffer, localOffset + 28), start = localOffset + 30 + localName + localExtra
    let localNameText
    try { localNameText = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(localOffset + 30, localOffset + 30 + localName)) } catch { migrationFail('INVALID_ARCHIVE') }
    if (localFlags !== flags || localMethod !== method || localNameText !== name || start + compressed > centralOffset) migrationFail('INVALID_ARCHIVE')
    const payload = buffer.subarray(start, start + compressed)
    let data
    try { data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: maxExpandedBytes }) } catch { migrationFail('INVALID_ARCHIVE') }
    if (data.length !== size || crc32(data) !== crc) migrationFail('INVALID_ARCHIVE')
    out.set(name, data); folded.add(name.toLowerCase())
  }
  if (pos !== eocd) migrationFail('INVALID_ARCHIVE')
  return out
}

export function parseJson(buffer) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) } catch { migrationFail('INVALID_DATA') }
}

export { crc32 }
