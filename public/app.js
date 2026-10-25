// ATA Elevatis — gravador de reuniões presenciais.
//
// Como a gravação funciona:
// - O áudio é cortado em partes de 15 min. Cada parte é um arquivo completo e
//   independente, então dá para transcrever enquanto a reunião continua e a ata
//   sai pouco depois de encerrar — também em reuniões de várias horas.
// - A cada 10 s o navegador entrega um bloco novo de áudio, que vai na hora para o
//   IndexedDB do celular como registro próprio (só o bloco novo, nunca a parte
//   inteira de novo). Se o app fechar no meio, o que foi gravado é recuperado.
// - Nenhuma espera é sem fim: parar o gravador, salvar e chamar o Gemini têm prazo.
//   Um celular que não responde nunca deixa a tela travada.

'use strict';

// 15 min: cada corte é um ponto onde a numeração de quem fala pode se perder,
// então menos cortes = menos trocas. 15 min a 32 kbps ≈ 3,6 MB, bem abaixo do limite do Gemini.
const PEDACO_MS = 15 * 60 * 1000;
const BLOCO_MS = 10 * 1000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const esperarMs = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Espera a promessa até `ms`; depois disso segue em frente (devolve `nada`) em vez de travar.
const comPrazo = (promessa, ms, nada) => Promise.race([promessa, esperarMs(ms).then(() => nada)]);

// ---------- diagnóstico ----------
// Últimos acontecimentos, guardados no celular. Em Ajustes → "Copiar relatório",
// para mandar a quem for consertar quando algo der errado. Não guarda áudio nem texto.

const DIAG_MAX = 120;
function registrar(evento) {
  try {
    const linhas = JSON.parse(localStorage.getItem('ata-diagnostico') || '[]');
    linhas.push(`${new Date().toISOString().slice(5, 19).replace('T', ' ')} ${evento}`);
    localStorage.setItem('ata-diagnostico', JSON.stringify(linhas.slice(-DIAG_MAX)));
  } catch { /* diagnóstico nunca pode atrapalhar o app */ }
}
window.addEventListener('error', (e) => registrar(`ERRO ${e.message} @${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => registrar(`ERRO promessa ${e.reason?.message || e.reason}`));

// ---------- banco local (IndexedDB) ----------
// audios: chave "<id>:<parte>:<bloco>" -> { blob, mime }, um registro por bloco de 10 s.
// (Gravações antigas têm um registro só por parte, chave "<id>:<parte>" — ainda são lidas.)

const banco = new Promise((ok, falha) => {
  const r = indexedDB.open('ata', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('reunioes', { keyPath: 'id' });
    r.result.createObjectStore('audios');
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => falha(r.error);
});

async function bd(store, modo, fn) {
  const db = await banco;
  return new Promise((ok, falha) => {
    const tx = db.transaction(store, modo);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => ok(req && req.result);
    tx.onerror = () => falha(tx.error);
    // Celular sem espaço aborta a transação; sem isto a promessa nunca terminaria.
    tx.onabort = () => falha(tx.error || new Error('Gravação no celular interrompida (sem espaço?)'));
  });
}
const lerReuniao = (id) => bd('reunioes', 'readonly', (s) => s.get(id));
const salvarReuniao = (r) => bd('reunioes', 'readwrite', (s) => s.put(r));
const todasReunioes = () => bd('reunioes', 'readonly', (s) => s.getAll());
const faixa = (prefixo) => IDBKeyRange.bound(prefixo, prefixo + '￿');
const chaveBloco = (id, n, k) => `${id}:${n}:${String(k).padStart(6, '0')}`;
const salvarBloco = (id, n, k, blob, mime) => bd('audios', 'readwrite', (s) => s.put({ blob, mime }, chaveBloco(id, n, k)));

// Junta os blocos de uma parte num arquivo só (ou devolve o registro único do formato antigo).
async function lerAudio(id, n) {
  const antigo = await bd('audios', 'readonly', (s) => s.get(`${id}:${n}`));
  if (antigo) return antigo;
  const blocos = await bd('audios', 'readonly', (s) => s.getAll(faixa(`${id}:${n}:`)));
  if (!blocos?.length) return null;
  const mime = blocos[0].mime;
  return { blob: new Blob(blocos.map((b) => b.blob), { type: mime }), mime };
}

async function apagarReuniao(r) {
  await bd('reunioes', 'readwrite', (s) => s.delete(r.id));
  await bd('audios', 'readwrite', (s) => s.delete(faixa(`${r.id}:`)));
}

// ---------- telas ----------

function mostrar(nome) {
  for (const t of document.querySelectorAll('.tela')) t.hidden = t.id !== `tela-${nome}`;
  window.scrollTo(0, 0);
}

let avisoTimer;
function avisar(msg, ms = 4000) {
  const el = $('#aviso');
  el.textContent = msg; el.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => { el.hidden = true; }, ms);
}

const fmtDuracao = (seg) => {
  seg = Math.round(seg || 0);
  const h = Math.floor(seg / 3600), m = Math.floor(seg / 60) % 60, s = seg % 60;
  const dd = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${dd(m)}:${dd(s)}` : `${dd(m)}:${dd(s)}`;
};
const fmtData = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const ROTULO = { gravando: 'gravando', processando: 'processando', pronta: 'pronta', erro: 'pendente' };

async function renderLista() {
  const lista = (await todasReunioes()).sort((a, b) => b.inicio.localeCompare(a.inicio));
  $('#lista-vazia').hidden = lista.length > 0;
  $('#lista').innerHTML = lista.map((r) => `
    <li class="item" data-id="${r.id}">
      <span class="item-titulo">${esc(r.resumo?.titulo || r.contexto || 'Reunião sem título')}</span>
      <span class="item-meta">${fmtData(r.inicio)} · ${fmtDuracao(r.duracaoSeg)}
        <span class="selo ${r.status}">${ROTULO[r.status] || r.status}</span>${r.origem === 'importada' ? '<span class="selo">importada</span>' : ''}</span>
    </li>`).join('');
}
$('#lista').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) abrirDetalhe(li.dataset.id);
});

// ---------- gravação ----------

const gravacao = {
  reuniao: null, stream: null, rec: null, mime: '', n: 0,
  acumuladoMs: 0, desde: 0, pausado: false, encerrando: false, trocando: false, micPerdido: false,
  tCorte: null, tRelogio: null, restanteCorte: PEDACO_MS,
  wakeLock: null, audioCtx: null, escrita: Promise.resolve(),
};

function escolherMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

