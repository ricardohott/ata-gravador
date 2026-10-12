# ATA Elevatis — gravador de reuniões

App de celular (PWA) que grava reuniões presenciais, transcreve e escreve a ata com o Gemini (plano gratuito).

- Site estático: tudo que vai ao ar está em `public/`. Não há servidor.
- A chave do Gemini é colada no próprio app e fica só no celular (localStorage).
- Gravações ficam no IndexedDB do celular: partes de 15 min, cada bloco de 10 s salvo como registro próprio (chave `id:parte:bloco`).
- Nenhuma espera é sem fim (`comPrazo`): parar o gravador, salvar e chamar o Gemini têm prazo; Encerrar sempre termina.
- Microfone tomado (ligação) é detectado e retomado sozinho. Ajustes → "Copiar relatório de problemas" traz o diagnóstico.
- A transcrição separa quem fala ("Pessoa 1, 2..."); a ata tenta descobrir os nomes, e dá para renomear na tela da reunião.

Testar no computador: `npm install`, `npm start` → http://localhost:4180. Conferir: `npm test`.

Publicação: GitHub Pages (https://ricardohott.github.io/ata-gravador/), pelo workflow `.github/workflows/pages.yml`.
Cada push na `main` publica sozinho em 1-2 min. Os caminhos do app são relativos porque o site vive numa subpasta.
Ao mudar arquivos do app, suba a versão do cache em `public/sw.js` (`ata-vN`).
