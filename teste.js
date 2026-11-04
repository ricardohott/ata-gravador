// Teste de fumaça: confere que todos os arquivos do app são servidos e que o
// esquema da ata está coerente. O resto (gravar, Gemini) roda no navegador. `npm test`
const fs = require('fs');
const vm = require('vm');
const app = require('./server');

let ok = 0, falhas = 0;
function confere(nome, cond) {
  if (cond) { ok++; console.log('  ok  ', nome); } else { falhas++; console.log('  FALHOU', nome); }
}

// gemini.js roda num contexto isolado só para ler o esquema
const ctx = { localStorage: { getItem: () => null }, fetch: () => {} };
vm.runInNewContext(fs.readFileSync('public/gemini.js', 'utf8') + ';this.ESQUEMA_ATA = ESQUEMA_ATA; this.ESQUEMA_FALAS = ESQUEMA_FALAS; this.tipoAudio = tipoAudio; this.relogio = relogio; this.lerFalas = lerFalas; this.lerJson = lerJson; this.ordemParaAudio = ordemParaAudio; this.lerLimite = lerLimite; this.proximaRenovacao = proximaRenovacao;', ctx);

const servidor = app.listen(0, async () => {
  const base = `http://localhost:${servidor.address().port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    confere('página inicial abre', html.includes('btn-gravar'));
    confere('gemini.js carrega antes do app.js', html.indexOf('gemini.js') < html.indexOf('app.js'));
    for (const f of ['/app.js', '/gemini.js', '/groq.js', '/m4a.js', '/pdf.js', '/jspdf.umd.min.js', '/style.css', '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png', '/marca.svg']) {
      confere(`${f} existe`, (await fetch(base + f)).ok);
    }
    const sw = fs.readFileSync('public/sw.js', 'utf8');
    for (const f of ['gemini.js', 'app.js', 'style.css']) confere(`${f} no cache offline`, sw.includes(`'${f}'`));

    const obrigatoriosOk = (s) => s.type !== 'object' ||
      (Object.keys(s.properties).every((k) => s.required.includes(k)) &&
        Object.values(s.properties).every((p) => obrigatoriosOk(p.items || p)));
    confere('esquema da ata: todo campo é obrigatório', obrigatoriosOk(ctx.ESQUEMA_ATA));
    confere('esquema das falas: todo campo é obrigatório', obrigatoriosOk(ctx.ESQUEMA_FALAS));
    confere('ata pede quem é cada pessoa', 'pessoas' in ctx.ESQUEMA_ATA.properties);
    confere('m4a do Gravador do iPhone vira audio/m4a', ctx.tipoAudio('audio/x-m4a', 'Gravação.m4a') === 'audio/m4a');
    confere('arquivo sem tipo é reconhecido pela extensão', ctx.tipoAudio('', 'reuniao.mp3') === 'audio/mp3');
    confere('janela de tempo em h:mm:ss', ctx.relogio(3725) === '1:02:05');

    // Respostas ruins do Gemini têm que virar falha repetível, nunca erro final nem texto errado.
    const resposta = (texto, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: texto }] } }] });
    const tipoDoErro = (f) => { try { f(); return 'nenhum'; } catch (e) { return e.tipo; } };
    confere('bloqueio sem resposta = vazia', tipoDoErro(() => ctx.lerFalas({ promptFeedback: { blockReason: 'OTHER' } })) === 'vazia');
    confere('texto vazio = vazia', tipoDoErro(() => ctx.lerFalas(resposta(''))) === 'vazia');
    confere('resposta cortada = vazia', tipoDoErro(() => ctx.lerFalas(resposta('{"falas":[{"pessoa":1,', 'MAX_TOKENS'))) === 'vazia');
    confere('JSON quebrado = vazia', tipoDoErro(() => ctx.lerFalas(resposta('{"falas":['))) === 'vazia');
    const presa = JSON.stringify({ falas: Array.from({ length: 6 }, () => ({ pessoa: 1, texto: 'Vamos fechar esse pedido na semana que vem.' })) });
    confere('frase repetida em laço = vazia', tipoDoErro(() => ctx.lerFalas(resposta(presa))) === 'vazia');
    const normal = JSON.stringify({ falas: [{ pessoa: 1, texto: 'Sim.' }, { pessoa: 1, texto: 'Sim.' }, { pessoa: 2, texto: ' Fechado. ' }, { pessoa: 2, texto: '' }] });
    const lidas = ctx.lerFalas(resposta(normal));
    confere('falas normais são lidas e juntadas', lidas.length === 2 && lidas[0].texto === 'Sim. Sim.' && lidas[1].texto === 'Fechado.');
    confere('silêncio (lista vazia) não é erro', ctx.lerFalas(resposta('{"falas":[]}')).length === 0);
    const ordem = ctx.ordemParaAudio(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-2.5-flash', 'gemini-flash-lite-latest']);
    confere('áudio evita 3.8 e flash-latest', ordem[0] === 'gemini-3.6-flash' && ordem[1] === 'gemini-2.5-flash' && ordem.indexOf('gemini-3.8-flash') > ordem.indexOf('gemini-flash-lite-latest'));

    // Limites do Google: o tipo vem nos detalhes do erro, não no texto.
    const erro429 = (quotaId, retryDelay) => ({ message: 'You exceeded your current quota.', details: [{ violations: [{ quotaId }] }, { retryDelay }] });
    const dia = ctx.lerLimite(erro429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s'));
    confere('limite diário é reconhecido pelos detalhes', dia.diario === true);
    const minuto = ctx.lerLimite(erro429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '12s'));
    confere('limite por minuto não é confundido com o diário', minuto.diario === false && minuto.esperaMs === 13000);
    confere('espera também é lida do texto do erro', ctx.lerLimite({ message: 'Please retry in 7.5s.' }).esperaMs === 8500);
    const agora = Date.UTC(2026, 10, 4, 20, 0, 0); // 04/11, 12:00 em Los Angeles (UTC-8)
    confere('renovação na meia-noite do Pacífico', ctx.proximaRenovacao(agora) === Date.UTC(2026, 10, 5, 8, 0, 0));

    // Corte de m4a real (fixture de 20 s, gerada com ffmpeg)
    const ctxM4a = { Blob, Uint8Array, DataView, Math, Number, String, Set, Array, Infinity };
    vm.runInNewContext(fs.readFileSync('public/m4a.js', 'utf8') + ';this.lerIndiceM4a = lerIndiceM4a; this.trechoAac = trechoAac; this.trechoM4a = trechoM4a;', ctxM4a);
    const fixture = new Blob([fs.readFileSync('teste-audio.m4a')]);
    const indice = await ctxM4a.lerIndiceM4a(fixture);
    confere('lê o índice do m4a', !!indice && Math.abs(indice.segundos - 20) < 0.2);
    const parte = await ctxM4a.trechoAac(fixture, indice, 5, 10);
    const bytes = new Uint8Array(await parte.arrayBuffer());
    confere('trecho cortado começa com cabeçalho ADTS', bytes[0] === 0xff && (bytes[1] & 0xf0) === 0xf0);
    confere('trecho tem o tamanho esperado', Math.abs(parte.size / fixture.size - 0.25) < 0.05);
    const m4aMenor = await ctxM4a.trechoM4a(fixture, indice, 5, 10);
    const reaberto = await ctxM4a.lerIndiceM4a(m4aMenor);
    confere('m4a gerado para a reserva é um m4a válido de 5 s', !!reaberto && Math.abs(reaberto.segundos - 5) < 0.2);
    confere('arquivo que não é m4a devolve null', (await ctxM4a.lerIndiceM4a(new Blob(['nao sou audio nenhum']))) === null);
  } catch (e) {
    falhas++; console.error(e);
  }
  servidor.close();
  console.log(falhas ? `\n${falhas} FALHA(S), ${ok} ok` : `\nTudo certo: ${ok} de ${ok}`);
  process.exit(falhas ? 1 : 0);
});