const decorridoMs = () => gravacao.acumuladoMs + (gravacao.pausado || !gravacao.desde ? 0 : Date.now() - gravacao.desde);

function estadoGravacao(tipo, texto) {
  $('#estado-gravacao').className = `estado ${tipo}`;
  $('#estado-gravacao').innerHTML = `<span class="pulso"></span> ${esc(texto)}`;
}

async function manterTelaLigada() {
  try { gravacao.wakeLock = await navigator.wakeLock?.request('screen'); }
  catch { /* sem suporte: o aviso na tela já pede para manter aberto */ }
}
document.addEventListener('visibilitychange', () => {
  if (!gravacao.reuniao) return;
  registrar(`tela ${document.visibilityState}`);
  if (document.visibilityState === 'visible') manterTelaLigada();
});

// Sem cancelamento de eco: ele foi feito para chamada e abafa quem fala longe do celular.
const pedirMicrofone = () => navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
});

function prepararMicrofone(stream) {
  gravacao.stream = stream;
  // Ligação, outro app ou o sistema podem tomar o microfone: a faixa termina sozinha.
  for (const t of stream.getAudioTracks()) t.addEventListener('ended', () => microfoneCaiu('o microfone foi desligado'));
  ligarMedidor();
}

async function comecar() {
  $('#aviso-mic').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('#aviso-mic').textContent = 'Este navegador não grava áudio. Use o Chrome (Android) ou o Safari (iPhone).';
    $('#aviso-mic').hidden = false;
    return;
  }
  if (gravacao.reuniao) return; // toque duplo
  let stream;
  try {
    stream = await pedirMicrofone();
  } catch (e) {
    registrar(`ERRO microfone negado: ${e.name}`);
    $('#aviso-mic').textContent = 'Sem acesso ao microfone. Libere a permissão nas configurações do navegador e tente de novo.';
    $('#aviso-mic').hidden = false;
    return;
  }

  const g = gravacao;
  g.mime = escolherMime();
  g.reuniao = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    inicio: new Date().toISOString(), duracaoSeg: 0, status: 'gravando',
    contexto: '', segmentos: [], transcricao: '', resumo: null, erro: '',
  };
  Object.assign(g, {
    n: 0, acumuladoMs: 0, desde: Date.now(), pausado: false, encerrando: false,
    trocando: false, micPerdido: false, escrita: Promise.resolve(),
  });
  registrar(`gravação ${g.reuniao.id} começou (${g.mime || 'formato padrão'}) ${navigator.userAgent.slice(0, 120)}`);

  $('#contexto').value = '';
  $('#btn-pausar').textContent = 'Pausar';
  $('#btn-parar').textContent = 'Encerrar';
  $('#btn-parar').disabled = false;
  estadoGravacao('', 'Gravando');
  $('#cronometro').textContent = '00:00';
  mostrar('gravando');

  try {
    await salvarReuniao(g.reuniao);
    prepararMicrofone(stream);
    iniciarPedaco();
  } catch (e) {
    registrar(`ERRO ao começar: ${e.message}`);
    stream.getTracks().forEach((t) => t.stop());
    g.reuniao = null;
    mostrar('inicio');
    $('#aviso-mic').textContent = `Não consegui começar a gravar (${e.message}). Tente de novo.`;
    $('#aviso-mic').hidden = false;
    return;
  }
  manterTelaLigada();
  g.tRelogio = setInterval(() => { $('#cronometro').textContent = fmtDuracao(decorridoMs() / 1000); }, 250);
}

function iniciarPedaco() {
  const g = gravacao;
  const r = g.reuniao;
  const n = g.n;
  const rec = new MediaRecorder(g.stream, { ...(g.mime ? { mimeType: g.mime } : {}), audioBitsPerSecond: 32000 });
  const mime = rec.mimeType || g.mime || 'audio/webm';
  let k = 0;
  if (!r.segmentos.some((p) => p.n === n)) r.segmentos.push({ n, mime, texto: null });

  // Cada bloco de 10 s vai direto para o celular, numa fila: salvar nunca atropela salvar.
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const bloco = k++;
    g.escrita = g.escrita
      .then(() => salvarBloco(r.id, n, bloco, e.data, mime))
      .then(() => {
        r.duracaoSeg = decorridoMs() / 1000;
        if (g.reuniao === r) r.contexto = $('#contexto').value.trim();
        return salvarReuniao(r);
      })
      .catch((err) => {
        registrar(`ERRO ao salvar bloco ${n}.${bloco}: ${err.message}`);
        avisar('Não consegui salvar parte do áudio no celular. Confira se há espaço livre.', 6000);
      });
  };
  rec.onerror = (e) => {
    registrar(`ERRO do gravador: ${e.error?.name || ''} ${e.error?.message || ''}`);
    microfoneCaiu('o gravador parou com erro');
  };
  rec.start(BLOCO_MS);
  g.rec = rec;
  registrar(`parte ${n} gravando`);
  clearTimeout(g.tCorte);
  g.tCorte = setTimeout(cortarPedaco, PEDACO_MS);
}

// Para um gravador e espera os últimos dados — no máximo `ms`. Devolve se ele confirmou.
function pararGravador(rec, ms = 4000) {
  if (!rec || rec.state === 'inactive') return Promise.resolve(true);
  const parou = new Promise((ok) => rec.addEventListener('stop', () => ok(true), { once: true }));
  try { rec.stop(); } catch (e) { registrar(`ERRO ao parar o gravador: ${e.message}`); return Promise.resolve(false); }
  return comPrazo(parou, ms, false);
}

// Fecha a parte em gravação: para o gravador, espera os blocos irem para o banco e marca a parte.
// Tudo com prazo: se o celular não responder, segue com o que já foi salvo.
async function fecharParteAtual() {
  const g = gravacao;
  const rec = g.rec;
  g.rec = null;
  clearTimeout(g.tCorte);
  if (!(await pararGravador(rec))) registrar('gravador não confirmou a parada em 4 s; seguindo com o que foi salvo');
  if ((await comPrazo(g.escrita.then(() => true), 6000, false)) === false) registrar('salvamento demorou mais de 6 s; seguindo');
  const seg = g.reuniao?.segmentos.find((p) => p.n === g.n);
  if (seg) seg.fechado = true;
  if (g.reuniao) await comPrazo(salvarReuniao(g.reuniao).catch((e) => registrar(`ERRO ${e.message}`)), 3000);
}

