// Conversa com o Gemini direto do celular, com a chave gratuita do próprio dono.
// A chave fica só neste aparelho (localStorage) e só vai para o Google.

'use strict';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const ESQUEMA_ATA = {
  type: 'object',
  properties: {
    titulo: { type: 'string', description: 'Título curto da reunião, até 8 palavras' },
    resumo: { type: 'string', description: 'Resumo em 3 a 6 frases' },
    participantes: { type: 'array', items: { type: 'string' }, description: 'Nomes citados; vazio se não houver' },
    topicos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { titulo: { type: 'string' }, pontos: { type: 'array', items: { type: 'string' } } },
        required: ['titulo', 'pontos'],
      },
    },
    decisoes: { type: 'array', items: { type: 'string' } },
    tarefas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          descricao: { type: 'string' },
          responsavel: { type: 'string', description: '"" se não ficou claro' },
          prazo: { type: 'string', description: 'Como foi dito; "" se não houve' },
        },
        required: ['descricao', 'responsavel', 'prazo'],
      },
    },
    proximos_passos: { type: 'array', items: { type: 'string' } },
  },
  required: ['titulo', 'resumo', 'participantes', 'topicos', 'decisoes', 'tarefas', 'proximos_passos'],
};

const PEDIDO_TRANSCRICAO = `Transcreva este áudio, em português do Brasil, exatamente como foi falado.
É um trecho de uma reunião presencial gravada pelo celular.
Quando der para perceber que outra pessoa começou a falar, comece um novo parágrafo.
Não resuma, não comente, não traduza. Devolva só o texto falado.
Se não houver fala, devolva vazio.`;

const PEDIDO_ATA = `Você recebe a transcrição automática de uma reunião presencial, em português do Brasil.
Escreva a ata em português do Brasil, objetiva, para quem esteve lá relembrar e agir.
- A transcrição pode ter palavras erradas; deduza pelo contexto, sem inventar fatos.
- Decisões são só o que foi de fato combinado. Tarefas têm um verbo de ação; responsável e prazo apenas se foram ditos.
- Se a gravação for curta ou sem conteúdo de reunião, diga isso no resumo e deixe as listas vazias.`;

const chaveGemini = () => localStorage.getItem('ata-chave') || '';
// Os nomes dos modelos do Google mudam com frequência: o app descobre qual usar
// com a própria chave (ver escolherModelo) e guarda a escolha.
const modeloGemini = () => localStorage.getItem('ata-modelo') || 'gemini-flash-latest';

class ErroGemini extends Error {
  constructor(msg, tipo) { super(msg); this.tipo = tipo; }
}

async function chamarGemini(caminho, corpo, chave = chaveGemini()) {
  let r;
  try {
    r = await fetch(`${GEMINI}/${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: { 'x-goog-api-key': chave, ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    throw new ErroGemini('Sem internet agora. A gravação está salva no celular; tente de novo depois.', 'rede');
  }
  const dados = await r.json().catch(() => ({}));
  if (r.ok) return dados;
  const msg = dados.error?.message || '';
  if (r.status === 429) {
    throw new ErroGemini('O limite gratuito do Gemini foi atingido por agora. A gravação está salva; tente de novo mais tarde (o limite diário renova todo dia).', 'limite');
  }
  if ((r.status === 400 && /API key|API_KEY/i.test(msg)) || r.status === 401 || r.status === 403) {
    throw new ErroGemini('A chave do Gemini não foi aceita. Confira a chave em Ajustes.', 'chave');
  }
  if (r.status === 404) {
    localStorage.removeItem('ata-modelo'); // o modelo saiu do ar: a próxima tentativa escolhe outro
    throw new ErroGemini('O modelo do Gemini mudou de nome. Toque em "Tentar de novo".', 'modelo');
  }
  throw new ErroGemini(`O Gemini recusou o pedido (${r.status}). ${msg}`.trim(), 'outro');
}

// Prefere o apelido "flash-latest" (sempre o Flash atual); senão, o Flash mais novo da lista.
async function escolherModelo(chave) {
  const { models = [] } = await chamarGemini('models?pageSize=200', null, chave);
  const nomes = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''));
  if (nomes.includes('gemini-flash-latest')) return 'gemini-flash-latest';
  const flash = nomes
    .filter((n) => /^gemini-[\d.]+-flash$/.test(n))
    .sort((a, b) => parseFloat(b.slice(7)) - parseFloat(a.slice(7)));
  return flash[0] || nomes.find((n) => /flash/.test(n) && !/lite|image|tts|live|audio/.test(n)) || 'gemini-flash-latest';
}

function textoDaResposta(dados) {
  const c = dados.candidates?.[0];
  if (!c) throw new ErroGemini('O Gemini não devolveu resposta para este trecho.', 'outro');
  return (c.content?.parts || []).map((p) => p.text || '').join('').trim();
}

function blobParaBase64(blob) {
  return new Promise((ok, falha) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => falha(r.error);
    r.readAsDataURL(blob);
  });
}

async function transcreverAudio(blob, mime, anterior) {
  const pedido = anterior
    ? `${PEDIDO_TRANSCRICAO}\n\nPara manter nomes e o fio da conversa, este é o fim do trecho anterior (não repita):\n"""${anterior}"""`
    : PEDIDO_TRANSCRICAO;
  const dados = await chamarGemini(`models/${modeloGemini()}:generateContent`, {
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType: (mime || 'audio/webm').split(';')[0], data: await blobParaBase64(blob) } }, { text: pedido }],
    }],
    generationConfig: { temperature: 0 },
  });
  return textoDaResposta(dados);
}

async function escreverAta({ transcricao, inicio, duracaoSeg, contexto }) {
  const cabecalho = [
    inicio && `Início: ${new Date(inicio).toLocaleString('pt-BR')}`,
    duracaoSeg && `Duração: ${Math.max(1, Math.round(duracaoSeg / 60))} min`,
    contexto && `Anotação de quem gravou: ${contexto}`,
  ].filter(Boolean).join('\n');
  const dados = await chamarGemini(`models/${modeloGemini()}:generateContent`, {
    systemInstruction: { parts: [{ text: PEDIDO_ATA }] },
    contents: [{ role: 'user', parts: [{ text: `${cabecalho}\n\n<transcricao>\n${transcricao}\n</transcricao>` }] }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: ESQUEMA_ATA },
  });
  try {
    return JSON.parse(textoDaResposta(dados));
  } catch (e) {
    if (e instanceof ErroGemini) throw e;
    throw new ErroGemini('A ata veio incompleta. Toque em "Tentar de novo".', 'outro');
  }
}
