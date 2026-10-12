# Ata — gravador de reuniões

App de celular (PWA) que grava reuniões presenciais, transcreve e escreve a ata com o Gemini (plano gratuito).

- Site estático: tudo que vai ao ar está em `public/`. Não há servidor.
- A chave do Gemini é colada no próprio app e fica só no celular (localStorage).
- Gravações ficam no IndexedDB do celular, em pedaços de 5 min, salvos a cada 10 s.

Testar no computador: `npm install`, `npm start` → http://localhost:4180. Conferir: `npm test`.

Publicação: Render, tipo *Static Site*, pasta `public`, sem comando de build. Cada push na `main` publica sozinho.
Ao mudar arquivos do app, suba a versão do cache em `public/sw.js` (`ata-vN`).
