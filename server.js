// Só para testar no computador: serve a pasta public/.
// Em produção o app é um site estático — o celular fala direto com o Gemini.
const path = require('path');
const express = require('express');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

if (require.main === module) {
  const porta = Number(process.env.PORT) || 4180;
  app.listen(porta, () => console.log(`Ata em http://localhost:${porta}`));
}
module.exports = app;
