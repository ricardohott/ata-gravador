// ATA Elevatis — gravador de reuniões presenciais.
//
// Como a gravação funciona:
// - O áudio é cortado em pedaços de 15 min. Cada pedaço é um arquivo completo e
//   independente, então dá para transcrever enquanto a reunião continua e o resumo
//   sai poucos segundos depois de encerrar.
// - Tudo vai para o IndexedDB do celular a cada 10 s. Se o app fechar no meio,
//   o que foi gravado até ali é recuperado na próxima abertura.

'use strict';

// 15 min: cada corte é um ponto onde a numeração de quem fala pode se perder,
// então menos cortes = menos trocas. 15 min a 32 kbps ≈ 3,6 MB, bem abaixo do limite do Gemini.
const PEDACO_MS = 15 * 60 * 1000;
const SALVAR_MS = 10 * 1000;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- banco local (IndexedDB) ----------

const banco = new Promise((ok, falha) => {
  const r = indexedDB.open('ata', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('reunioes', { keyPath: 'id' });
    r.result.createObjectStore('audios'); // chave "<id>:<n>" -> { blob, mime }
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
  });
}
const lerReuniao = (id) => bd('reunioes', 'readonly', (s) => s.get(id));
const salvarReuniao = (r) => bd('reunioes', 'readwrite', (s) => s.put(r));
const todasReunioes = () => bd('reunioes', 'readonly', (s) => s.getAll());
const lerAudio = (id, n) => bd('audios', 'readonly', (s) => s.get(`${id}:${n}`));
const salvarAudio = (id, n, blob, mime) => bd('audios', 'readwrite', (s) => s.put({ blob, mime }, `${id}:${n}`));

