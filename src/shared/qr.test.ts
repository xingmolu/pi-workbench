import { describe, expect, it } from 'vitest'
import { encodeQrMatrix, renderQrSvg } from './qr'

describe('pairing QR', () => {
  it('encodes a LAN pairing URL with finder patterns', () => {
    const url = 'http://192.168.1.8:43124/?pair=ABCD2345'
    const matrix = encodeQrMatrix(url)
    expect(matrix.length).toBeGreaterThanOrEqual(21)
    expect(matrix.length % 2).toBe(1)
    expect(matrix[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true])
    expect(matrix[1]?.slice(0, 7)).toEqual([true, false, false, false, false, false, true])
    const other = encodeQrMatrix(url.replace('ABCD2345', 'EFGH6789'))
    expect(other).not.toEqual(matrix)
    const svg = renderQrSvg(matrix)
    expect(svg).toContain('<svg')
    expect(svg).toContain('rect')
  })
})
