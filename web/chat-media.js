const pixelLimit = 16_000_000;
const dimensionLimit = 8192;
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(view) {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return;
  let offset = 2;
  while (offset + 4 <= view.byteLength && view.getUint8(offset) === 0xff) {
    const marker = view.getUint8(++offset);
    if (marker === 0xff) continue;
    offset++;
    if (marker === 0xd9 || marker === 0xda) return;
    if (offset + 2 > view.byteLength) return;
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > view.byteLength) return;
    if (size >= 8 && jpegFrames.has(marker)) return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    offset += size;
  }
}

function pngSize(view) {
  if (view.byteLength < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) return;
  // Animated PNG includes an animation control chunk before the first image data.
  for (let offset = 33; offset + 12 <= view.byteLength;) {
    const size = view.getUint32(offset);
    const type = view.getUint32(offset + 4);
    if (type === 0x6163544c || size > view.byteLength - offset - 12) return;
    if (type === 0x49444154) return [view.getUint32(16), view.getUint32(20)];
    offset += size + 12;
  }
}

function webpSize(view) {
  if (view.byteLength < 25 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57454250) return;
  switch (view.getUint32(12)) {
    case 0x56503858: // VP8X
      if (view.byteLength < 30 || (view.getUint8(20) & 2)) return;
      return [(view.getUint16(24, true) | view.getUint8(26) << 16) + 1,
        (view.getUint16(27, true) | view.getUint8(29) << 16) + 1];
    case 0x5650384c: { // VP8L
      if (view.getUint8(20) !== 0x2f) return;
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    case 0x56503820: // VP8 and key frame signature
      if (view.byteLength < 30 || view.getUint8(23) !== 0x9d || view.getUint16(24) !== 0x012a) return;
      return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
  }
}

export function canPreviewChatImage(type, bytes) {
  const view = new DataView(bytes);
  const size = type === "image/jpeg" ? jpegSize(view) : type === "image/png" ? pngSize(view)
    : type === "image/webp" ? webpSize(view) : null;
  if (!size) return false;
  const [width, height] = size;
  return width > 0 && height > 0 && width <= dimensionLimit && height <= dimensionLimit && width * height <= pixelLimit;
}
