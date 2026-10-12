// Gera public/icon-192.png e icon-512.png (o Android exige PNG para instalar o app).
// Mesmo desenho do icon.svg, sem dependências: fundo escuro, círculo vermelho, ponto branco.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function bloco(tipo, dados) {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(tam) {
  const linhas = [];
  const c = tam / 2;
  for (let y = 0; y < tam; y++) {
    const linha = Buffer.alloc(1 + tam * 3);
    for (let x = 0; x < tam; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c) / tam * 512;
      const cor = d < 58 ? [255, 255, 255] : d < 150 ? [239, 68, 68] : [17, 20, 24];
      cor.forEach((v, i) => { linha[1 + x * 3 + i] = v; });
    }
    linhas.push(linha);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr),
    bloco('IDAT', zlib.deflateSync(Buffer.concat(linhas))),
    bloco('IEND', Buffer.alloc(0)),
  ]);
}

for (const t of [192, 512]) fs.writeFileSync(path.join(__dirname, 'public', `icon-${t}.png`), png(t));
console.log('ícones gerados');
