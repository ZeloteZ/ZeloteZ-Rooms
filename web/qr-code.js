import qrcode from "./qrcode-generator.js";

export function drawQrCode(uri) {
  if (typeof uri !== "string" || !uri.startsWith("otpauth://totp/") ||
      uri.length > 1024 || /[^\x21-\x7e]/u.test(uri)) {
    throw new Error("Invalid authenticator setup URI.");
  }
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();

  const modules = qr.getModuleCount();
  const quietZone = 4;
  const scale = 4;
  const size = (modules + quietZone * 2) * scale;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("QR rendering unavailable.");

  context.fillStyle = "#fff";
  context.fillRect(0, 0, size, size);
  context.fillStyle = "#000";
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (qr.isDark(row, column)) {
        context.fillRect((column + quietZone) * scale, (row + quietZone) * scale, scale, scale);
      }
    }
  }
  return canvas;
}