async function apagarReuniao(r) {
  await bd('reunioes', 'readwrite', (s) => s.delete(r.id));
  await bd('audios', 'readwrite', (s) => { for (const p of r.segmentos) s.delete(`${r.id}:${p.n}`); });
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
        <span class="selo ${r.status}">${ROTULO[r.status] || r.status}</span></span>
    </li>`).join('');
}
$('#lista').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (li) abrirDetalhe(li.dataset.id);
});

// ---------- gravação ----------

const gravacao = {
  reuniao: null, stream: null, rec: null, mime: '', pedacos: [], n: 0,
  acumuladoMs: 0, desde: 0, pausado: false, tCorte: null, tRelogio: null, tSalvar: null,
  wakeLock: null, audioCtx: null, encerrando: false,
};

function escolherMime() {
  for (const m of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

const decorridoMs = () => gravacao.acumuladoMs + (gravacao.pausado || !gravacao.desde ? 0 : Date.now() - gravacao.desde);

async function manterTelaLigada() {
  try { gravacao.wakeLock = await navigator.wakeLock?.request('screen'); }
  catch { /* sem suporte: o aviso na tela já pede para manter aberto */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gravacao.rec) manterTelaLigada();
});

async function comecar() {
  $('#aviso-mic').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $('#aviso-mic').textContent = 'Este navegador não grava áudio. Use o Chrome (Android) ou o Safari (iPhone).';
    $('#aviso-mic').hidden = false;
    return;
  }
  try {
    // Sem cancelamento de eco: ele foi feito para chamada e abafa quem fala longe do celular.
    gravacao.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    $('#aviso-mic').textContent = 'Sem acesso ao microfone. Libere a permissão nas configurações do navegador e tente de novo.';
    $('#aviso-mic').hidden = false;
    return;
  }

  gravacao.mime = escolherMime();
  gravacao.reuniao = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    inicio: new Date().toISOString(), duracaoSeg: 0, status: 'gravando',
    contexto: '', segmentos: [], transcricao: '', resumo: null, erro: '',
  };
  Object.assign(gravacao, { n: 0, acumuladoMs: 0, desde: Date.now(), pausado: false, encerrando: false });
  await salvarReuniao(gravacao.reuniao);

  $('#contexto').value = '';
  $('#btn-pausar').textContent = 'Pausar';
  $('#estado-gravacao').className = 'estado';
  $('#estado-gravacao').innerHTML = '<span class="pulso"></span> Gravando';
  mostrar('gravando');

  iniciarPedaco();
  manterTelaLigada();
  desenharNivel();
  gravacao.tRelogio = setInterval(() => { $('#cronometro').textContent = fmtDuracao(decorridoMs() / 1000); }, 250);
  gravacao.tSalvar = setInterval(salvarParcial, SALVAR_MS);
}

function iniciarPedaco() {
  const rec = new MediaRecorder(gravacao.stream, { ...(gravacao.mime ? { mimeType: gravacao.mime } : {}), audioBitsPerSecond: 32000 });
  const n = gravacao.n;
  const pedacos = [];
  gravacao.rec = rec;
  gravacao.pedacos = pedacos;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) pedacos.push(e.data); };
  rec.onstop = () => { gravacao.fechando = fecharPedaco(n, pedacos, rec.mimeType || gravacao.mime); };
  rec.start(SALVAR_MS);
  // Corta a cada 15 min de gravação efetiva (pausa não conta).
  clearTimeout(gravacao.tCorte);
  gravacao.tCorte = setTimeout(cortarPedaco, PEDACO_MS);
}

function cortarPedaco() {
  if (!gravacao.rec || gravacao.encerrando) return;
  const antigo = gravacao.rec;
  gravacao.n += 1;
  iniciarPedaco(); // o novo começa antes de o antigo parar: nenhum som se perde no corte
  antigo.stop();
}

async function salvarParcial() {
  const r = gravacao.reuniao;
  if (!r || !gravacao.pedacos.length) return;
  const n = gravacao.n;
  await salvarAudio(r.id, n, new Blob(gravacao.pedacos, { type: gravacao.mime }), gravacao.mime);
  if (!r.segmentos.some((p) => p.n === n)) r.segmentos.push({ n, mime: gravacao.mime, texto: null });
  r.duracaoSeg = decorridoMs() / 1000;
  r.contexto = $('#contexto').value.trim();
  await salvarReuniao(r);
}

async function fecharPedaco(n, pedacos, mime) {
  const r = gravacao.reuniao;
  if (!r || !pedacos.length) return;
  await salvarAudio(r.id, n, new Blob(pedacos, { type: mime }), mime);
  const seg = r.segmentos.find((p) => p.n === n);
  if (seg) { seg.mime = mime; seg.fechado = true; }
  else r.segmentos.push({ n, mime, texto: null, fechado: true });
  r.segmentos.sort((a, b) => a.n - b.n);
  await salvarReuniao(r);
  if (!gravacao.encerrando) transcreverPendentes(r.id).catch(() => { /* tenta de novo no fim */ });
}

function pausarOuRetomar() {
  const g = gravacao;
  if (!g.rec) return;
  if (g.pausado) {
    g.rec.resume(); g.pausado = false; g.desde = Date.now();
    g.tCorte = setTimeout(cortarPedaco, g.restanteCorte);
    $('#btn-pausar').textContent = 'Pausar';
    $('#estado-gravacao').className = 'estado';
    $('#estado-gravacao').innerHTML = '<span class="pulso"></span> Gravando';
  } else {
    g.rec.pause(); g.acumuladoMs += Date.now() - g.desde; g.pausado = true;
    clearTimeout(g.tCorte);
    g.restanteCorte = PEDACO_MS - (g.acumuladoMs % PEDACO_MS);
    $('#btn-pausar').textContent = 'Continuar';
    $('#estado-gravacao').className = 'estado pausado';
    $('#estado-gravacao').innerHTML = '<span class="pulso"></span> Pausado';
  }
}

async function encerrar() {
  const g = gravacao;
  if (!g.rec || g.encerrando) return;
  g.encerrando = true;
  $('#btn-parar').disabled = true;
  if (!g.pausado) g.acumuladoMs += Date.now() - g.desde;
  g.pausado = true;
  clearTimeout(g.tCorte); clearInterval(g.tRelogio); clearInterval(g.tSalvar);

  const parou = new Promise((ok) => g.rec.addEventListener('stop', () => setTimeout(ok, 0), { once: true }));
  g.rec.stop();
  await parou;
  await g.fechando; // o último pedaço precisa estar inteiro no banco antes de transcrever
  g.stream.getTracks().forEach((t) => t.stop());
  g.wakeLock?.release().catch(() => {});
  g.audioCtx?.close().catch(() => {});

  const r = g.reuniao;
  r.duracaoSeg = g.acumuladoMs / 1000;
  r.contexto = $('#contexto').value.trim();
  r.status = 'processando';
  await salvarReuniao(r);
  Object.assign(g, { rec: null, stream: null, reuniao: null, wakeLock: null, audioCtx: null });
  $('#btn-parar').disabled = false;

  abrirDetalhe(r.id);
  processar(r.id);
}

function desenharNivel() {
  const canvas = $('#nivel');
  const ctx2d = canvas.getContext('2d');
  try {
    gravacao.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analisador = gravacao.audioCtx.createAnalyser();
    analisador.fftSize = 512;
    gravacao.audioCtx.createMediaStreamSource(gravacao.stream).connect(analisador);
    const dados = new Uint8Array(analisador.fftSize);
    const barras = new Array(40).fill(0);
    const quadro = () => {
      if (!gravacao.rec) return;
      analisador.getByteTimeDomainData(dados);
      let soma = 0;
      for (const v of dados) soma += ((v - 128) / 128) ** 2;
      const nivel = gravacao.pausado ? 0 : Math.min(1, Math.sqrt(soma / dados.length) * 4);
      barras.push(nivel); barras.shift();
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      const w = canvas.width / barras.length;
      ctx2d.fillStyle = gravacao.pausado ? '#f59e0b' : '#ef4444';
      barras.forEach((b, i) => {
        const h = Math.max(3, b * canvas.height);
        ctx2d.fillRect(i * w + 1, (canvas.height - h) / 2, w - 2, h);
      });
      requestAnimationFrame(quadro);
    };
    quadro();
  } catch { canvas.hidden = true; }
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
      const audio = await lerAudio(id, seg.n);
      if (!audio) { seg.texto = ''; continue; }
      // Contexto para manter a numeração: as últimas falas do trecho anterior, já rotuladas.
      const antes = falasDe({ segmentos: r.segmentos.filter((p) => p.n < seg.n) });
      const anterior = antes.slice(-12).map((f) => `Pessoa ${f.pessoa}: ${f.texto}`).join('\n').slice(-2500);
      const maior = antes.reduce((m, f) => Math.max(m, f.pessoa), 0);
      const falas = await transcreverAudio(audio.blob, audio.mime || seg.mime, anterior, maior);
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

async function processar(id) {
  let r = await lerReuniao(id);
  try {
    r.erro = ''; r.status = 'processando'; await salvarReuniao(r);
    if (telaAberta === id) renderDetalhe(r);
    await transcreverPendentes(id);
    r = await lerReuniao(id);
    r.transcricao = transcricaoComNomes(r);
    await salvarReuniao(r);
    if (telaAberta === id) renderDetalhe(r);
    if (!r.transcricao.trim()) throw new Error('Não foi captada nenhuma fala na gravação.');
    r.resumo = await escreverAta({
      transcricao: r.transcricao, inicio: r.inicio, duracaoSeg: r.duracaoSeg, contexto: r.contexto,
    });
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
  } catch (e) {
    r = (await lerReuniao(id)) || r;
    r.status = 'erro'; r.erro = e.message; r.erroTipo = e.tipo || '';
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
  mostrar('detalhe');
}

function voltar() {
  telaAberta = null;
  for (const a of document.querySelectorAll('#detalhe audio')) URL.revokeObjectURL(a.src);
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
      ${etapa(true, false, 'Áudio salvo no celular')}
      ${etapa(transcrito, !transcrito, `Transcrevendo${total > 1 ? ` (${feitos} de ${total} partes)` : ''}`)}
      ${etapa(false, transcrito, 'Escrevendo a ata')}
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
      <details><summary>Transcrição completa</summary><div class="transcricao">${transcricaoHtml}</div></details>
    </div>
    <div class="bloco"><details id="audios"><summary>Ouvir a gravação (${total} ${total === 1 ? 'parte' : 'partes'})</summary><div id="lista-audios"></div></details></div>
    <div class="acoes-detalhe">
      ${r.status === 'pronta' ? '<button class="btn secundario" data-acao="refazer">Refazer a ata</button>' : ''}
      <button class="btn secundario" data-acao="apagar">Apagar reunião</button>
    </div>`;

  $('#detalhe').innerHTML = cab + corpo;
  $('#detalhe').dataset.id = r.id;
  reuniaoAberta = r;
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

$('#detalhe').addEventListener('toggle', async (e) => {
  if (e.target.id !== 'audios' || !e.target.open) return;
  const id = $('#detalhe').dataset.id;
  const r = await lerReuniao(id);
  const caixa = $('#lista-audios');
  caixa.innerHTML = '';
  for (const p of r.segmentos) {
    const a = await lerAudio(id, p.n);
    if (!a) continue;
    const el = document.createElement('audio');
    el.controls = true; el.preload = 'metadata';
    el.src = URL.createObjectURL(a.blob);
    caixa.append(el);
  }
}, true);

$('#detalhe').addEventListener('click', async (e) => {
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
window.addEventListener('beforeunload', (e) => { if (gravacao.rec) { salvarParcial(); e.preventDefault(); } });

function abrirAjustes() {
  $('#chave').value = '';
  $('#erro-entrar').hidden = true;
  $('#btn-cancelar-chave').hidden = !chaveGemini();
  mostrar('entrar');
}
$('#btn-ajustes').addEventListener('click', abrirAjustes);
$('#btn-cancelar-chave').addEventListener('click', () => { renderLista(); mostrar('inicio'); });

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
  if (retomando || !chaveGemini() || gravacao.rec) return;
  retomando = true;
  try {
    for (const r of await todasReunioes()) {
      // A segunda condição pega erros 5xx gravados por versões antigas do app, sem o tipo.
      const passageira = ['ocupado', 'rede'].includes(r.erroTipo) || /\(5\d\d\)/.test(r.erro || '');
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
