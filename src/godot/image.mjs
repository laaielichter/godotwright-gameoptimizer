// Image headers: width, height and whether there is an alpha channel, without decoding pixels.
import { openSync, readSync, closeSync, statSync } from "node:fs";

export function imageInfoFromBuffer(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) {
    const ct = b[25];
    return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20), alpha: ct === 4 || ct === 6 || undefined };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { format: "jpg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), alpha: false };
      }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) i += 2;
      else i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const k = b.toString("latin1", 12, 16);
    if (k === "VP8X") return { format: "webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), alpha: (b[20] & 0x10) !== 0 };
    if (k === "VP8 ") return { format: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, alpha: false };
    if (k === "VP8L") {
      const v = b.readUInt32LE(21);
      return { format: "webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1, alpha: ((v >> 28) & 1) === 1 };
    }
  }
  if (b.length >= 20 && b.toString("latin1", 0, 4) === "DDS ") return { format: "dds", width: b.readUInt32LE(16), height: b.readUInt32LE(12), compressed: true };
  if (b.length >= 28 && b.toString("latin1", 1, 7) === "KTX 20") return { format: "ktx2", width: b.readUInt32LE(20), height: b.readUInt32LE(24), compressed: true };
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) return { format: "bmp", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)), alpha: false };
  return null;
}

export function imageInfo(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    let buf = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, buf, 0, buf.length, 0);
    let info = imageInfoFromBuffer(buf);
    if (!info && buf[0] === 0xff && size > buf.length) {
      buf = Buffer.alloc(Math.min(size, 1 << 20)); // JPEG with a large EXIF block
      readSync(fd, buf, 0, buf.length, 0);
      info = imageInfoFromBuffer(buf);
    }
    if (!info && /\.tga$/i.test(path) && buf.length >= 18) info = { format: "tga", width: buf.readUInt16LE(12), height: buf.readUInt16LE(14), alpha: buf[16] === 32 };
    return info ? { ...info, bytes: size } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Estimated GPU memory in bytes for a texture as Godot would upload it. */
export function vramBytes({ width, height, alpha }, { compressed, mipmaps, hdr = false }) {
  const px = width * height;
  let bytes;
  if (compressed) bytes = alpha === false ? px / 2 : px; // BC1 4 bpp without alpha, BC3/BC7 8 bpp with
  else bytes = px * (hdr ? 8 : alpha === false ? 4 : 4); // RGB8 is uploaded as RGBA8 on most GPUs
  return Math.round(bytes * (mipmaps ? 4 / 3 : 1));
}