// A cada 15 min: fecha a parte atual, começa outra e já manda transcrever a que fechou.
async function cortarPedaco() {
  const g = gravacao;
  if (!g.rec || g.encerrando || g.trocando || g.pausado) return;
  g.trocando = true;
  try {
    await fecharParteAtual();
    if (g.encerrando || !g.reuniao) return;
    g.n += 1;
    iniciarPedaco();
    transcreverPendentes(g.reuniao.id).catch(() => { /* tenta de novo no fim */ });
  } catch (e) {
    registrar(`ERRO no corte: ${e.message}`);
    microfoneCaiu('falha ao trocar de parte');
  } finally {
    g.trocando = false;
  }
}

// Microfone tomado (ligação, outro app) ou gravador com erro: guarda o que tem e tenta voltar sozinho.
async function microfoneCaiu(motivo) {
  const g = gravacao;
  if (!g.reuniao || g.encerrando || g.micPerdido) return;
  g.micPerdido = true;
  registrar(`microfone caiu: ${motivo}`);
  estadoGravacao('pausado', 'Microfone interrompido — tentando retomar…');
  if (!g.pausado) g.acumuladoMs += Date.now() - g.desde;
  g.pausado = true;
  await fecharParteAtual();
  try { g.stream?.getTracks().forEach((t) => t.stop()); } catch { /* já parado */ }

  for (let tentativa = 1; g.reuniao && !g.encerrando; tentativa++) {
    try {
      const stream = await comPrazo(pedirMicrofone(), 8000, null);
      if (!stream) throw new Error('sem resposta em 8 s');
      if (g.encerrando || !g.reuniao) { stream.getTracks().forEach((t) => t.stop()); return; }
      prepararMicrofone(stream);
      g.n += 1;
      g.micPerdido = false; g.pausado = false; g.desde = Date.now();
      iniciarPedaco();
      $('#btn-pausar').textContent = 'Pausar';
      estadoGravacao('', 'Gravando');
      avisar('O microfone voltou. A gravação continua.');
      registrar(`microfone retomado na tentativa ${tentativa}`);
      transcreverPendentes(g.reuniao.id).catch(() => {});
      return;
    } catch (e) {
      registrar(`tentativa ${tentativa} de retomar o microfone falhou: ${e.name || ''} ${e.message}`);
      await esperarMs(3000);
    }
  }
}

function pausarOuRetomar() {
  const g = gravacao;
  if (!g.rec || g.trocando || g.micPerdido || g.encerrando) return;
  try {
    if (g.pausado) {
      g.rec.resume(); g.pausado = false; g.desde = Date.now();
      g.tCorte = setTimeout(cortarPedaco, g.restanteCorte);
      $('#btn-pausar').textContent = 'Pausar';
      estadoGravacao('', 'Gravando');
      registrar('retomado');
    } else {
      g.rec.pause(); g.acumuladoMs += Date.now() - g.desde; g.pausado = true;
      clearTimeout(g.tCorte);
      g.restanteCorte = Math.max(1000, PEDACO_MS - (g.acumuladoMs % PEDACO_MS));
      $('#btn-pausar').textContent = 'Continuar';
      estadoGravacao('pausado', 'Pausado');
      registrar('pausado');
    }
  } catch (e) {
    registrar(`ERRO ao pausar/retomar: ${e.message}`);
    microfoneCaiu('falha ao pausar ou retomar');
  }
}

// Encerrar SEMPRE leva para a tela da reunião em poucos segundos, aconteça o que acontecer:
// cada espera tem prazo e o final fica num `finally`.
async function encerrar() {
  const g = gravacao;
  if (!g.reuniao || g.encerrando) return;
  g.encerrando = true;
  const r = g.reuniao;
  const botao = $('#btn-parar');
  botao.disabled = true; botao.textContent = 'Salvando…';
  registrar('encerrar tocado');
  try {
    if (!g.pausado) g.acumuladoMs += Date.now() - g.desde;
    g.pausado = true;
    clearTimeout(g.tCorte); clearInterval(g.tRelogio);
    await fecharParteAtual();
  } catch (e) {
    registrar(`ERRO ao encerrar: ${e.message}`);
  } finally {
    try { g.stream?.getTracks().forEach((t) => t.stop()); } catch { /* já parado */ }
    // Desligar o microfone faz até um gravador "surdo" entregar o último bloco: espera ele ir para o banco.
    await esperarMs(300);
    await comPrazo(g.escrita, 3000);
    g.wakeLock?.release?.().catch(() => {});
    g.audioCtx?.close?.().catch(() => {});
    r.duracaoSeg = g.acumuladoMs / 1000;
    r.contexto = $('#contexto').value.trim();
    for (const p of r.segmentos) p.fechado = true;
    r.status = 'processando';
    await comPrazo(salvarReuniao(r).catch((e) => registrar(`ERRO ao salvar no encerrar: ${e.message}`)), 4000);
    Object.assign(g, { rec: null, stream: null, reuniao: null, wakeLock: null, audioCtx: null, micPerdido: false, trocando: false });
    botao.disabled = false; botao.textContent = 'Encerrar';
    registrar(`encerrado: ${fmtDuracao(r.duracaoSeg)}, ${r.segmentos.length} parte(s)`);
    abrirDetalhe(r.id);
    processar(r.id);
  }
}

// Barrinhas de volume. Religa sozinho quando o microfone é trocado.
function ligarMedidor() {
  const canvas = $('#nivel');
  try {
    const g = gravacao;
    g.audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    g.audioCtx.resume?.().catch(() => {});
    const analisador = g.audioCtx.createAnalyser();
    analisador.fftSize = 512;
    g.audioCtx.createMediaStreamSource(g.stream).connect(analisador);
    g.analisador = analisador;
    if (g.medindo) return; // o laço de desenho já está rodando; só trocou a fonte
    g.medindo = true;
    const ctx2d = canvas.getContext('2d');
    const dados = new Uint8Array(analisador.fftSize);
    const barras = new Array(40).fill(0);
    const quadro = () => {
      if (!g.reuniao) { g.medindo = false; return; }
      g.analisador.getByteTimeDomainData(dados);
      let soma = 0;
      for (const v of dados) soma += ((v - 128) / 128) ** 2;
      const nivel = g.pausado ? 0 : Math.min(1, Math.sqrt(soma / dados.length) * 4);
      barras.push(nivel); barras.shift();
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.width / barras.length;
      ctx2d.fillStyle = g.pausado ? '#f59e0b' : '#ef4444';
      barras.forEach((b, i) => {
        const h = Math.max(3, b * canvas.height);
        ctx2d.fillRect(i * w + 1, (canvas.height - h) / 2, w - 2, h);
      });
      requestAnimationFrame(quadro);
    };
    quadro();
  } catch (e) {
    registrar(`medidor indisponível: ${e.message}`);
    canvas.hidden = true;
  }
}

