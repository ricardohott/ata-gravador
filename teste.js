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
vm.runInNewContext(fs.readFileSync('public/gemini.js', 'utf8') + ';this.ESQUEMA_ATA = ESQUEMA_ATA; this.ESQUEMA_FALAS = ESQUEMA_FALAS;', ctx);

const servidor = app.listen(0, async () => {
  const base = `http://localhost:${servidor.address().port}`;
  try {
    const html = await (await fetch(base + '/')).text();
    confere('página inicial abre', html.includes('btn-gravar'));
    confere('gemini.js carrega antes do app.js', html.indexOf('gemini.js') < html.indexOf('app.js'));
    for (const f of ['/app.js', '/gemini.js', '/style.css', '/manifest.json', '/sw.js', '/icon-192.png', '/icon-512.png']) {
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
  } catch (e) {
    falhas++; console.error(e);
  }
  servidor.close();
  console.log(falhas ? `\n${falhas} FALHA(S), ${ok} ok` : `\nTudo certo: ${ok} de ${ok}`);
  process.exit(falhas ? 1 : 0);
});
