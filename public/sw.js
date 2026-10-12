// Abre o app mesmo sem internet (a gravação não depende de rede).
// Rede primeiro, cache como reserva: atualização publicada chega sem precisar limpar nada.
const CACHE = 'ata-v3';
const ARQUIVOS = ['./', 'index.html', 'style.css', 'gemini.js', 'app.js', 'manifest.json', 'icon.svg', 'icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Só os arquivos do próprio app; chamadas ao Gemini passam direto.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); return r; })
      .catch(() => caches.match(req).then((r) => r || caches.match('index.html'))),
  );
});
