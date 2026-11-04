// Monta o PDF da ata no próprio celular, sem internet (jsPDF, em jspdf.umd.min.js).
// A geração é síncrona de propósito: o menu de compartilhar só abre dentro do próprio toque.

'use strict';

const PDF_AZUL = [15, 111, 229];
const PDF_AZUL_CLARO = [25, 182, 234];
const PDF_NOITE = [14, 21, 34];
const PDF_TEXTO = [33, 41, 54];
const PDF_SUAVE = [107, 114, 128];

// O símbolo é carregado antes: dentro do toque não dá para esperar. Sem ele, o PDF sai sem o desenho.
let logoPdf = null;
async function prepararPdf() {
  try {
    const blob = await (await fetch('icon-192.png')).blob();
    logoPdf = await new Promise((ok, falha) => {
      const leitor = new FileReader();
      leitor.onload = () => ok(leitor.result);
      leitor.onerror = () => falha(leitor.error);
      leitor.readAsDataURL(blob);
    });
  } catch { /* segue sem o símbolo */ }
}

// As fontes embutidas do PDF só têm o alfabeto ocidental: troca o que não existe nelas
// (aspas curvas, emojis) para não sair lixo no meio do texto.
function textoPdf(t) {
  return String(t ?? '')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\n\x20-\x7e\xa0-\xff]/g, '')
    .trim();
}

function nomeArquivoPdf(r) {
  const titulo = String(r.resumo?.titulo || 'reuniao').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50);
  return `ata-${titulo}-${new Date(r.inicio).toISOString().slice(0, 10)}.pdf`;
}

function gerarPdfAta(r) {
  const s = r.resumo;
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const LARG = doc.internal.pageSize.getWidth();
  const ALT = doc.internal.pageSize.getHeight();
  const MARGEM = 18;
  const UTIL = LARG - MARGEM * 2;
  const RODAPE = ALT - 18;
  let y = 0;

  const linhaH = (tam) => tam * 0.46;
  const novaPagina = () => { doc.addPage(); y = 18; };
  const garantir = (altura) => { if (y + altura > RODAPE) novaPagina(); };

  // Texto corrido que continua na página seguinte, se precisar.
  function escrever(texto, { tam = 10.5, cor = PDF_TEXTO, negrito = false, x = MARGEM, largura = UTIL } = {}) {
    doc.setFont('helvetica', negrito ? 'bold' : 'normal');
    doc.setFontSize(tam);
    doc.setTextColor(...cor);
    for (const linha of doc.splitTextToSize(textoPdf(texto), largura)) {
      garantir(linhaH(tam));
      doc.text(linha, x, y + linhaH(tam) * 0.75);
      y += linhaH(tam);
    }
  }

  function titulo(nome) {
    garantir(16); // título nunca fica sozinho no pé da página
    y += 6;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...PDF_AZUL);
    doc.text(textoPdf(nome).toUpperCase(), MARGEM, y);
    y += 1.8;
    doc.setDrawColor(...PDF_AZUL_CLARO);
    doc.setLineWidth(0.35);
    doc.line(MARGEM, y, MARGEM + UTIL, y);
    y += 3;
  }

  function item(texto, extra) {
    garantir(linhaH(10.5) + 1);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10.5);
    doc.setTextColor(...PDF_AZUL);
    doc.text('•', MARGEM + 1, y + linhaH(10.5) * 0.75);
    escrever(texto, { x: MARGEM + 5, largura: UTIL - 5 });
    if (extra) escrever(extra, { tam: 9, cor: PDF_SUAVE, x: MARGEM + 5, largura: UTIL - 5 });
    y += 1.2;
  }

  const secao = (nome, itens, vazio) => {
    titulo(nome);
    if (itens?.length) itens.forEach((i) => item(i));
    else escrever(vazio, { cor: PDF_SUAVE });
  };

  // Faixa da marca, com o azul-noite da logo
  doc.setFillColor(...PDF_NOITE);
  doc.rect(0, 0, LARG, 24, 'F');
  if (logoPdf) doc.addImage(logoPdf, 'PNG', MARGEM - 3, 3, 18, 18);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  const xNome = MARGEM + (logoPdf ? 16 : 0);
  doc.setTextColor(...PDF_AZUL_CLARO);
  doc.text('ATA', xNome, 14.3);
  doc.setTextColor(255, 255, 255);
  doc.text('ELEVATIS', xNome + doc.getTextWidth('ATA') + 1, 14.3);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(170, 180, 195);
  doc.text('Ata de reunião', LARG - MARGEM, 14.3, { align: 'right' });

  y = 32;
  escrever(s.titulo, { tam: 18, negrito: true, cor: PDF_NOITE });
  y += 1.5;
  escrever(`${fmtData(r.inicio)} · Duração ${fmtDuracao(r.duracaoSeg)}`, { tam: 9.5, cor: PDF_SUAVE });
  if (participantes(r)) { y += 0.5; escrever(`Participantes: ${participantes(r)}`, { tam: 9.5, cor: PDF_SUAVE }); }

  titulo('Resumo');
  escrever(s.resumo);
  secao('Decisões', s.decisoes, 'Nenhuma decisão registrada.');

  titulo('Tarefas');
  if (s.tarefas?.length) {
    for (const t of s.tarefas) {
      const quem = [t.responsavel && `Responsável: ${t.responsavel}`, t.prazo && `Prazo: ${t.prazo}`].filter(Boolean).join(' · ');
      item(t.descricao, quem);
    }
  } else escrever('Nenhuma tarefa registrada.', { cor: PDF_SUAVE });

  secao('Próximos passos', s.proximos_passos, 'Nenhum próximo passo registrado.');
  for (const t of s.topicos || []) if (t.pontos?.length) secao(t.titulo, t.pontos, '');

  // Rodapé em todas as páginas
  const total = doc.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...PDF_SUAVE);
    doc.text('Gerado pelo ATAElevatis', MARGEM, ALT - 9);
    doc.text(`Página ${p} de ${total}`, LARG - MARGEM, ALT - 9, { align: 'right' });
  }
  doc.setProperties({ title: textoPdf(s.titulo), creator: 'ATAElevatis' });

  return new File([doc.output('blob')], nomeArquivoPdf(r), { type: 'application/pdf' });
}

function baixarPdf(arquivo) {
  const url = URL.createObjectURL(arquivo);
  const link = document.createElement('a');
  link.href = url;
  link.download = arquivo.name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Abre o compartilhar do celular com o arquivo (WhatsApp, e-mail, Arquivos...).
// Sem suporte, ou se o compartilhar falhar, baixa o PDF para enviar à mão.
function compartilharPdf(r) {
  if (!r?.resumo) return avisar('A ata ainda não está pronta.');
  let arquivo;
  try {
    arquivo = gerarPdfAta(r);
  } catch (e) {
    registrar(`ERRO ao gerar o PDF: ${e.message}`);
    return avisar('Não consegui gerar o PDF. Use WhatsApp, E-mail ou Copiar.', 6000);
  }
  registrar(`PDF gerado: ${Math.round(arquivo.size / 1024)} KB`);
  if (navigator.canShare?.({ files: [arquivo] })) {
    navigator.share({ files: [arquivo] }).catch((e) => {
      if (e.name === 'AbortError') return; // a pessoa cancelou
      registrar(`compartilhar PDF falhou: ${e.name} ${e.message}`);
      baixarPdf(arquivo);
      avisar('PDF baixado. Envie o arquivo pelo app que preferir.', 6000);
    });
  } else {
    baixarPdf(arquivo);
    avisar('PDF baixado. Envie o arquivo pelo app que preferir.', 6000);
  }
}
