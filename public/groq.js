// Reserva opcional: quando todos os modelos do Gemini param, a transcrição continua no Groq.
// A chave também é gratuita, fica só no celular e só vai para o Groq.
// Limite importante: o Whisper não separa quem fala, então essas partes vêm sem "Pessoa N".

'use strict';

const GROQ = 'https://api.groq.com/openai/v1';
const MODELOS_GROQ_AUDIO = ['whisper-large-v3', 'whisper-large-v3-turbo'];
const MODELO_GROQ_ATA = 'openai/gpt-oss-120b';
const LIMITE_ARQUIVO_GROQ = 25 * 1048576;
// No plano grátis um pedido de texto cabe em ~8 mil tokens por minuto; acima disso a ata espera o Gemini.
const LIMITE_ATA_GROQ_CARACTERES = 15000;

const chaveGroq = () => localStorage.getItem('ata-chave-groq') || '';

async function chamarGroq(caminho, corpo, chave = chaveGroq()) {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), corpo ? 4 * 60 * 1000 : 20000);
  let r, dados;
  try {
    const ehForm = corpo instanceof FormData;
    r = await fetch(`${GROQ}/${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${chave}`, ...(corpo && !ehForm ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? (ehForm ? corpo : JSON.stringify(corpo)) : undefined,
      signal: controle.signal,
    });
    dados = await r.json().catch(() => ({}));
  } catch (e) {
    if (e.name === 'AbortError') throw new ErroGemini('O Groq demorou demais para responder.', 'ocupado');
    throw new ErroGemini('Sem internet agora. A gravação está salva no celular; o app tenta de novo quando a internet voltar.', 'rede');
  } finally {
    clearTimeout(prazo);
  }
  if (r.ok) return dados;
  const msg = dados.error?.message || '';
  if (r.status === 401) throw new ErroGemini('A chave do Groq não foi aceita. Confira em Ajustes.', 'chave');
  if (r.status === 429) throw new ErroGemini('O limite gratuito do Gemini e o da reserva acabaram por agora.', 'limite');
  if (r.status >= 500) throw new ErroGemini('O Groq está sobrecarregado agora.', 'ocupado');
  throw new ErroGemini(`O Groq recusou o pedido (${r.status}). ${msg}`.trim(), 'outro');
}

// Devolve as falas no mesmo formato do Gemini; pessoa 0 = fala sem dono identificado.
async function transcreverGroq(blob, nomeArquivo, anterior) {
  if (blob.size > LIMITE_ARQUIVO_GROQ) throw new ErroGemini('Esta parte do áudio é grande demais para a reserva.', 'outro');
  let ultimo;
  for (const modelo of MODELOS_GROQ_AUDIO) {
    const form = new FormData();
    form.append('file', blob, nomeArquivo);
    form.append('model', modelo);
    form.append('language', 'pt');
    form.append('response_format', 'json');
    if (anterior) form.append('prompt', anterior.slice(-200)); // ajuda a manter nomes e o fio da conversa
    try {
      const { text } = await chamarGroq('audio/transcriptions', form);
      registrar(`transcricao respondida pela reserva ${modelo}`);
      const texto = String(text || '').trim();
      return texto ? [{ pessoa: 0, texto }] : [];
    } catch (e) {
      ultimo = e;
      registrar(`reserva ${modelo}: ${e.tipo || 'erro'} ${e.message}`);
      if (!['limite', 'ocupado'].includes(e.tipo)) throw e;
    }
  }
  throw ultimo;
}

async function ataGroq(sistema, usuario, esquema) {
  const dados = await chamarGroq('chat/completions', {
    model: MODELO_GROQ_ATA,
    messages: [{ role: 'system', content: sistema }, { role: 'user', content: usuario }],
    response_format: { type: 'json_schema', json_schema: { name: 'ata', strict: false, schema: esquema } },
  });
  const ata = (() => { try { return JSON.parse(dados.choices?.[0]?.message?.content || ''); } catch { return null; } })();
  if (!ata?.titulo) throw new ErroGemini('A reserva não conseguiu escrever a ata.', 'vazia');
  registrar(`ata respondida pela reserva ${MODELO_GROQ_ATA}`);
  return { pessoas: [], topicos: [], decisoes: [], tarefas: [], proximos_passos: [], ...ata };
}
