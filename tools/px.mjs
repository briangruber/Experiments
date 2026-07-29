// Tiny PNG reader for inspecting captures: node tools/px.mjs file.png x,y x,y ...
// Also supports "col=X" to dump a whole column and "row=Y" for a row.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function readPNG(path) {
  const b = readFileSync(path);
  let p = 8, w = 0, h = 0, bd = 8, ct = 6;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    p += len + 12;
  }
  if (bd !== 8) throw new Error('only 8-bit');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[q++];
    const line = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const bb = prev ? prev[i] : 0;
      const c = (prev && i >= ch) ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

if ((process.argv[1] || '').endsWith('px.mjs')) {
  const img = readPNG(process.argv[2]);
  const px = (x, y) => { const i = (y * img.w + x) * img.ch; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  console.log(`${img.w}x${img.h}`);
  for (const a of process.argv.slice(3)) {
    if (a.startsWith('col=')) {
      const x = +a.slice(4);
      for (let y = 0; y < img.h; y += Math.max(1, +(process.env.STEP || 8))) console.log(y, px(x, y).join(','));
    } else if (a.startsWith('row=')) {
      const y = +a.slice(4);
      for (let x = 0; x < img.w; x += Math.max(1, +(process.env.STEP || 8))) console.log(x, px(x, y).join(','));
    } else if (a.startsWith('stats=')) {
      const [x0, y0, x1, y1] = a.slice(6).split(',').map(Number);
      let n = 0, s = 0, s2 = 0, mx = 0, clip = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const [r, g, bl] = px(x, y); const l = (r + g + bl) / 3;
        n++; s += l; s2 += l * l; mx = Math.max(mx, l); if (l > 250) clip++;
      }
      console.log(`box ${a.slice(6)} mean=${(s / n).toFixed(1)} sd=${Math.sqrt(s2 / n - (s / n) ** 2).toFixed(1)} max=${mx} clip%=${(100 * clip / n).toFixed(1)}`);
    } else {
      const [x, y] = a.split(',').map(Number);
      console.log(a, px(x, y).join(','));
    }
  }
}
