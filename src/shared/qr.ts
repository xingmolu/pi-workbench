import { t } from './i18n'
/** Byte-mode QR (ECC L, versions 1–10) for pairing URLs. */

const ECC_CODEWORDS = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18]
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const ECC_BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4]
const GROUP2_BLOCKS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]
const ALIGNMENT = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
]
const FORMAT_L = [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976]
const VERSION_INFO = [0, 0, 0, 0, 0, 0, 0, 0x07c94, 0x08e0a, 0x09a4a, 0x0a4d3]

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(() => {
  let value = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = value
    LOG[value] = i
    value <<= 1
    if (value & 0x100) value ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
})()

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

function rsGenerator(count: number): number[] {
  const poly = [1]
  for (let i = 0; i < count; i++) {
    const next = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], EXP[i])
    }
    poly.length = 0
    poly.push(...next)
  }
  return poly
}

function rsEncode(data: number[], eccCount: number): number[] {
  const generator = rsGenerator(eccCount)
  const ecc = new Array<number>(eccCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ ecc[0]
    ecc.shift()
    ecc.push(0)
    if (!factor) continue
    for (let i = 0; i < eccCount; i++) ecc[i] ^= gfMul(generator[i + 1], factor)
  }
  return ecc
}

function versionFor(payload: Uint8Array): number {
  for (let version = 1; version <= 10; version++) {
    const total = TOTAL_CODEWORDS[version]!
    const eccPerBlock = ECC_CODEWORDS[version]!
    const blocks = ECC_BLOCKS[version]!
    const dataCapacity = total - eccPerBlock * blocks
    const countBits = version <= 9 ? 8 : 16
    const bits = 4 + countBits + payload.length * 8 + 4
    if (Math.ceil(bits / 8) <= dataCapacity) return version
  }
  throw new Error(t('配对内容过长，无法生成二维码'))
}

function encodeData(payload: Uint8Array, version: number): number[] {
  const total = TOTAL_CODEWORDS[version]!
  const blocks = ECC_BLOCKS[version]!
  const eccPerBlock = ECC_CODEWORDS[version]!
  const dataCapacity = total - eccPerBlock * blocks
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1)
  }
  push(0b0100, 4)
  push(payload.length, version <= 9 ? 8 : 16)
  for (const byte of payload) push(byte, 8)
  const capacityBits = dataCapacity * 8
  const terminator = Math.min(4, capacityBits - bits.length)
  push(0, terminator)
  while (bits.length % 8) bits.push(0)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j]!
    bytes.push(value)
  }
  const pads = [0xec, 0x11]
  let pad = 0
  while (bytes.length < dataCapacity) bytes.push(pads[pad++ % 2]!)
  return bytes.slice(0, dataCapacity)
}

function interleave(data: number[], version: number): number[] {
  const blocks = ECC_BLOCKS[version]!
  const group2 = GROUP2_BLOCKS[version]!
  const group1 = blocks - group2
  const eccPerBlock = ECC_CODEWORDS[version]!
  const total = TOTAL_CODEWORDS[version]!
  const dataCapacity = total - eccPerBlock * blocks
  const shortLen = Math.floor(dataCapacity / blocks)
  const longLen = shortLen + 1
  const groups: number[][] = []
  let offset = 0
  for (let i = 0; i < group1; i++) {
    groups.push(data.slice(offset, offset + shortLen))
    offset += shortLen
  }
  for (let i = 0; i < group2; i++) {
    groups.push(data.slice(offset, offset + longLen))
    offset += longLen
  }
  const eccBlocks = groups.map((block) => rsEncode(block, eccPerBlock))
  const maxData = Math.max(...groups.map((block) => block.length))
  const out: number[] = []
  for (let i = 0; i < maxData; i++) {
    for (const block of groups) if (i < block.length) out.push(block[i]!)
  }
  for (let i = 0; i < eccPerBlock; i++) {
    for (const block of eccBlocks) out.push(block[i]!)
  }
  return out
}

function moduleSize(version: number): number {
  return 21 + 4 * (version - 1)
}

function reserved(version: number): boolean[][] {
  const size = moduleSize(version)
  const mark = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const set = (row: number, col: number): void => {
    if (row >= 0 && col >= 0 && row < size && col < size) mark[row]![col] = true
  }
  const finder = (row: number, col: number): void => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) set(row + r, col + c)
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)
  for (let i = 0; i < size; i++) {
    set(6, i)
    set(i, 6)
  }
  for (const row of ALIGNMENT[version] ?? []) {
    for (const col of ALIGNMENT[version] ?? []) {
      if (
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6)
      )
        continue
      for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) set(row + r, col + c)
    }
  }
  for (let i = 0; i < 9; i++) {
    set(8, i)
    set(i, 8)
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i)
    set(size - 1 - i, 8)
  }
  set(8, 8)
  if (version >= 7) {
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        set(i, size - 11 + j)
        set(size - 11 + j, i)
      }
  }
  return mark
}

function placeFinders(grid: number[][]): void {
  const size = grid.length
  const draw = (row: number, col: number): void => {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || c === 0 || r === 6 || c === 6
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
        grid[row + r]![col + c] = edge || core ? 1 : 0
      }
  }
  draw(0, 0)
  draw(0, size - 7)
  draw(size - 7, 0)
}

