export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}
export function alphaRectangles(data: Uint8ClampedArray, width: number, height: number): Rectangle[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data.length !== width * height * 4)
    throw new Error('PET_ALPHA_FRAME_INVALID')
  const rectangles: Rectangle[] = []
  let previous = new Map<string, Rectangle>()
  for (let y = 0; y < height; y += 4) {
    const next = new Map<string, Rectangle>()
    let start = -1
    for (let x = 0; x <= Math.ceil(width / 4) * 4; x += 4) {
      let opaque = false
      for (let dy = 0; dy < 4 && y + dy < height && !opaque; dy++) {
        for (let dx = 0; dx < 4 && x + dx < width; dx++) {
          if (data[((y + dy) * width + x + dx) * 4 + 3]! > 20) {
            opaque = true
            break
          }
        }
      }
      if (opaque && start < 0)
        start = x
      if (!opaque && start >= 0) {
        const runWidth = Math.min(x, width) - start
        const key = `${start}:${runWidth}`
        const old = previous.get(key)
        const runHeight = Math.min(4, height - y)
        if (old && old.y + old.height === y) {
          old.height += runHeight
          next.set(key, old)
        }
        else {
          const rect = { x: start, y, width: runWidth, height: runHeight }
          rectangles.push(rect)
          next.set(key, rect)
        }
        start = -1
      }
    }
    previous = next
  }
  if (rectangles.length > 4096)
    throw new Error('PET_INPUT_REGION_TOO_COMPLEX')
  return rectangles
}
