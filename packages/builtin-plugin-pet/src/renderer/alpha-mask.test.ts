import { describe, expect, it } from 'vitest'
import { alphaRectangles } from './alpha-mask'

function pixels(width: number, height: number, opaque: [number, number, number][]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (const [x, y, alpha] of opaque) data[(y * width + x) * 4 + 3] = alpha
  return data
}
describe('pet animation input region', () => {
  it('includes opaque pixels at nonaligned right and bottom edges', () => {
    expect(alphaRectangles(pixels(7, 5, [[6, 4, 255]]), 7, 5)).toEqual([{ x: 4, y: 4, width: 3, height: 1 }])
  })
  it('merges matching vertical runs without covering transparent gaps', () => {
    expect(alphaRectangles(pixels(12, 12, [[0, 0, 255], [0, 4, 255], [8, 8, 255]]), 12, 12)).toEqual([
      { x: 0, y: 0, width: 4, height: 8 },
      { x: 8, y: 8, width: 4, height: 4 },
    ])
  })
  it('excludes faint and fully transparent frames', () => {
    expect(alphaRectangles(pixels(4, 4, [[1, 1, 20]]), 4, 4)).toEqual([])
    expect(alphaRectangles(pixels(4, 4, [[1, 1, 21]]), 4, 4)).toEqual([{ x: 0, y: 0, width: 4, height: 4 }])
  })
  it('rejects incomplete pixel buffers', () => {
    expect(() => alphaRectangles(new Uint8ClampedArray(4), 4, 4)).toThrow('PET_ALPHA_FRAME_INVALID')
  })
})