function placeTiming(grid: number[][]): void {
  const size = grid.length
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0
    grid[6]![i] = bit
    grid[i]![6] = bit
  }
}

function placeAlignments(grid: number[][], version: number): void {
  const size = grid.length
  const pattern = [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1]
  for (const row of ALIGNMENT[version] ?? []) {
    for (const col of ALIGNMENT[version] ?? []) {
      if (
        (row === 6 && col === 6) ||
        (row === 6 && col === size - 7) ||
        (row === size - 7 && col === 6)
      )
        continue
      let i = 0
      for (let r = -2; r <= 2; r++)
        for (let c = -2; c <= 2; c++) grid[row + r]![col + c] = pattern[i++]!
    }
  }
}

function placeFormat(grid: number[][], mask: number): void {
  const size = grid.length
  const bits = FORMAT_L[mask]!
  for (let i = 0; i < 15; i++) {
    const bit = (bits >> (14 - i)) & 1
    if (i < 6) grid[i]![8] = bit
    else if (i < 8) grid[i + 1]![8] = bit
    else grid[size - 15 + i]![8] = bit
    if (i < 8) grid[8]![size - 1 - i] = bit
    else if (i === 8) grid[8]![7] = bit
    else grid[8]![14 - i] = bit
  }
  grid[size - 8]![8] = 1
}

function placeVersion(grid: number[][], version: number): void {
  if (version < 7) return
  const bits = VERSION_INFO[version]!
  const size = grid.length
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1
    const row = Math.floor(i / 3)
    const col = i % 3
    grid[row]![size - 11 + col] = bit
    grid[size - 11 + col]![row] = bit
  }
}

function maskFn(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (row + col) % 3 === 0
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0
  }
}

function placeData(
  grid: number[][],
  reservedMap: boolean[][],
  bytes: number[],
  mask: number
): void {
  const size = grid.length
  const bits: number[] = []
  for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  let index = 0
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const offset of [0, 1]) {
        const c = col - offset
        if (reservedMap[row]![c]) continue
        const bit = index < bits.length ? bits[index]! : 0
        index++
        grid[row]![c] = bit ^ (maskFn(mask, row, c) ? 1 : 0)
      }
    }
    upward = !upward
  }
}

function penalty(grid: number[][]): number {
  const size = grid.length
  let score = 0
  for (let row = 0; row < size; row++) {
    let run = 1
    for (let col = 1; col <= size; col++) {
      if (col < size && grid[row]![col] === grid[row]![col - 1]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
  }
  for (let col = 0; col < size; col++) {
    let run = 1
    for (let row = 1; row <= size; row++) {
      if (row < size && grid[row]![col] === grid[row - 1]![col]) run++
      else {
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
    }
  }
  for (let row = 0; row < size - 1; row++)
    for (let col = 0; col < size - 1; col++) {
      const v = grid[row]![col]
      if (v === grid[row]![col + 1] && v === grid[row + 1]![col] && v === grid[row + 1]![col + 1])
        score += 3
    }
  const finder = [1, 0, 1, 1, 1, 0, 1]
  const hasFinder = (seq: number[]): boolean => {
    for (let i = 0; i <= seq.length - 7; i++) {
      if (finder.every((bit, j) => seq[i + j] === bit)) {
        const left = seq.slice(Math.max(0, i - 4), i)
        const right = seq.slice(i + 7, i + 11)
        if (left.every((bit) => bit === 0) || right.every((bit) => bit === 0)) return true
      }
    }
    return false
  }
  for (let row = 0; row < size; row++) if (hasFinder(grid[row]!)) score += 40
  for (let col = 0; col < size; col++) {
    const seq = grid.map((line) => line[col]!)
    if (hasFinder(seq)) score += 40
  }
  let dark = 0
  for (const row of grid) for (const cell of row) dark += cell
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
  return score
}

export function encodeQrMatrix(text: string): boolean[][] {
  const payload = new TextEncoder().encode(text)
  const version = versionFor(payload)
  const data = encodeData(payload, version)
  const bytes = interleave(data, version)
  const size = moduleSize(version)
  const reservedMap = reserved(version)
  let best: number[][] | null = null
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const grid = Array.from({ length: size }, () => Array<number>(size).fill(0))
    placeFinders(grid)
    placeTiming(grid)
    placeAlignments(grid, version)
    placeFormat(grid, mask)
    placeVersion(grid, version)
    placeData(grid, reservedMap, bytes, mask)
    placeFormat(grid, mask)
    const score = penalty(grid)
    if (score < bestScore) {
      bestScore = score
      best = grid
    }
  }
  return best!.map((row) => row.map((cell) => cell === 1))
}

export function renderQrSvg(matrix: boolean[][], cell = 8, margin = 4): string {
  const size = matrix.length
  const dim = (size + margin * 2) * cell
  const rects: string[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!matrix[row]![col]) continue
      rects.push(
        `<rect x="${(col + margin) * cell}" y="${(row + margin) * cell}" width="${cell}" height="${cell}"/>`
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="${dim}" height="${dim}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">${rects.join('')}</g></svg>`
}
