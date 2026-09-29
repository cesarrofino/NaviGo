/*
 * NaviGo - Service Worker
 * IMPORTANTE: este service worker armazena os ficheiros estáticos do próprio
 * aplicativo (o "app shell"). Ele NUNCA guarda por conta própria tiles de mapas,
 * respostas do Nominatim, do OSRM ou do Overpass API, porque esses dados pertencem
 * a serviços de terceiros com políticas de uso próprias.
 * Única exceção: mosaicos que o utilizador pediu para guardar offline (Premium) a
 * partir de uma fonte configurada em CONFIG.OFFLINE_TILE_URL que permita isso.
 * Esses ficam na cache OFFLINE_CACHE, escrita pela página, e aqui só são lidos.
 */

const CACHE_NAME = "navigo-shell-v13";
const OFFLINE_CACHE = "navigo-offline-tiles-v1";

const APP_SHELL = [
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== CACHE_NAME && name !== OFFLINE_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Imagens de outros domínios (mosaicos): usa primeiro os que o utilizador guardou offline.
  if (event.request.method === "GET" && event.request.destination === "image" && url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(OFFLINE_CACHE)
        .then((c) => c.match(event.request))
        .then((hit) => hit || fetch(event.request))
        .catch(() => fetch(event.request))
    );
    return;
  }

  // Nunca intercetar chamadas a APIs externas (mapas, pesquisa, rotas, POIs).
  const isExternalApi =
    url.origin !== self.location.origin ||
    url.pathname.includes("tile") ||
    url.hostname.includes("openstreetmap") ||
    url.hostname.includes("nominatim") ||
    url.hostname.includes("osrm") ||
    url.hostname.includes("overpass") ||
    url.hostname.includes("arcgisonline");

  if (isExternalApi) {
    return; // deixa o pedido seguir normalmente para a rede
  }

  // Rede primeiro (para receber atualizações), cache como reserva offline
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );

});
