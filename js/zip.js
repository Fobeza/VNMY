/* VNMY — чтение zip-архивов (файл новеллы .vnmy) без сторонних библиотек.
 *
 * readZip(blob) → Map(путь → Blob). Поддерживаются методы «без сжатия» (0) —
 * так пакует npm run pack — и deflate (8), если браузер умеет
 * DecompressionStream. Несжатые файлы не копируются: это срезы исходного Blob.
 */

const MIME = {
  webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', json: 'application/json',
};

export function mimeOf(path) {
  return MIME[String(path).split('.').pop().toLowerCase()] || 'application/octet-stream';
}

export async function isZip(blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 22 + 0xffff);
  const tail = new DataView(await blob.slice(blob.size - tailSize).arrayBuffer());
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('BAD_PACKAGE');
  const count = tail.getUint16(eocd + 10, true);
  const dirSize = tail.getUint32(eocd + 12, true);
  const dirOffset = tail.getUint32(eocd + 16, true);
  if (dirOffset === 0xffffffff) throw new Error('BAD_PACKAGE'); // zip64 не нужен для новелл
  const dir = new DataView(await blob.slice(dirOffset, dirOffset + dirSize).arrayBuffer());
  const decoder = new TextDecoder();
  const files = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (dir.getUint32(p, true) !== 0x02014b50) throw new Error('BAD_PACKAGE');
    const method = dir.getUint16(p + 10, true);
    const compressed = dir.getUint32(p + 20, true);
    const nameLen = dir.getUint16(p + 28, true);
    const extraLen = dir.getUint16(p + 30, true);
    const commentLen = dir.getUint16(p + 32, true);
    const local = dir.getUint32(p + 42, true);
    const name = decoder.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const header = new DataView(await blob.slice(local, local + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50) throw new Error('BAD_PACKAGE');
    const start = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    const raw = blob.slice(start, start + compressed);
    const type = mimeOf(name);
    if (method === 0) {
      files.set(name, new Blob([raw], { type }));
    } else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('ZIP_UNSUPPORTED');
      const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(name, new Blob([await new Response(stream).arrayBuffer()], { type }));
    } else {
      throw new Error('ZIP_UNSUPPORTED');
    }
  }
  return files;
}
