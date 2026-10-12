// Gera o símbolo da Elevatis (barras subindo + seta) em todos os formatos do app,
// a partir de uma geometria só:
//   public/marca.svg     símbolo sem fundo (cabeçalho do app)
//   public/icon.svg      ícone com fundo (aba do navegador)
//   public/icon-192.png  ícone da tela inicial (o Android exige PNG)
//   public/icon-512.png
// Sem dependências: o PNG é desenhado pixel a pixel. `node gerar-icones.js`
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const FUNDO = [14, 21, 34];          // #0E1522, o fundo da logo
const AZUL_ESCURO = [15, 111, 229];  // #0F6FE5, à esquerda
const AZUL_CLARO = [25, 182, 234];   // #19B6EA, à direita

// Tudo num quadro de 512x512.
const BASE = 400;
const barras = [70, 130, 190, 250].map((h, i) => {
  const x = 92 + i * 74, larg = 50, incl = h * 0.22;
  return [[x, BASE], [x + larg, BASE], [x + larg + incl, BASE - h], [x + incl, BASE - h]];
});
// Seta: haste diagonal saindo de baixo à esquerda até o alto à direita, com ponta triangular.
const [ax, ay, bx, by] = [110, 330, 382, 112];
const ang = Math.atan2(by - ay, bx - ax);
const perp = (d) => [Math.cos(ang + Math.PI / 2) * d, Math.sin(ang + Math.PI / 2) * d];
const [px, py] = perp(13);
const haste = [[ax + px, ay + py], [bx + px, by + py], [bx - px, by - py], [ax - px, ay - py]];
const ponta = (() => {
  const tam = 64, [qx, qy] = perp(40);
  const tx = bx + Math.cos(ang) * tam, ty = by + Math.sin(ang) * tam;
  return [[tx, ty], [bx + qx, by + qy], [bx - qx, by - qy]];
})();
// Recorte escuro em volta da seta, para ela se destacar por cima das barras.
const [cx, cy] = perp(26);
const contorno = [[ax + cx, ay + cy], [bx + cx, by + cy], [bx - cx, by - cy], [ax - cx, ay - cy]];
// No ícone o símbolo vai menor e centrado: o Android recorta em círculo (zona segura ~80%).
const CENTRO = [262, 236], ESCALA = 0.74;
const paraIcone = `translate(256 256) scale(${ESCALA}) translate(${-CENTRO[0]} ${-CENTRO[1]})`;

// ---------- SVG ----------
const pts = (p) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
function svg(comFundo) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${comFundo ? '0 0 512 512' : '70 60 400 360'}">
<defs><linearGradient id="g" x1="90" x2="430" y1="0" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${hex(AZUL_ESCURO)}"/><stop offset="1" stop-color="${hex(AZUL_CLARO)}"/></linearGradient></defs>
${comFundo ? `<rect width="512" height="512" rx="112" fill="${hex(FUNDO)}"/><g transform="${paraIcone}">` : '<g>'}
<g fill="url(#g)">${barras.map((b) => `<polygon points="${pts(b)}"/>`).join('')}</g>
<polygon points="${pts(contorno)}" fill="${hex(FUNDO)}"/>
<g fill="url(#g)"><polygon points="${pts(haste)}"/><polygon points="${pts(ponta)}"/></g>
</g>
</svg>
`;
}

// ---------- PNG ----------
function dentro(p, x, y) {
  let d = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) d = !d;
  }
  return d;
}
function corEm(x, y) {
  const t = Math.min(1, Math.max(0, (x - 90) / 340));
  const azul = AZUL_ESCURO.map((v, i) => v + (AZUL_CLARO[i] - v) * t);
  if (dentro(haste, x, y) || dentro(ponta, x, y)) return azul;
  if (dentro(contorno, x, y)) return FUNDO;
  if (barras.some((b) => dentro(b, x, y))) return azul;
  return FUNDO;
}

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
  const esc = 512 / tam, AA = 3; // 3x3 amostras por pixel: bordas suaves
  const linhas = [];
  for (let y = 0; y < tam; y++) {
    const linha = Buffer.alloc(1 + tam * 3);
    for (let x = 0; x < tam; x++) {
      const soma = [0, 0, 0];
      for (let sy = 0; sy < AA; sy++) for (let sx = 0; sx < AA; sx++) {
        const ix = (x + (sx + 0.5) / AA) * esc, iy = (y + (sy + 0.5) / AA) * esc;
        const c = corEm(CENTRO[0] + (ix - 256) / ESCALA, CENTRO[1] + (iy - 256) / ESCALA);
        soma[0] += c[0]; soma[1] += c[1]; soma[2] += c[2];
      }
      for (let i = 0; i < 3; i++) linha[1 + x * 3 + i] = Math.round(soma[i] / (AA * AA));
    }
    linhas.push(linha);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tam, 0); ihdr.writeUInt32BE(tam, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', ihdr), bloco('IDAT', zlib.deflateSync(Buffer.concat(linhas))), bloco('IEND', Buffer.alloc(0)),
  ]);
}

const pub = (f) => path.join(__dirname, 'public', f);
fs.writeFileSync(pub('marca.svg'), svg(false));
fs.writeFileSync(pub('icon.svg'), svg(true));
for (const t of [192, 512]) fs.writeFileSync(pub(`icon-${t}.png`), png(t));
console.log('ícones gerados');
