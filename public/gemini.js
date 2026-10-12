// Conversa com o Gemini direto do celular, com a chave gratuita do próprio dono.
// A chave fica só neste aparelho (localStorage) e só vai para o Google.

'use strict';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const ESQUEMA_ATA = {
  type: 'object',
  properties: {
    titulo: { type: 'string', description: 'Título curto da reunião, até 8 palavras' },
    resumo: { type: 'string', description: 'Resumo em 3 a 6 frases' },
    pessoas: {
      type: 'array',
      description: 'Uma entrada para cada "Pessoa N" da transcrição',
      items: {
        type: 'object',
        properties: {
          numero: { type: 'integer', description: 'O N de "Pessoa N"' },
          nome: { type: 'string', description: 'Nome real, só se deu para deduzir com segurança pela conversa; senão ""' },
          papel: { type: 'string', description: 'Papel na reunião em poucas palavras (ex.: fornecedor, cliente); "" se não ficou claro' },
        },
        required: ['numero', 'nome', 'papel'],
      },
    },
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
  required: ['titulo', 'resumo', 'pessoas', 'topicos', 'decisoes', 'tarefas', 'proximos_passos'],
};

const ESQUEMA_FALAS = {
  type: 'object',
  properties: {
    falas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pessoa: { type: 'integer', description: 'Número de quem fala: 1, 2, 3...' },
          texto: { type: 'string' },
        },
        required: ['pessoa', 'texto'],
      },
    },
  },
  required: ['falas'],
};

const PEDIDO_TRANSCRICAO = `Transcreva este áudio, em português do Brasil, exatamente como foi falado.
É um trecho de uma reunião presencial gravada por um celular sobre a mesa; podem falar de 1 a 8 pessoas.

Separe por quem fala, prestando atenção na voz (timbre, altura, jeito de falar):
- Cada voz diferente recebe um número: 1, 2, 3... Uma nova fala começa sempre que a voz muda.
- A mesma voz mantém o mesmo número do começo ao fim do trecho.
- Se duas pessoas falam ao mesmo tempo, transcreva o que der, cada uma com o seu número.
- Na dúvida entre duas vozes parecidas, prefira manter o número de quem vinha falando.

Não resuma, não comente, não traduza. Se não houver fala, devolva a lista vazia.`;

const PEDIDO_ATA = `Você recebe a transcrição automática de uma reunião presencial, em português do Brasil,
separada por quem fala ("Pessoa 1", "Pessoa 2"... ou o nome, quando já se sabe).
Escreva a ata em português do Brasil, objetiva, para quem esteve lá relembrar e agir.
- A transcrição pode ter palavras erradas e trocas de quem fala; deduza pelo contexto, sem inventar fatos.
- Descubra quem é cada pessoa pelo que se diz ("Carlos, você manda?" seguido da resposta de alguém indica que esse alguém é o Carlos; "eu sou a Ana, da compras"). Só dê nome com segurança razoável.
- Na ata, chame cada pessoa pelo nome quando souber; senão, por "Pessoa N".
- Decisões são só o que foi de fato combinado; quando der para saber, diga quem propôs ou aceitou.
- Tarefas têm um verbo de ação; responsável e prazo apenas se foram ditos.
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

// Devolve [{ pessoa, texto }]. `anterior` é o fim do trecho anterior já separado por pessoa:
// o Gemini não ouve o áudio anterior, então é pelo assunto e pela ordem das falas
// que ele tenta manter a mesma numeração entre os trechos.
async function transcreverAudio(blob, mime, anterior, maiorNumero) {
  let pedido = PEDIDO_TRANSCRICAO;
  if (anterior) {
    pedido += `\n\nEste trecho continua uma gravação. Fim do trecho anterior (não repita):\n"""\n${anterior}\n"""
Mantenha a numeração: quem continua o assunto acima provavelmente é a mesma pessoa.
Uma voz que ainda não apareceu recebe o próximo número livre (a partir de ${maiorNumero + 1}).`;
  }
  const dados = await chamarGemini(`models/${modeloGemini()}:generateContent`, {
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType: (mime || 'audio/webm').split(';')[0], data: await blobParaBase64(blob) } }, { text: pedido }],
    }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: ESQUEMA_FALAS },
  });
  let falas;
  try {
    falas = JSON.parse(textoDaResposta(dados)).falas;
  } catch (e) {
    if (e instanceof ErroGemini) throw e;
    throw new ErroGemini('A transcrição veio cortada. Toque em "Tentar de novo".', 'outro');
  }
  // Junta falas seguidas da mesma pessoa e descarta as vazias.
  const juntas = [];
  for (const f of falas || []) {
    const texto = String(f.texto || '').trim();
    const pessoa = Math.max(1, Math.round(Number(f.pessoa) || 1));
    if (!texto) continue;
    const ultima = juntas[juntas.length - 1];
    if (ultima && ultima.pessoa === pessoa) ultima.texto += ' ' + texto;
    else juntas.push({ pessoa, texto });
  }
  return juntas;
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
