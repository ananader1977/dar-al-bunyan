// Minimal dependency-free PDF writer (A4, built-in Helvetica fonts, text/rect/line/images).
// Text is limited to Latin-1; other characters are replaced with "?".
import zlib from 'node:zlib';

// Helvetica glyph widths (1/1000 em) for ASCII 32..126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

export const PAGE_W = 595.28;
export const PAGE_H = 841.89;

function latin1(str) {
  let out = '';
  for (const ch of String(str)) {
    const c = ch.codePointAt(0);
    out += c >= 32 && c <= 255 ? ch : c === 9 || c === 10 ? ' ' : '?';
  }
  return out;
}
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = (n) => (Math.round(n * 100) / 100).toString();

function color(c) {
  if (Array.isArray(c)) return c.map(num).join(' ');
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return '0 0 0';
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => num(x / 255)).join(' ');
}

export class Pdf {
  constructor({ title = 'Document', author = '' } = {}) {
    this.title = latin1(title);
    this.author = latin1(author);
    this.pages = [];
    this.images = []; // { name, width, height, rgb, alpha }
    this.newPage();
  }
  newPage() {
    this.cur = [];
    this.pages.push(this.cur);
    return this;
  }
  textWidth(str, size = 10, bold = false) {
    const w = bold ? W_BOLD : W_REG;
    let total = 0;
    for (const ch of latin1(str)) {
      const c = ch.charCodeAt(0);
      total += c >= 32 && c <= 126 ? w[c - 32] : 556;
    }
    return (total * size) / 1000;
  }
  /** Greedy word-wrap into lines no wider than `width`. */
  wrap(str, width, size = 10, bold = false) {
    const lines = [];
    for (const para of String(str ?? '').split(/\r?\n/)) {
      let line = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const test = line ? `${line} ${word}` : word;
        if (this.textWidth(test, size, bold) <= width || !line) line = test;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }
  /** (x, y) = left/right/centre anchor and BASELINE measured from the top of the page. */
  text(str, x, y, { size = 10, bold = false, align = 'left', fill = '#000000' } = {}) {
    const s = latin1(str);
    const w = this.textWidth(s, size, bold);
    const px = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.cur.push(`BT ${color(fill)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(px)} ${num(PAGE_H - y)} Td (${esc(s)}) Tj ET`);
    return this;
  }
  rect(x, y, w, h, { fill, stroke, lineWidth = 0.7 } = {}) {
    const ops = [];
    if (fill) ops.push(`${color(fill)} rg`);
    if (stroke) ops.push(`${color(stroke)} RG ${num(lineWidth)} w`);
    ops.push(`${num(x)} ${num(PAGE_H - y - h)} ${num(w)} ${num(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    this.cur.push(ops.join(' '));
    return this;
  }
  line(x1, y1, x2, y2, { stroke = '#000000', lineWidth = 0.7 } = {}) {
    this.cur.push(`${color(stroke)} RG ${num(lineWidth)} w ${num(x1)} ${num(PAGE_H - y1)} m ${num(x2)} ${num(PAGE_H - y2)} l S`);
    return this;
  }
  /** Draw a decoded image ({width,height,rgb,alpha}) with its top-left corner at (x, y), scaled to w x h points. */
  image(img, x, y, w, h) {
    let entry = this.images.find((e) => e.src === img);
    if (!entry) {
      entry = { src: img, name: `Im${this.images.length + 1}` };
      this.images.push(entry);
    }
    this.cur.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(PAGE_H - y - h)} cm /${entry.name} Do Q`);
    return this;
  }
  toBuffer() {
    const objs = [];
    const add = (buf) => objs.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'));
    const nPages = this.pages.length;
    // 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then (page, content) pairs
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(`<< /Type /Pages /Kids [${this.pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ')}] /Count ${nPages} >>`);
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    add(`<< /Title (${esc(this.title)}) /Author (${esc(this.author)}) /Producer (Dar Al Bunyan) >>`);
    // image objects come after the pages: each image = [smask?] + image
    let next = 6 + nPages * 2;
    const imgObjs = [];
    for (const e of this.images) {
      const { width, height, rgb, alpha } = e.src;
      const smaskNo = alpha ? next++ : null;
      const imgNo = next++;
      imgObjs.push({ e, smaskNo, imgNo, width, height, rgb, alpha });
    }
    const xobjects = imgObjs.length ? ` /XObject << ${imgObjs.map((o) => `/${o.e.name} ${o.imgNo} 0 R`).join(' ')} >>` : '';
    this.pages.forEach((ops, i) => {
      const contentNo = 7 + i * 2;
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects} >> /Contents ${contentNo} 0 R >>`);
      const data = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    });
    const stream = (dict, raw) => {
      const data = zlib.deflateSync(raw);
      add(Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    };
    for (const o of imgObjs) {
      if (o.alpha) stream(`/Type /XObject /Subtype /Image /Width ${o.width} /Height ${o.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, o.alpha);
      stream(`/Type /XObject /Subtype /Image /Width ${o.width} /Height ${o.height} /ColorSpace /DeviceRGB /BitsPerComponent 8${o.alpha ? ` /SMask ${o.smaskNo} 0 R` : ''}`, o.rgb);
    }
    const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets = [];
    let pos = chunks[0].length;
    objs.forEach((body, i) => {
      offsets.push(pos);
      const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      chunks.push(b);
      pos += b.length;
    });
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}
