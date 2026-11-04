// Corta um .m4a (o formato do Gravador do iPhone) em pedaços de verdade, sem decodificar o áudio:
// lê o índice do arquivo e copia os quadros AAC de cada trecho para um arquivo .aac (ADTS).
// Assim uma gravação de horas vira partes pequenas, usando pouca memória do celular, e o Gemini
// recebe só aquele trecho, em vez de depender de "transcreva de 15:00 a 30:00" no arquivo inteiro.
//
// Só entende m4a comum com AAC-LC. Qualquer outra coisa (Gravador em "sem perdas", arquivo
// fragmentado) devolve null e o app usa o caminho alternativo.

'use strict';

const CONTAINERS_M4A = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

async function lerBytes(blob, de, ate) {
  return new DataView(await blob.slice(de, ate).arrayBuffer());
}

function nomeCaixa(v, p) {
  return String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
}

// Acha a caixa "moov" (o índice) andando só pelos cabeçalhos: o áudio em si nem é lido.
async function acharMoov(blob) {
  let p = 0;
  while (p + 8 <= blob.size) {
    const c = await lerBytes(blob, p, Math.min(p + 16, blob.size));
    let tam = c.getUint32(0);
    const nome = nomeCaixa(c, 4);
    let cab = 8;
    if (tam === 1) { tam = Number(c.getBigUint64(8)); cab = 16; } else if (tam === 0) tam = blob.size - p;
    if (tam < cab) return null;
    if (nome === 'moov') return lerBytes(blob, p, p + tam);
    p += tam;
  }
  return null;
}

// Primeira trilha de áudio: junta as tabelas que dizem onde cada quadro está.
function trilhaDeAudio(moov) {
  const trilhas = [];
  const andar = (de, ate, atual) => {
    let p = de;
    while (p + 8 <= ate) {
      const tam = moov.getUint32(p);
      const nome = nomeCaixa(moov, p + 4);
      if (tam < 8 || p + tam > ate) return;
      if (nome === 'trak') {
        const nova = {};
        trilhas.push(nova);
        andar(p + 8, p + tam, nova);
      } else if (CONTAINERS_M4A.has(nome)) {
        andar(p + 8, p + tam, atual);
      } else if (atual) {
        atual[nome] = { de: p + 8, ate: p + tam };
      }
      p += tam;
    }
  };
  andar(8, moov.byteLength, null);
  return trilhas.find((t) => t.hdlr && nomeCaixa(moov, t.hdlr.de + 8) === 'soun') || null;
}

// Dentro de stsd/mp4a/esds, procura a configuração do AAC (tipo, frequência, canais).
function configAac(moov, stsd) {
  const inicio = stsd.de + 8; // versão, flags, contagem
  if (nomeCaixa(moov, inicio + 4) !== 'mp4a') return null;
  for (let p = inicio + 36; p + 8 < stsd.ate; p++) {
    if (nomeCaixa(moov, p) !== 'esds') continue;
    for (let q = p + 8; q + 2 < stsd.ate; q++) {
      if (moov.getUint8(q) !== 0x05) continue; // descritor DecoderSpecificInfo
      let r = q + 1;
      while (moov.getUint8(r) & 0x80) r++;
      r++;
      const a = moov.getUint8(r), b = moov.getUint8(r + 1);
      return { tipo: a >> 3, freq: ((a & 7) << 1) | (b >> 7), canais: (b >> 3) & 15 };
    }
  }
  return null;
}

// Devolve { quadros: [{ pos, tam }], segundos, config } ou null se não souber ler o arquivo.
async function lerIndiceM4a(blob) {
  try {
    const moov = await acharMoov(blob);
    if (!moov) return null;
    const t = trilhaDeAudio(moov);
    if (!t?.stsd || !t.stsz || !t.stsc || !t.mdhd || !(t.stco || t.co64)) return null;
    const config = configAac(moov, t.stsd);
    if (!config || config.tipo !== 2 || config.freq > 12) return null; // só AAC-LC

    const versao = moov.getUint8(t.mdhd.de);
    const escala = moov.getUint32(t.mdhd.de + (versao === 1 ? 20 : 12));
    const fixo = moov.getUint32(t.stsz.de + 4);
    const total = moov.getUint32(t.stsz.de + 8);
    const tamanho = (i) => fixo || moov.getUint32(t.stsz.de + 12 + i * 4);

    const nBlocos = moov.getUint32((t.stco || t.co64).de + 4);
    const posBloco = (i) => (t.stco
      ? moov.getUint32(t.stco.de + 8 + i * 4)
      : Number(moov.getBigUint64(t.co64.de + 8 + i * 8)));

    const nRegras = moov.getUint32(t.stsc.de + 4);
    const regra = (i) => ({
      primeiro: moov.getUint32(t.stsc.de + 8 + i * 12) - 1,
      porBloco: moov.getUint32(t.stsc.de + 12 + i * 12),
    });

    const quadros = new Array(total);
    let q = 0;
    let r = 0;
    for (let b = 0; b < nBlocos && q < total; b++) {
      while (r + 1 < nRegras && regra(r + 1).primeiro <= b) r++;
      let pos = posBloco(b);
      for (let s = regra(r).porBloco; s > 0 && q < total; s--, q++) {
        const tam = tamanho(q);
        quadros[q] = { pos, tam };
        pos += tam;
      }
    }
    if (q !== total || !total) return null;
    return { quadros, config, segundos: (total * 1024) / escala, quadrosPorSeg: escala / 1024 };
  } catch {
    return null; // arquivo diferente do esperado: quem chamou usa o outro caminho
  }
}

// Monta o .aac do trecho de..ate (segundos). Cada quadro ganha o cabeçalho ADTS de 7 bytes.
async function trechoAac(blob, indice, de, ate) {
  const primeiro = Math.floor(de * indice.quadrosPorSeg);
  const ultimo = Math.min(indice.quadros.length, Math.ceil(ate * indice.quadrosPorSeg));
  const quadros = indice.quadros.slice(primeiro, ultimo);
  if (!quadros.length) return null;
  const inicio = quadros.reduce((m, f) => Math.min(m, f.pos), Infinity);
  const fim = quadros.reduce((m, f) => Math.max(m, f.pos + f.tam), 0);
  const origem = new Uint8Array(await blob.slice(inicio, fim).arrayBuffer());
  const saida = new Uint8Array(quadros.reduce((n, f) => n + f.tam + 7, 0));
  const { freq, canais } = indice.config;
  let p = 0;
  for (const f of quadros) {
    const n = f.tam + 7;
    saida[p] = 0xff;
    saida[p + 1] = 0xf1;
    saida[p + 2] = (1 << 6) | (freq << 2) | (canais >> 2); // perfil AAC-LC
    saida[p + 3] = ((canais & 3) << 6) | (n >> 11);
    saida[p + 4] = (n >> 3) & 0xff;
    saida[p + 5] = ((n & 7) << 5) | 0x1f;
    saida[p + 6] = 0xfc;
    saida.set(origem.subarray(f.pos - inicio, f.pos - inicio + f.tam), p + 7);
    p += n;
  }
  return new Blob([saida], { type: 'audio/aac' });
}
