// PNG encode and decode (8-bit, no interlace), enough for screenshots and test textures. Uses only node:zlib.
import { deflateSync, inflateSync } from "node:zlib";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** rgba: Uint8Array of width*height*4. */
export function encodePng(width, height, rgba, { alpha = true } = {}) {
  const bpp = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * bpp + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = row + 1 + x * bpp;
      raw[d] = rgba[s];
      raw[d + 1] = rgba[s + 1];
      raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let i = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 6;
  let palette = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const t = buf.toString("latin1", i + 4, i + 8);
    const d = buf.subarray(i + 8, i + 8 + len);
    if (t === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
      depth = d[8];
      type = d[9];
      if (d[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (t === "PLTE") palette = d;
    else if (t === "IDAT") idat.push(d);
    else if (t === "IEND") break;
    i += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG bit depth ${depth} is not supported`);
  const ch = type === 6 ? 4 : type === 2 ? 3 : type === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = raw[p++];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      if (type === 6) out.set(cur.subarray(x * 4, x * 4 + 4), d);
      else if (type === 2) {
        out[d] = cur[x * 3];
        out[d + 1] = cur[x * 3 + 1];
        out[d + 2] = cur[x * 3 + 2];
        out[d + 3] = 255;
      } else if (type === 3) {
        const k = cur[x] * 3;
        out[d] = palette[k];
        out[d + 1] = palette[k + 1];
        out[d + 2] = palette[k + 2];
        out[d + 3] = 255;
      } else {
        out[d] = out[d + 1] = out[d + 2] = cur[x * ch];
        out[d + 3] = type === 4 ? cur[x * 2 + 1] : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}