// ---------- transcrição e resumo ----------

// Todas as falas da reunião, em ordem. Gravações antigas (antes da separação por pessoa)
// só têm texto corrido: viram uma fala sem dono (pessoa 0).
function falasDe(r) {
  const todas = [];
  for (const seg of r.segmentos || []) {
    const lista = seg.falas || (seg.texto ? [{ pessoa: 0, texto: seg.texto }] : []);
    for (const f of lista) {
      const ultima = todas[todas.length - 1];
      if (ultima && ultima.pessoa === f.pessoa && f.pessoa) ultima.texto += ' ' + f.texto;
      else todas.push({ ...f });
    }
  }
  return todas;
}

const nomeDe = (r, n) => (n ? r.nomes?.[n] || `Pessoa ${n}` : '');
const pessoasDe = (r) => [...new Set(falasDe(r).map((f) => f.pessoa).filter(Boolean))].sort((a, b) => a - b);

function transcricaoComNomes(r) {
  return falasDe(r).map((f) => (f.pessoa ? `${nomeDe(r, f.pessoa)}: ${f.texto}` : f.texto)).join('\n\n');
}

// Uma fila só: dois pedidos simultâneos para a mesma reunião sobrescreveriam um ao outro.
let fila = Promise.resolve();
const naFila = (fn) => (fila = fila.then(fn, fn));

function transcreverPendentes(id) {
  return naFila(async () => {
    const r = await lerReuniao(id);
    if (!r) return;
    for (const seg of r.segmentos) {
      if (seg.texto != null || (r.status === 'gravando' && !seg.fechado)) continue;
      // Contexto para manter a numeração: as últimas falas do trecho anterior, já rotuladas.
      const antes = falasDe({ segmentos: r.segmentos.filter((p) => p.n < seg.n) });
      const anterior = antes.slice(-12).map((f) => `Pessoa ${f.pessoa}: ${f.texto}`).join('\n').slice(-2500);
      const maior = antes.reduce((m, f) => Math.max(m, f.pessoa), 0);
      const t0 = Date.now();
      let falas;
      if (seg.janela) {
        // Áudio importado longo: o arquivo vai uma vez para o Google e cada parte é uma janela de tempo.
        try {
          falas = await transcreverJanela(await arquivoNoGoogle(id), seg.janela.de, seg.janela.ate, anterior, maior);
        } catch (e) {
          // O Google apagou o arquivo antes do prazo (ou ele se perdeu): envia de novo e tenta mais uma vez.
          if (![400, 403, 404].includes(e.status) || !/file/i.test(e.detalhe || '')) throw e;
          registrar(`arquivo no Google não vale mais (${e.status}); enviando de novo`);
          const x = await lerReuniao(id);
          delete x.arquivoGemini;
          await salvarReuniao(x);
          falas = await transcreverJanela(await arquivoNoGoogle(id), seg.janela.de, seg.janela.ate, anterior, maior);
        }
        registrar(`janela ${seg.n} (${fmtDuracao(seg.janela.de)}–${fmtDuracao(seg.janela.ate)}) transcrita em ${Math.round((Date.now() - t0) / 1000)} s, ${falas.length} falas`);
      } else {
        const audio = await lerAudio(id, seg.n);
        if (!audio) { seg.texto = ''; continue; }
        falas = await transcreverAudio(audio.blob, audio.mime || seg.mime, anterior, maior);
        registrar(`parte ${seg.n} transcrita em ${Math.round((Date.now() - t0) / 1000)} s (${Math.round(audio.blob.size / 1024)} KB, ${falas.length} falas)`);
      }
      const texto = falas.map((f) => `Pessoa ${f.pessoa}: ${f.texto}`).join('\n');
      // Reler antes de gravar: a tela de gravação pode ter acrescentado pedaços nesse meio-tempo.
      const atual = await lerReuniao(id);
      const alvo = atual.segmentos.find((p) => p.n === seg.n);
      if (alvo) Object.assign(alvo, { texto, falas });
      Object.assign(seg, { texto, falas });
      // A gravação em curso guarda a reunião na memória e a salva a cada 10 s;
      // sem isso ela apagaria o texto recém-chegado e o trecho seria pago duas vezes.
      const viva = gravacao.reuniao?.id === id && gravacao.reuniao.segmentos.find((p) => p.n === seg.n);
      if (viva) Object.assign(viva, { texto, falas });
      await salvarReuniao(atual);
      if (telaAberta === id) renderDetalhe(atual);
    }
  });
}

// ---------- importar áudio (Gravador do iPhone, WhatsApp, etc.) ----------
// O Gravador da Apple grava com a tela apagada e com outros apps abertos — coisa que um app de
// navegador não consegue no iPhone. A pessoa grava lá e traz o arquivo para cá.

const JANELA_SEG = 15 * 60;            // mesmas partes de 15 min da gravação pelo app
const DIRETO_ATE_BYTES = 14 * 1048576; // até aqui o áudio vai junto do pedido (limite ~20 MB em base64)

