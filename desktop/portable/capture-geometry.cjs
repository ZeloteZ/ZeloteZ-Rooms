"use strict";

function captureGeometry({ width, height }, { region = null, height: maximumHeight = 1080, fps = 30 }) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 32768) ||
      ![720, 1080, 1440].includes(maximumHeight) || ![30, 60].includes(fps)) throw new Error("Invalid capture dimensions");
  let x = 0, y = 0, right = width, bottom = height;
  if (region !== null) {
    const { x: left, y: top, width: selectedWidth, height: selectedHeight } = region;
    if (![left, top, selectedWidth, selectedHeight].every(Number.isFinite) || left < 0 || top < 0 ||
        selectedWidth <= 0 || selectedHeight <= 0 || left + selectedWidth > 1.000001 || top + selectedHeight > 1.000001 ||
        region.sourceWidth !== width || region.sourceHeight !== height) throw new Error("Capture source changed size");
    // Round inward: pixels outside the confirmed rectangle must never enter the output.
    x = Math.ceil(left * width);
    y = Math.ceil(top * height);
    right = Math.min(width, Math.floor((left + selectedWidth) * width));
    bottom = Math.min(height, Math.floor((top + selectedHeight) * height));
  }
  const cropWidth = right - x, cropHeight = bottom - y;
  if (cropWidth < 1 || cropHeight < 1) throw new Error("The selected area is too small");
  const scale = Math.min(region === null ? 1 : Infinity, maximumHeight * 16 / 9 / cropWidth, maximumHeight / cropHeight);
  return { sourceWidth: width, sourceHeight: height, cropped: region !== null, x, y, cropWidth, cropHeight, fps,
    width: Math.max(2, Math.floor(cropWidth * scale / 2) * 2), height: Math.max(2, Math.floor(cropHeight * scale / 2) * 2) };
}

module.exports = { captureGeometry };
