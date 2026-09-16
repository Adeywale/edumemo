/* Prints the real pixel size of the PWA icons. */
const fs = require('fs');

for (const file of ['public/images/logo.png', 'public/images/logo-dark.png', 'edumemo.png']) {
  const b = fs.readFileSync(file);
  const sig = b.slice(0, 8).toString('hex');
  if (sig !== '89504e470d0a1a0a') {
    console.log(file, 'not a PNG (signature', sig + ')');
    continue;
  }
  let offset = 8;
  let done = false;
  while (offset < b.length - 8) {
    const len = b.readUInt32BE(offset);
    const type = b.toString('ascii', offset + 4, offset + 8);
    if (type === 'IHDR') {
      console.log(file, `${b.readUInt32BE(offset + 8)}x${b.readUInt32BE(offset + 12)}`,
        'bitDepth=' + b[offset + 16], 'colorType=' + b[offset + 17],
        Math.round(b.length / 1024) + 'KB');
      done = true;
      break;
    }
    if (len <= 0 || len > b.length) break;
    offset += 12 + len;
  }
  if (!done) console.log(file, 'no IHDR chunk found');
}