// Duração pelo próprio navegador; se ele não souber, estima pelo tamanho (~64 kbps, o padrão do Gravador).
function duracaoDoArquivo(arquivo) {
  return new Promise((ok) => {
    const url = URL.createObjectURL(arquivo);
    const a = new Audio();
    const fim = (seg) => { URL.revokeObjectURL(url); ok(seg); };
    const estimativa = () => fim(arquivo.size / 8000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => (Number.isFinite(a.duration) && a.duration > 0 ? fim(a.duration) : estimativa());
    a.onerror = estimativa;
    setTimeout(estimativa, 8000);
    a.src = url;
  });
}

async function importar(arquivo) {
  if (!arquivo) return;
  if (!/^audio\//.test(arquivo.type) && !/\.(m4a|mp3|wav|aac|ogg|opus|webm|flac|mp4)$/i.test(arquivo.name)) {
    return avisar('Esse arquivo não parece ser um áudio. No Gravador, use "Salvar em Arquivos" e escolha a gravação.', 6000);
  }
  const mime = tipoAudio(arquivo.type, arquivo.name);
  const duracao = await duracaoDoArquivo(arquivo);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const curto = arquivo.size <= DIRETO_ATE_BYTES && duracao <= JANELA_SEG + 60;
  const segmentos = curto
    ? [{ n: 0, mime, texto: null, fechado: true }]
    : Array.from({ length: Math.ceil(duracao / JANELA_SEG) }, (_, n) => ({
      n, mime, texto: null, fechado: true,
      janela: { de: n * JANELA_SEG, ate: Math.min((n + 1) * JANELA_SEG, Math.ceil(duracao)) },
    }));
  const r = {
    id, origem: 'importada', nomeArquivo: arquivo.name,
    // O arquivo guarda quando terminou de ser gravado; o início é isso menos a duração.
    inicio: new Date((arquivo.lastModified || Date.now()) - duracao * 1000).toISOString(),
    duracaoSeg: duracao, status: 'processando', contexto: arquivo.name.replace(/\.[^.]+$/, ''),
    segmentos, transcricao: '', resumo: null, erro: '',
  };
  registrar(`importado ${id}: ${arquivo.name} ${mime} ${Math.round(arquivo.size / 1024)} KB ${fmtDuracao(duracao)} → ${curto ? 'direto' : `${segmentos.length} janelas`}`);
  try {
    await salvarBloco(id, 0, 0, arquivo, mime); // guardado inteiro: é o que o player toca
    await salvarReuniao(r);
  } catch (e) {
    registrar(`ERRO ao guardar o arquivo importado: ${e.message}`);
    return avisar('Não consegui guardar esse áudio no celular (falta de espaço?).', 6000);
  }
  abrirDetalhe(id);
  processar(id);
}

// Endereço do áudio importado no Google; envia de novo se ainda não foi ou se já venceu (48 h).
let enviandoArquivo = null;
async function arquivoNoGoogle(id) {
  const r = await lerReuniao(id);
  if (r.arquivoGemini && r.arquivoGemini.expira > Date.now() + 2 * 3600 * 1000) return r.arquivoGemini;
  const audio = await lerAudio(id, 0);
  if (!audio) throw new Error('O arquivo de áudio não está mais neste celular.');
  enviandoArquivo = { id, mb: audio.blob.size / 1048576 };
  if (telaAberta === id) renderDetalhe(r);
  const t0 = Date.now();
  try {
    const arquivo = await enviarArquivo(audio.blob, tipoAudio(audio.mime, r.nomeArquivo), r.nomeArquivo);
    registrar(`arquivo enviado ao Google em ${Math.round((Date.now() - t0) / 1000)} s (${enviandoArquivo.mb.toFixed(1)} MB)`);
    const atual = await lerReuniao(id);
    atual.arquivoGemini = arquivo;
    await salvarReuniao(atual);
    return arquivo;
  } finally {
    enviandoArquivo = null;
  }
}

$('#btn-importar').addEventListener('click', () => $('#arquivo').click());
$('#arquivo').addEventListener('change', (e) => {
  const arquivo = e.target.files?.[0];
  e.target.value = ''; // permite escolher o mesmo arquivo de novo depois
  importar(arquivo);
});

// Uma reunião só é processada por vez: "Tentar de novo" tocado duas vezes, ou a retomada
// automática chegando junto, não dobram as chamadas ao Gemini.
const emProcesso = new Set();

async function processar(id) {
  if (emProcesso.has(id)) return;
  emProcesso.add(id);
  try { await processarAgora(id); } finally { emProcesso.delete(id); }
}

async function processarAgora(id) {
  let r = await lerReuniao(id);
  if (!r) return;
  registrar(`processando ${id}: ${r.segmentos.length} parte(s), ${fmtDuracao(r.duracaoSeg)}`);
  const inicioProcesso = Date.now();
  try {
    r.erro = ''; r.status = 'processando'; r.processandoDesde = inicioProcesso; await salvarReuniao(r);
    if (telaAberta === id) renderDetalhe(r);
    await transcreverPendentes(id);
    r = await lerReuniao(id);
    r.transcricao = transcricaoComNomes(r);
    await salvarReuniao(r);
    if (telaAberta === id) renderDetalhe(r);
    if (!r.transcricao.trim()) throw new Error('Não foi captada nenhuma fala na gravação.');
    const tAta = Date.now();
    r.resumo = await escreverAta({
      transcricao: r.transcricao, inicio: r.inicio, duracaoSeg: r.duracaoSeg, contexto: r.contexto,
    });
    registrar(`ata escrita em ${Math.round((Date.now() - tAta) / 1000)} s; total ${Math.round((Date.now() - inicioProcesso) / 1000)} s`);
    // Nomes que a ata descobriu entram no lugar de "Pessoa N" — menos os que você já escreveu.
    r.nomes ||= {}; r.nomesAuto ||= {};
    for (const p of r.resumo.pessoas || []) {
      const nome = String(p.nome || '').trim();
      if (nome && (!r.nomes[p.numero] || r.nomesAuto[p.numero])) {
        r.nomes[p.numero] = nome; r.nomesAuto[p.numero] = true;
      }
    }
    r.transcricao = transcricaoComNomes(r);
    r.status = 'pronta';
    registrar(`ata pronta ${id}`);
  } catch (e) {
    r = (await lerReuniao(id)) || r;
    r.status = 'erro'; r.erro = e.message; r.erroTipo = e.tipo || ''; r.erroEm = Date.now();
    registrar(`ERRO processando ${id}: [${r.erroTipo}] ${e.message}`);
  }
  await salvarReuniao(r);
  if (telaAberta === id) renderDetalhe(r);
  renderLista();
}

// ---------- detalhe ----------

let telaAberta = null;

async function abrirDetalhe(id) {
  telaAberta = id;
  const r = await lerReuniao(id);
  if (!r) return voltar();
  renderDetalhe(r);
  montarPlayer(r);
  mostrar('detalhe');
}

function voltar() {
  telaAberta = null;
  limparPlayer();
  renderLista();
  mostrar('inicio');
}

function lista(itens) {
  return itens?.length ? `<ul>${itens.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '<p class="sub">Nenhum.</p>';
}

function renderDetalhe(r) {
  const s = r.resumo;
  const total = r.segmentos.length;
  const feitos = r.segmentos.filter((p) => p.texto != null).length;
  const cab = `
    <div>
      <h1>${esc(s?.titulo || r.contexto || 'Reunião')}</h1>
      <p class="sub">${fmtData(r.inicio)} · ${fmtDuracao(r.duracaoSeg)}</p>
    </div>`;

  let corpo = '';
  if (r.status === 'processando' || r.status === 'gravando') {
    const etapa = (feita, ativa, texto) =>
      `<div class="etapa ${feita ? 'feita' : ''}"><span class="marca-etapa">${feita ? '✓' : ativa ? '<span class="girando">◌</span>' : '·'}</span>${texto}</div>`;
    const transcrito = total > 0 && feitos === total;
    corpo = `<div class="bloco etapas">
      ${etapa(true, false, r.origem === 'importada' ? 'Áudio importado' : 'Áudio salvo no celular')}
      ${enviandoArquivo?.id === r.id ? etapa(false, true, `Enviando o áudio para o Google (${enviandoArquivo.mb.toFixed(1).replace('.', ',')} MB)`) : ''}
      ${etapa(transcrito, !transcrito && enviandoArquivo?.id !== r.id, `Transcrevendo${total > 1 ? ` (${feitos} de ${total} partes)` : ''}`)}
      ${etapa(false, transcrito, 'Escrevendo a ata')}
      <p class="sub pequeno" style="margin-top:6px">Tempo: <span id="tempo-processando" data-desde="${r.processandoDesde || Date.now()}">0:00</span> · deixe o app aberto; pode ouvir a gravação enquanto isso.</p>
    </div>`;
  } else if (r.status === 'erro') {
    corpo = `<div class="bloco">
      <p class="erro">${esc(r.erro || 'Não foi possível processar.')}</p>
      <p class="sub" style="margin-top:8px">A gravação continua guardada neste celular.</p>
      <div class="acoes-detalhe" style="margin-top:12px"><button class="btn primario" data-acao="tentar">Tentar de novo</button>
        ${r.erroTipo === 'chave' ? '<button class="btn secundario" data-acao="ajustes">Trocar a chave</button>' : ''}</div>
    </div>`;
  }

  if (s) {
    // Links de verdade (<a>), não script: é o caminho que o celular sempre abre,
    // inclusive no iPhone, onde o compartilhar falhava depois de ler o banco.
    const assunto = `Ata: ${s.titulo}`;
    corpo += `
      <div class="bloco enviar">
        <h3>Enviar a ata</h3>
        <div class="acoes-detalhe">
          <a class="btn whats" href="https://wa.me/?text=${encodeURIComponent(textoParaCompartilhar(r, 'whats'))}" target="_blank" rel="noopener">WhatsApp</a>
          <a class="btn secundario" href="mailto:?subject=${encodeURIComponent(assunto)}&body=${encodeURIComponent(textoParaCompartilhar(r, 'email'))}">E-mail</a>
          <button class="btn secundario" data-acao="copiar">Copiar</button>
        </div>
      </div>
      <div class="bloco"><h3>Resumo</h3><p>${esc(s.resumo)}</p>
        ${participantes(r) ? `<p class="sub" style="margin-top:8px">Participantes: ${esc(participantes(r))}</p>` : ''}</div>
      <div class="bloco"><h3>Decisões</h3>${lista(s.decisoes)}</div>
      <div class="bloco"><h3>Tarefas</h3>${s.tarefas?.length ? `<ul>${s.tarefas.map((t) => `
        <li class="tarefa">${esc(t.descricao)}${t.responsavel || t.prazo ? `<small>${esc([t.responsavel, t.prazo].filter(Boolean).join(' · '))}</small>` : ''}</li>`).join('')}</ul>` : '<p class="sub">Nenhuma.</p>'}</div>
      <div class="bloco"><h3>Próximos passos</h3>${lista(s.proximos_passos)}</div>
      ${(s.topicos || []).map((t) => `<div class="bloco"><h3>${esc(t.titulo)}</h3>${lista(t.pontos)}</div>`).join('')}`;
  }

  const falas = falasDe(r);
  const pessoas = pessoasDe(r);
  if (pessoas.length && r.status !== 'gravando') {
    const papel = (n) => (s?.pessoas || []).find((p) => p.numero === n)?.papel || '';
    const qtd = (n) => falas.filter((f) => f.pessoa === n).length;
    corpo += `
      <div class="bloco">
        <h3>Quem falou</h3>
        <p class="sub pequeno" style="margin-bottom:10px">Escreva o nome de quem você reconhecer. A ata é refeita com os nomes.</p>
        <form id="form-nomes" class="pessoas">
          ${pessoas.map((n) => `
            <label class="pessoa">
              <span class="cor p${(n - 1) % 8}"></span>
              <input name="${n}" value="${esc(r.nomes?.[n] || '')}" placeholder="Pessoa ${n}" autocomplete="off">
              <small>${esc([papel(n), `${qtd(n)} ${qtd(n) === 1 ? 'fala' : 'falas'}`].filter(Boolean).join(' · '))}</small>
            </label>`).join('')}
          <button class="btn secundario" type="submit">Salvar nomes${s ? ' e refazer a ata' : ''}</button>
        </form>
      </div>`;
  }

  const transcricaoHtml = falas.length
    ? falas.map((f) => (f.pessoa
      ? `<div class="fala"><b class="t${(f.pessoa - 1) % 8}">${esc(nomeDe(r, f.pessoa))}</b> ${esc(f.texto)}</div>`
      : `<div class="fala">${esc(f.texto)}</div>`)).join('')
    : esc('Ainda não transcrito.');
  corpo += `
    <div class="bloco">
      <details data-chave="transcricao"><summary>Transcrição completa</summary><div class="transcricao">${transcricaoHtml}</div></details>
    </div>
`;
  $('#acoes-reuniao').innerHTML = `
      ${r.status === 'pronta' ? '<button class="btn secundario" data-acao="refazer">Refazer a ata</button>' : ''}
      <button class="btn secundario" data-acao="apagar">Apagar reunião</button>`;

  // Redesenhar não pode fechar o que a pessoa abriu (ex.: a transcrição, durante o processamento).
  const abertos = new Set([...document.querySelectorAll('#detalhe details[open]')].map((d) => d.dataset.chave));
  const mesmaReuniao = $('#detalhe').dataset.id === r.id;
  $('#detalhe').innerHTML = cab + corpo;
  if (mesmaReuniao) for (const d of document.querySelectorAll('#detalhe details')) if (abertos.has(d.dataset.chave)) d.open = true;
  $('#detalhe').dataset.id = r.id;
  reuniaoAberta = r;
}

// Relógio do processamento, sem redesenhar a tela.
setInterval(() => {
  const el = document.getElementById('tempo-processando');
  if (el) el.textContent = fmtDuracao((Date.now() - Number(el.dataset.desde)) / 1000);
}, 1000);

// ---------- ouvir a gravação ----------
// O player mora FORA da área que é redesenhada a cada etapa da transcrição: antes ele era
// apagado e fechado no meio do áudio. Só é montado ao abrir uma reunião.

let urlsAudio = [];
function limparPlayer() {
  for (const u of urlsAudio) URL.revokeObjectURL(u);
  urlsAudio = [];
  $('#player').innerHTML = '';
  $('#player').hidden = true;
}

function extensaoAudio(mime) {
  const t = mime || '';
  return /mp4|m4a/.test(t) ? 'm4a' : /aac/.test(t) ? 'aac' : /mp3|mpeg/.test(t) ? 'mp3'
    : /wav/.test(t) ? 'wav' : /flac/.test(t) ? 'flac' : /ogg/.test(t) ? 'ogg' : 'webm';
}

async function montarPlayer(r) {
  limparPlayer();
  if (!r.segmentos.length) return;
  const caixa = $('#player');
  caixa.hidden = false;
  const varias = r.origem !== 'importada' && r.segmentos.length > 1;
  caixa.innerHTML = `<details class="bloco" id="audios"><summary>Ouvir a gravação${varias ? ` (${r.segmentos.length} partes)` : ''}</summary><div id="lista-audios"><p class="sub pequeno">Carregando…</p></div></details>`;
  $('#audios').addEventListener('toggle', async (e) => {
    if (!e.target.open || $('#lista-audios').dataset.pronto) return;
    $('#lista-audios').dataset.pronto = '1';
    const lista = $('#lista-audios');
    lista.innerHTML = '';
    const data = new Date(r.inicio).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    for (const p of r.segmentos) {
      let a;
      try { a = await lerAudio(r.id, p.n); } catch (err) { registrar(`ERRO lendo áudio ${r.id}:${p.n}: ${err.message}`); }
      if (!a || !a.blob.size) continue;
      const tipo = (a.mime || 'audio/webm').split(';')[0];
      const url = URL.createObjectURL(new Blob([a.blob], { type: tipo }));
      urlsAudio.push(url);
      const nome = `reuniao-${data}${varias ? `-parte${p.n + 1}` : ''}.${extensaoAudio(tipo)}`;
      const item = document.createElement('div');
      item.className = 'parte-audio';
      item.innerHTML = `${varias ? `<small>Parte ${p.n + 1}</small>` : ''}
        <audio controls preload="metadata" src="${url}"></audio>
        <a class="btn-link" href="${url}" download="${nome}">Baixar áudio (${a.blob.size < 1048576 ? Math.max(1, Math.round(a.blob.size / 1024)) + " KB" : (a.blob.size / 1048576).toFixed(1).replace(".", ",") + " MB"})</a>
        <p class="erro pequeno" hidden>Este celular não conseguiu tocar aqui. Use "Baixar áudio" e abra no app de música.</p>`;
      const audio = item.querySelector('audio');
      // Áudio gravado pelo celular (webm) vem sem duração: o player mostra 0:00 e não deixa avançar.
      // Pular para o fim e voltar faz o navegador calcular a duração de verdade.
      audio.addEventListener('loadedmetadata', () => {
        if (audio.duration !== Infinity) return;
        audio.currentTime = 1e7;
        audio.addEventListener('timeupdate', function volta() {
          audio.removeEventListener('timeupdate', volta);
          audio.currentTime = 0;
        });
      });
      audio.addEventListener('error', () => {
        registrar(`ERRO tocando parte ${p.n} (${tipo}): código ${audio.error?.code}`);
        item.querySelector('.erro').hidden = false;
      });
      // Uma parte termina, a próxima começa.
      audio.addEventListener('ended', () => item.nextElementSibling?.querySelector('audio')?.play().catch(() => {}));
      lista.append(item);
    }
    if (!lista.children.length) lista.innerHTML = '<p class="sub pequeno">Não encontrei o áudio desta reunião neste celular.</p>';
  });
}

// Guardada na hora de desenhar: compartilhar precisa sair no mesmo toque, sem esperar o banco.
let reuniaoAberta = null;

// "Ricardo (corretor), Carlos, Pessoa 3" — ou a lista antiga, de atas de antes da separação por pessoa.
function participantes(r) {
  const pessoas = pessoasDe(r);
  if (!pessoas.length) return (r.resumo?.participantes || []).join(', ');
  return pessoas.map((n) => {
    const papel = (r.resumo?.pessoas || []).find((p) => p.numero === n)?.papel;
    return papel ? `${nomeDe(r, n)} (${papel})` : nomeDe(r, n);
  }).join(', ');
}

$('#detalhe').addEventListener('submit', async (e) => {
  if (e.target.id !== 'form-nomes') return;
  e.preventDefault();
  const r = await lerReuniao($('#detalhe').dataset.id);
  r.nomes ||= {}; r.nomesAuto ||= {};
  for (const [n, valor] of new FormData(e.target)) {
    const nome = String(valor).trim();
    if (nome === (r.nomes[n] || '')) continue; // não mexeu: um nome sugerido continua sugerido
    if (nome) r.nomes[n] = nome; else delete r.nomes[n];
    delete r.nomesAuto[n]; // escrito por você: a ata não troca mais
  }
  r.transcricao = transcricaoComNomes(r);
  await salvarReuniao(r);
  if (r.resumo) { r.resumo = null; await salvarReuniao(r); processar(r.id); }
  else renderDetalhe(r);
  avisar('Nomes salvos.');
});


$('#tela-detalhe').addEventListener('click', async (e) => {
  const acao = e.target.dataset?.acao;
  if (!acao) return;
  if (acao === 'copiar') return copiarAta();
  const id = $('#detalhe').dataset.id;
  const r = await lerReuniao(id);
  if (acao === 'tentar') processar(id);
  if (acao === 'ajustes') abrirAjustes();
  if (acao === 'refazer') { r.resumo = null; await salvarReuniao(r); processar(id); }
  if (acao === 'apagar' && confirm('Apagar esta reunião e o áudio dela deste celular?')) {
    await apagarReuniao(r);
    voltar();
  }
});

// A ata inteira em texto. No WhatsApp, *asterisco* vira negrito; no e-mail vira MAIÚSCULA.
function textoParaCompartilhar(r, formato = 'whats') {
  const s = r.resumo;
  if (!s) return r.transcricao || '';
  const titulo = (t) => (formato === 'whats' ? `*${t}*` : t.toUpperCase());
  // Toda parte sai com título, mesmo vazia: a ata fica sempre com a mesma divisão.
  const secao = (nome, arr, vazio) => `\n${titulo(nome)}\n${arr?.length ? arr.map((i) => `• ${i}`).join('\n') : vazio}`;
  const partes = [
    titulo(s.titulo), `${fmtData(r.inicio)} · ${fmtDuracao(r.duracaoSeg)}`,
    participantes(r) ? `Participantes: ${participantes(r)}` : null,
    `\n${titulo('Resumo')}\n${s.resumo}`,
    secao('Decisões', s.decisoes, 'Nenhuma decisão registrada.'),
    secao('Tarefas', s.tarefas?.map((t) => [t.descricao, t.responsavel, t.prazo].filter(Boolean).join(' — ')), 'Nenhuma tarefa registrada.'),
    secao('Próximos passos', s.proximos_passos, 'Nenhum próximo passo registrado.'),
    ...(s.topicos || []).filter((t) => t.pontos?.length).map((t) => secao(t.titulo, t.pontos, '')),
  ];
  return partes.filter((x) => typeof x === 'string').join('\n');
}

async function copiarAta() {
  const texto = reuniaoAberta && textoParaCompartilhar(reuniaoAberta);
  if (!texto) return avisar('Ainda não há ata para copiar.');
  try {
    await navigator.clipboard.writeText(texto);
    avisar('Ata copiada. É só colar no WhatsApp ou no e-mail.');
  } catch {
    avisar('Não consegui copiar. Use os botões WhatsApp ou E-mail.');
  }
}

$('#btn-compartilhar').addEventListener('click', () => {
  const r = reuniaoAberta;
  const texto = r && textoParaCompartilhar(r);
  if (!texto) return avisar('Ainda não há ata para compartilhar.');
  if (!navigator.share) return copiarAta();
  // Sem await antes: o navegador só abre o menu de compartilhar dentro do próprio toque.
  navigator.share({ text: texto }).catch((e) => {
    if (e.name !== 'AbortError') copiarAta(); // falhou de verdade (não foi cancelado): copia
  });
});

// ---------- início ----------

$('#btn-gravar').addEventListener('click', comecar);
$('#btn-pausar').addEventListener('click', pausarOuRetomar);
$('#btn-parar').addEventListener('click', encerrar);
$('#btn-voltar').addEventListener('click', voltar);

// Fechar a aba no meio da gravação: o navegador pergunta antes.
// Fechar a aba no meio da gravação: pede o último bloco ao gravador e o navegador pergunta antes de sair.
window.addEventListener('beforeunload', (e) => {
  if (!gravacao.reuniao) return;
  try { gravacao.rec?.requestData(); } catch { /* já parado */ }
  e.preventDefault();
});

function abrirAjustes() {
  $('#chave').value = '';
  $('#erro-entrar').hidden = true;
  $('#btn-cancelar-chave').hidden = !chaveGemini();
  $('#btn-diagnostico').hidden = !chaveGemini();
  mostrar('entrar');
}
$('#btn-ajustes').addEventListener('click', abrirAjustes);
$('#btn-cancelar-chave').addEventListener('click', () => { renderLista(); mostrar('inicio'); });

// Copia os últimos acontecimentos (sem áudio nem texto das reuniões) para mandar a quem for consertar.
$('#btn-diagnostico').addEventListener('click', async () => {
  let linhas = [];
  try { linhas = JSON.parse(localStorage.getItem('ata-diagnostico') || '[]'); } catch { /* vazio */ }
  const reunioes = (await todasReunioes()).sort((x, y) => y.inicio.localeCompare(x.inicio)).slice(0, 5)
    .map((r) => `${r.id} ${r.status} ${fmtDuracao(r.duracaoSeg)} partes=${r.segmentos.length} ${r.erroTipo || ''} ${r.erro || ''}`.trim());
  const relatorio = ['Relatório ATA Elevatis', navigator.userAgent, `modelo: ${modeloGemini()}`, '',
    'Reuniões:', ...reunioes, '', 'Acontecimentos:', ...linhas].join('\n');
  try {
    await navigator.clipboard.writeText(relatorio);
    avisar('Relatório copiado. Cole no WhatsApp para quem cuida do app.');
  } catch {
    avisar('Não consegui copiar o relatório neste celular.');
  }
});

$('#form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chave = $('#chave').value.trim();
  const botao = $('#btn-entrar');
  botao.disabled = true; botao.textContent = 'Conferindo...';
  $('#erro-entrar').hidden = true;
  try {
    // Testa a chave de verdade e já descobre qual modelo gratuito usar.
    const modelo = await escolherModelo(chave);
    localStorage.setItem('ata-chave', chave);
    localStorage.setItem('ata-modelo', modelo);
    // Reuniões que falharam por causa da chave voltam para a fila.
    for (const r of await todasReunioes()) if (r.status === 'erro' && r.segmentos.length) processar(r.id);
    iniciar();
  } catch (erro) {
    $('#erro-entrar').textContent = erro.tipo === 'rede' ? erro.message : 'Essa chave não funcionou. Confira se copiou inteira.';
    $('#erro-entrar').hidden = false;
  } finally {
    botao.disabled = false; botao.textContent = 'Salvar chave';
  }
});

async function iniciar() {
  if (!chaveGemini()) return abrirAjustes();
  // Gravação interrompida (app fechou, bateria acabou): aproveita o que foi salvo.
  for (const r of await todasReunioes()) {
    if (r.status === 'gravando') {
      for (const p of r.segmentos) p.fechado = true;
      r.status = r.segmentos.length ? 'processando' : 'erro';
      r.erro = r.segmentos.length ? '' : 'A gravação foi interrompida antes de salvar qualquer áudio.';
      await salvarReuniao(r);
      if (r.segmentos.length) { avisar('Recuperei uma gravação que foi interrompida.'); processar(r.id); }
    } else if (r.status === 'processando') {
      processar(r.id);
    }
  }
  await renderLista();
  mostrar('inicio');
  retomarPassageiras();
}

// Falhas passageiras (Google sobrecarregado, sem internet) tentam de novo sozinhas
// quando a internet volta ou o app volta para a tela — sem precisar tocar em nada.
let retomando = false;
async function retomarPassageiras() {
  if (retomando || !chaveGemini() || gravacao.reuniao) return;
  retomando = true;
  try {
    for (const r of await todasReunioes()) {
      // A segunda condição pega erros 5xx gravados por versões antigas do app, sem o tipo.
      const passageira = ['ocupado', 'rede', 'minuto'].includes(r.erroTipo) || /\(5\d\d\)/.test(r.erro || '')
        || (r.erroTipo === 'limite' && Date.now() - (r.erroEm || 0) > 3 * 3600 * 1000); // limite diário: tenta horas depois
      if (r.status === 'erro' && passageira && r.segmentos.length) await processar(r.id);
    }
  } finally {
    retomando = false;
  }
}
window.addEventListener('online', retomarPassageiras);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') retomarPassageiras(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.storage?.persist?.(); // pede ao navegador para não apagar as gravações quando faltar espaço
iniciar();
