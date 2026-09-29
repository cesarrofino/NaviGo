/* =========================================================================
   NaviGo — app.js
   Navegador web baseado em OpenStreetMap (Leaflet + Nominatim + OSRM +
   Overpass API). Sem backend. Todas as chamadas são feitas diretamente
   do browser para APIs públicas.
   ========================================================================= */

/* -------------------------------------------------------------------------
   CONFIGURAÇÃO
   -------------------------------------------------------------------------
   Para usar OpenRouteService (ORS) em vez do OSRM público (por exemplo,
   se precisar de mais robustez / limites diferentes), insira a sua chave
   gratuita obtida em https://openrouteservice.org/dev/#/signup abaixo e
   mude ROUTING_PROVIDER para "ors".
   ------------------------------------------------------------------------- */
const CONFIG = {
  ROUTING_PROVIDER: "osrm", // "osrm" (sem chave) ou "ors" (requer chave)
  ORS_API_KEY: "", // <-- insira aqui a sua chave do OpenRouteService, se for usar "ors"
  OSRM_BASE_URL: "https://router.project-osrm.org/route/v1",
  NOMINATIM_BASE_URL: "https://nominatim.openstreetmap.org",
  OVERPASS_URL: "https://overpass-api.de/api/interpreter",
  DEFAULT_CENTER: [-25.9692, 32.5732], // Maputo, Moçambique
  DEFAULT_ZOOM: 13,
  SEARCH_DEBOUNCE_MS: 450,
  OFF_ROUTE_THRESHOLD_M: 45,
  // --- Mapas offline (Premium) ---------------------------------------------
  // O servidor público do OpenStreetMap (tile.openstreetmap.org) PROÍBE descarregar
  // mosaicos para uso offline. Por isso esta função só fica ativa se indicar aqui uma
  // fonte de mosaicos que o permita (servidor próprio, pacote de mosaicos ou um
  // fornecedor cujo plano autorize guardar offline). Requisitos do URL: usar {z}/{x}/{y},
  // NÃO usar {s} (subdomínios) e o servidor deve enviar cabeçalhos CORS.
  // Ex.: "https://tiles.oseusite.com/{z}/{x}/{y}.png"
  OFFLINE_TILE_URL: "",
  OFFLINE_ATTRIBUTION: "",     // texto de atribuição exigido pelo fornecedor
  OFFLINE_MIN_ZOOM: 10,
  OFFLINE_MAX_TILES: 3000,     // limite por área guardada
};

/* -------------------------------------------------------------------------
   ESTADO
   ------------------------------------------------------------------------- */
const state = {
  map: null,
  tileLayers: {},
  currentTileType: "map", // "map" | "satellite"
  userPosition: null, // {lat, lon}
  userMarker: null,
  userAccuracyCircle: null,
  watchId: null,
  navigationWatchId: null,
  isNavigating: false,
  selectedPlace: null, // {name, address, lat, lon}
  routeLayer: null,
  routeCoords: [],
  routeSteps: [],
  routeProfile: "driving",
  routeSummary: null, // {distance, duration}
  categoryMarkers: [],
  searchDebounceTimer: null,
  settings: {
    theme: "light",
    units: "km",
    mapType: "map",
    sound: true,
    voice: true,
    autoTilt: true,
    lang: "pt",
    fuelPrice: 90,      // MT por litro (editável nas Definições)
    consCar: 9,         // L/100 km
    consMoto: 3,        // L/100 km
    speedAlert: false,
    speedLimit: 80,     // km/h
    dataSaver: false,
  },
  favorites: [],
  history: [],
  heading: 0,
  hasHeading: false,
  gpsHeadingAt: 0,
  tiltOn: false,
  headingUp: true,
  follow: true,
  routeOptions: [],
  routeIdx: 0,
  altLayers: [],
  spoken: {},
  speed: null,
  lastFix: null,
  trips: [],
  activeTrip: null,
  listening: false,
  premium: null, // { unlockedUntil, plan, code } | null
  avoid: new Set(),
  stops: [],            // paragens intermédias [{name,address,lat,lon}]
  stopMarkers: [],
  addingStop: false,
  stopCandidate: null,
  stopCandidateMarker: null,
  speedOver: false,
  lastSpeedAlertAt: 0,
  notes: {},            // notas por local: { "lat,lon": {text,name,at} }
  monthly: {},          // resumo mensal: { "YYYY-MM": {trips,completed,km,sec,liters,cost} }
  statsMonth: null,
  saverApplied: false,
  offline: { areas: [], downloading: false, cancel: false, aborted: false, zmax: 16 },
};

const PROFILE_TO_OSRM = { driving: "driving", motorcycle: "driving", walking: "foot", cycling: "bike" };
const PROFILE_TO_ORS = { driving: "driving-car", motorcycle: "driving-car", walking: "foot-walking", cycling: "cycling-regular" };

const CATEGORY_TAGS = {
  restaurantes: { tag: "amenity=restaurant", icon: "bi-cup-hot-fill", label: "Restaurante" },
  hospitais: { tag: "amenity=hospital", icon: "bi-hospital-fill", label: "Hospital" },
  farmacias: { tag: "amenity=pharmacy", icon: "bi-capsule", label: "Farmácia" },
  combustivel: { tag: "amenity=fuel", icon: "bi-fuel-pump-fill", label: "Posto de combustível" },
  supermercados: { tag: "shop=supermarket", icon: "bi-basket3-fill", label: "Supermercado" },
  hoteis: { tag: "tourism=hotel", icon: "bi-building", label: "Hotel" },
  escolas: { tag: "amenity=school", icon: "bi-mortarboard-fill", label: "Escola" },
  bancos: { tag: "amenity=bank", icon: "bi-bank", label: "Banco" },
  atms: { tag: "amenity=atm", icon: "bi-credit-card-fill", label: "ATM" },
  policia: { tag: "amenity=police", icon: "bi-shield-fill", label: "Polícia" },
  universidades: { tag: "amenity=university", icon: "bi-mortarboard-fill", label: "Universidade" },
};

/* -------------------------------------------------------------------------
   UTILITÁRIOS
   ------------------------------------------------------------------------- */
// devolve um elemento "vazio" se não existir, para um erro isolado não parar o resto do app
function $(sel) { return document.querySelector(sel) || document.createElement("div"); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDistance(meters) {
  if (state.settings.units === "mi") {
    const miles = meters / 1609.344;
    return miles < 0.1 ? `${Math.round(meters / 1609.344 * 5280)} pés` : `${miles.toFixed(1)} mi`;
  }
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds) {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}h ${m}min`;
}

function formatEta(seconds) {
  const eta = new Date(Date.now() + seconds * 1000);
  return eta.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

function showToast(message, kind = "info") {
  const container = $("#toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  const icon = kind === "error" ? "bi-exclamation-triangle-fill" : kind === "success" ? "bi-check-circle-fill" : "bi-info-circle-fill";
  toast.innerHTML = `<i class="bi ${icon}"></i><span>${message}</span>`;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 4200);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* -------------------------------------------------------------------------
   PERSISTÊNCIA (localStorage)
   ------------------------------------------------------------------------- */
const STORAGE_KEYS = {
  settings: "navigo:settings",
  favorites: "navigo:favorites",
  history: "navigo:history",
  lastPosition: "navigo:lastPosition",
  profile: "navigo:profile",
  trips: "navigo:trips",
  premium: "navigo:premium",
  notes: "navigo:notes",
  monthly: "navigo:monthly",
  offlineAreas: "navigo:offlineAreas",
};

const PREMIUM_CODES = { "D1/2107": { days: 1, plan: "day" }, "S1/2107": { days: 7, plan: "week" }, "M1/2107": { days: 30, plan: "month" } };
const TRIAL_DAYS = 30;
const FREE_FAVORITES_MAX = 5;
const MAX_STOPS = 5;

function loadStorage() {
  try {
    const tr = localStorage.getItem(STORAGE_KEYS.trips);
    if (tr) state.trips = JSON.parse(tr);
  } catch (e) { state.trips = []; }
  try {
    const s = localStorage.getItem(STORAGE_KEYS.settings);
    if (s) state.settings = { ...state.settings, ...JSON.parse(s) };
  } catch (e) { /* ignore corrupted data */ }
  try {
    const f = localStorage.getItem(STORAGE_KEYS.favorites);
    if (f) state.favorites = JSON.parse(f);
  } catch (e) { state.favorites = []; }
  try {
    const h = localStorage.getItem(STORAGE_KEYS.history);
    if (h) state.history = JSON.parse(h);
  } catch (e) { state.history = []; }
  state.premium = loadPremium();
  try { state.notes = JSON.parse(localStorage.getItem(STORAGE_KEYS.notes)) || {}; } catch (e) { state.notes = {}; }
  try { state.offline.areas = JSON.parse(localStorage.getItem(STORAGE_KEYS.offlineAreas)) || []; } catch (e) { state.offline.areas = []; }
  try {
    const rawM = localStorage.getItem(STORAGE_KEYS.monthly);
    if (rawM) state.monthly = JSON.parse(rawM) || {};
    else seedMonthlyFromTrips();   // 1.ª vez: aproveita as viagens já guardadas
  } catch (e) { state.monthly = {}; }
}

function saveSettings() { localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings)); }
function saveFavorites() { localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify(state.favorites)); }
function saveHistory() { localStorage.setItem(STORAGE_KEYS.history, JSON.stringify(state.history)); }
function saveLastPosition(pos) {
  const now = Date.now();
  if (now - (state.lastSaveAt || 0) < 10000) return; // evita escrever no armazenamento a cada fix de GPS
  state.lastSaveAt = now;
  localStorage.setItem(STORAGE_KEYS.lastPosition, JSON.stringify(pos));
}
function loadLastPosition() {
  try {
    const p = localStorage.getItem(STORAGE_KEYS.lastPosition);
    return p ? JSON.parse(p) : null;
  } catch (e) { return null; }
}

function loadUserProfile() {
  try {
    const p = localStorage.getItem(STORAGE_KEYS.profile);
    return p ? JSON.parse(p) : null;
  } catch (e) { return null; }
}
function saveUserProfile(profile) { localStorage.setItem(STORAGE_KEYS.profile, JSON.stringify(profile)); }

/* -------------------------------------------------------------------------
   MAPA
   ------------------------------------------------------------------------- */
function initMap() {
  const savedProfile = loadUserProfile();
  const cityGeo = savedProfile && savedProfile.cityGeo;
  const start = cityGeo
    ? { lat: cityGeo.lat, lon: cityGeo.lon }
    : loadLastPosition() || { lat: CONFIG.DEFAULT_CENTER[0], lon: CONFIG.DEFAULT_CENTER[1] };

  state.map = L.map("map", { zoomControl: false, attributionControl: true, preferCanvas: true }).setView(
    [start.lat, start.lon],
    CONFIG.DEFAULT_ZOOM
  );

  state.tileLayers.map = offlineConfigured()
    ? L.tileLayer(CONFIG.OFFLINE_TILE_URL, {
        maxZoom: 19,
        maxNativeZoom: 17,   // além do zoom 17 amplia os mosaicos guardados
        keepBuffer: 1,
        attribution: CONFIG.OFFLINE_ATTRIBUTION || "&copy; colaboradores do OpenStreetMap",
      })
    : L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        keepBuffer: 1,
        attribution: "&copy; colaboradores do OpenStreetMap",
      });

  // mapa escuro nativo (muito mais leve do que aplicar filtros CSS nos tiles)
  state.tileLayers.dark = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    keepBuffer: 1,
    attribution: "&copy; colaboradores do OpenStreetMap &copy; CARTO",
  });

  // temas Premium (CartoDB, gratuitos e sem chave)
  state.tileLayers.voyager = L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, keepBuffer: 1, attribution: "&copy; colaboradores do OpenStreetMap &copy; CARTO",
  });
  state.tileLayers.positron = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, keepBuffer: 1, attribution: "&copy; colaboradores do OpenStreetMap &copy; CARTO",
  });

  // maxNativeZoom evita pedir zooms sem cobertura em Moçambique (que voltam como
  // um tile cinzento com o texto "Map data not yet available"); em vez disso o
  // Leaflet amplia o último nível disponível, o que fica bem melhor.
  state.tileLayers.satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, maxNativeZoom: 17, keepBuffer: 1, attribution: "Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics" }
  );

  state.currentTileType = desiredBase();
  state.tileLayers[state.currentTileType].addTo(state.map);

  // camada própria para as etiquetas de bairros/avenidas (não interfere com toques)
  state.labelPane = state.map.createPane("labels");
  state.labelPane.style.zIndex = 450;
  state.labelPane.style.pointerEvents = "none";

  state.map.on("zoomend moveend", debounce(() => renderCityLabels(), 250));
}

function setUserMarker(lat, lon, accuracy) {
  const icon = L.divIcon({
    className: "user-location-icon",
    html: `<div class="user-dot"><div class="user-cone"></div><div class="user-dot-pulse"></div></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  if (!state.userMarker) {
    state.userMarker = L.marker([lat, lon], { icon, zIndexOffset: 1000 }).addTo(state.map);
    setTimeout(() => applyMapView(true), 0);
  } else {
    state.userMarker.setLatLng([lat, lon]);
  }

  if (accuracy) {
    if (!state.userAccuracyCircle) {
      state.userAccuracyCircle = L.circle([lat, lon], {
        radius: accuracy,
        className: "accuracy-circle",
        stroke: false,
      }).addTo(state.map);
    } else {
      state.userAccuracyCircle.setLatLng([lat, lon]);
      state.userAccuracyCircle.setRadius(accuracy);
    }
  }
}

function categoryDivIcon(iconClass) {
  return L.divIcon({
    className: "category-marker",
    html: `<div class="cat-pin"><i class="bi ${iconClass}"></i></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 34],
    popupAnchor: [0, -30],
  });
}

function destinationDivIcon() {
  return L.divIcon({
    className: "dest-marker",
    html: `<div class="dest-pin"><i class="bi bi-geo-alt-fill"></i></div>`,
    iconSize: [38, 38],
    iconAnchor: [19, 38],
  });
}

/* -------------------------------------------------------------------------
   GEOLOCALIZAÇÃO
   ------------------------------------------------------------------------- */
function requestLocation(force) {
  if (!("geolocation" in navigator)) {
    showToast("O seu navegador não suporta geolocalização.", "error");
    return;
  }
  if (!window.isSecureContext) {
    // a Geolocation API só funciona em HTTPS ou localhost; abrir o index.html
    // diretamente como ficheiro (file://) bloqueia-a silenciosamente
    showToast("A localização só funciona quando o NaviGo é aberto por HTTPS (ex.: GitHub Pages) ou em localhost — não ao abrir o ficheiro diretamente.", "error");
    return;
  }
  const locateIcon = $("#locate-btn");
  locateIcon.classList.add("locating");

  const onOk = (pos) => {
    locateIcon.classList.remove("locating");
    const { latitude, longitude, accuracy } = pos.coords;
    state.userPosition = { lat: latitude, lon: longitude };
    state.hasFirstFix = true;
    saveLastPosition(state.userPosition);
    setUserMarker(latitude, longitude, accuracy);
    if (force) state.follow = true;
    if (force || !isFarFromCity(state.userPosition)) {
      state.map.setView([latitude, longitude], 15, { animate: true });
      showToast("Localização atual encontrada.", "success");
    } else {
      showToast(`Você parece estar longe de ${state.userProfile ? state.userProfile.city : "sua cidade"}. O mapa fica na cidade; toque em localizar para ir à sua posição.`, "info");
    }
    startWatchingPosition();
  };

  const onFail = (err) => {
    // 1ª tentativa falhou com alta precisão: tenta de novo com GPS "aproximado",
    // que costuma responder melhor em interiores ou em dispositivos mais lentos
    if (!state.hasFirstFix && err.code !== 1) {
      navigator.geolocation.getCurrentPosition(onOk, (err2) => {
        locateIcon.classList.remove("locating");
        handleGeoError(err2);
      }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
      return;
    }
    locateIcon.classList.remove("locating");
    handleGeoError(err);
  };

  navigator.geolocation.getCurrentPosition(onOk, onFail, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

// Segue o utilizador sem sobrecarregar o mapa: ignora microdeslocamentos do GPS e
// limita a frequência (cada panTo dispara carregamento de mosaicos e redesenho de etiquetas).
function followUser(lat, lon) {
  const now = performance.now();
  const last = state.lastFollow;
  if (last) {
    if (now - last.at < 700) return;
    if (haversineMeters(last.lat, last.lon, lat, lon) < (state.tiltOn ? 4 : 2)) return;
  }
  state.lastFollow = { lat, lon, at: now };
  state.map.panTo([lat, lon], { animate: true, duration: 0.6, easeLinearity: 1, noMoveStart: true });
}

function onWatchFix(pos) {
  const { latitude, longitude, accuracy, heading, speed } = pos.coords;
  const prev = state.lastFix;
  state.userPosition = { lat: latitude, lon: longitude };
  state.speed = typeof speed === "number" && !Number.isNaN(speed) ? speed : null;
  // direção: GPS (quando em movimento) ou cálculo entre dois pontos
  if (typeof heading === "number" && !Number.isNaN(heading) && (speed || 0) > 1.2) {
    state.hasHeading = true;
    setHeading(heading, "gps");
  } else if (prev && haversineMeters(prev.lat, prev.lon, latitude, longitude) > 8) {
    state.hasHeading = true;
    setHeading(bearingBetween(prev.lat, prev.lon, latitude, longitude), "gps");
  }
  if (!prev || haversineMeters(prev.lat, prev.lon, latitude, longitude) > 8) state.lastFix = { lat: latitude, lon: longitude };
  state.watchErrorCount = 0;
  saveLastPosition(state.userPosition);
  setUserMarker(latitude, longitude, accuracy);
  if (state.tiltOn && state.follow && !state.isNavigating) followUser(latitude, longitude);
  if (state.isNavigating) updateNavigationProgress(latitude, longitude);
}

function startWatchingPosition() {
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);
  state.watchErrorCount = 0;
  state.watchId = navigator.geolocation.watchPosition(
    onWatchFix,
    (err) => {
      state.watchErrorCount = (state.watchErrorCount || 0) + 1;
      if (state.isNavigating) handleGeoError(err);
      // depois de falhas seguidas, troca para uma leitura menos exigente em vez de parar de atualizar
      if (state.watchErrorCount === 3 && navigator.geolocation) {
        navigator.geolocation.clearWatch(state.watchId);
        state.watchId = navigator.geolocation.watchPosition(onWatchFix, () => {}, { enableHighAccuracy: false, maximumAge: 15000, timeout: 20000 });
      }
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function handleGeoError(err) {
  const messages = {
    1: "Permissão de localização foi recusada. Ative-a nas definições do navegador para uma melhor experiência.",
    2: "Não foi possível obter o GPS neste momento. Verifique a sua ligação ou tente ao ar livre.",
    3: "A localização demorou demasiado tempo a responder. Tente novamente.",
  };
  showToast(messages[err.code] || "Erro desconhecido ao obter a localização.", "error");
}

/* -------------------------------------------------------------------------
   PESQUISA (Nominatim)
   ------------------------------------------------------------------------- */
const debouncedSearch = debounce((query) => runSearch(query), CONFIG.SEARCH_DEBOUNCE_MS);

function onSearchInput(e) {
  const query = e.target.value.trim();
  $("#search-clear").classList.toggle("hidden", query.length === 0);
  if (query.length < 2) {
    renderSearchPanel(null);
    return;
  }
  debouncedSearch(query);
}

async function runSearch(query) {
  renderSearchPanel("loading");
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      q: query,
      addressdetails: "1",
      limit: isDataSaver() ? "5" : "8",
    });
    const biasCenter = searchBiasCenter();
    if (biasCenter) {
      // favorece resultados perto da cidade/posição do utilizador sem restringir a área
      params.set("viewbox", boundsAround(biasCenter, 0.25));
      params.set("bounded", "0");
    }
    const res = await fetch(`${CONFIG.NOMINATIM_BASE_URL}/search?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("network");
    const data = await res.json();
    renderSearchPanel("results", data);
  } catch (err) {
    renderSearchPanel("error");
    showToast("Não foi possível pesquisar agora. Verifique a sua ligação à internet.", "error");
  }
}

function boundsAround(center, deg) {
  const { lat, lon } = center;
  return `${lon - deg},${lat + deg},${lon + deg},${lat - deg}`;
}

function isFarFromCity(pos) {
  if (!pos || !state.cityCenter) return false;
  return haversineMeters(pos.lat, pos.lon, state.cityCenter.lat, state.cityCenter.lon) > 50000;
}

function searchBiasCenter() {
  if (state.userPosition && !isFarFromCity(state.userPosition)) return state.userPosition;
  return state.cityCenter || state.userPosition || null;
}

function closeSearchPanel() {
  const panel = $("#search-panel");
  if (!panel.classList.contains("hidden")) renderSearchPanel(null);
  const input = $("#search-input");
  if (document.activeElement === input) input.blur();
}

function renderSearchPanel(mode, results) {
  const panel = $("#search-panel");
  if (!mode) { panel.classList.add("hidden"); panel.innerHTML = ""; return; }
  panel.classList.remove("hidden");

  if (mode === "loading") {
    panel.innerHTML = `<div class="search-status"><span class="spinner"></span> A pesquisar...</div>`;
    return;
  }
  if (mode === "error") {
    panel.innerHTML = `<div class="search-status error"><i class="bi bi-wifi-off"></i> Erro de ligação. Tente novamente.</div>`;
    return;
  }
  if (mode === "results") {
    if (!results || results.length === 0) {
      panel.innerHTML = `<div class="search-status"><i class="bi bi-search"></i> Não conseguimos encontrar esse local. Tente pesquisar por outro nome ou endereço.</div>`;
      return;
    }
    panel.innerHTML = `<ul class="result-list">${results.map((r, i) => resultRowHtml(r, i)).join("")}</ul>`;
    panel.dataset.results = JSON.stringify(
      results.map((r) => ({
        name: primaryName(r),
        address: r.display_name,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
        category: r.type || r.class || "local",
      }))
    );
    return;
  }
  if (mode === "recents") {
    panel.innerHTML = recentsHtml();
  }
}

function recentsHtml() {
  if (!state.history.length) {
    return `<div class="search-status"><i class="bi bi-search"></i> Pesquise um lugar, rua ou bairro.</div>`;
  }
  return `<div class="panel-title-row"><i class="bi bi-clock-history"></i> Pesquisas recentes</div><ul class="result-list">${state.history
    .slice(0, 6)
    .map(
      (h, i) => `
    <li class="result-row" onclick="onRecentClick(${i})">
      <span class="result-icon"><i class="bi bi-clock-history"></i></span>
      <span class="result-text"><span class="result-name">${escapeHtml(h.name)}</span><span class="result-address">${escapeHtml(h.address || "")}</span></span>
    </li>`
    )
    .join("")}</ul>`;
}

function onRecentClick(i) {
  const place = state.history[i];
  if (place) selectPlace(place);
}

function primaryName(r) {
  return (r.name && r.name.length) ? r.name : r.display_name.split(",")[0];
}

function categoryIconFor(cls) {
  const map = {
    restaurant: "bi-cup-hot-fill", hospital: "bi-hospital-fill", pharmacy: "bi-capsule",
    fuel: "bi-fuel-pump-fill", supermarket: "bi-basket3-fill", hotel: "bi-building",
    school: "bi-mortarboard-fill", bank: "bi-bank", atm: "bi-credit-card-fill",
    police: "bi-shield-fill", university: "bi-mortarboard-fill", city: "bi-buildings",
    town: "bi-buildings", village: "bi-houses", road: "bi-signpost-2-fill",
    residential: "bi-signpost-2-fill", suburb: "bi-pin-map-fill",
  };
  return map[cls] || "bi-geo-alt-fill";
}

function resultRowHtml(r, idx) {
  const name = primaryName(r);
  const dist = state.userPosition
    ? formatDistance(haversineMeters(state.userPosition.lat, state.userPosition.lon, parseFloat(r.lat), parseFloat(r.lon)))
    : "";
  return `
    <li class="result-row" data-idx="${idx}" onclick="onResultClick(${idx})">
      <span class="result-icon"><i class="bi ${categoryIconFor(r.type || r.class)}"></i></span>
      <span class="result-text">
        <span class="result-name">${escapeHtml(name)}</span>
        <span class="result-address">${escapeHtml(r.display_name)}</span>
      </span>
      ${dist ? `<span class="result-dist">${dist}</span>` : ""}
    </li>`;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str || "";
  return d.innerHTML;
}

function onResultClick(idx) {
  const results = JSON.parse($("#search-panel").dataset.results || "[]");
  const place = results[idx];
  if (!place) return;
  selectPlace(place);
}

function selectPlace(place) {
  if (state.addingStop) { proposeStop(place); return; }
  clearStops();
  state.follow = false;
  state.selectedPlace = place;
  renderSearchPanel(null);
  $("#search-input").value = place.name;
  $("#search-clear").classList.remove("hidden");

  if (state.destMarker) state.map.removeLayer(state.destMarker);
  state.destMarker = L.marker([place.lat, place.lon], { icon: destinationDivIcon() }).addTo(state.map);
  state.map.setView([place.lat, place.lon], 16, { animate: true });

  addToHistory(place);
  openPlaceCard(place);
}

/* -------------------------------------------------------------------------
   CARTÃO DE LOCAL / PAINEL DE ROTA
   ------------------------------------------------------------------------- */
function openPlaceCard(place) {
  const dist = state.userPosition
    ? formatDistance(haversineMeters(state.userPosition.lat, state.userPosition.lon, place.lat, place.lon))
    : "—";
  const isFav = state.favorites.some((f) => f.lat === place.lat && f.lon === place.lon);

  $("#sheet-title").textContent = place.name;
  $("#sheet-address").textContent = place.address || "";
  $("#sheet-distance").textContent = dist;
  $("#fav-toggle-btn").innerHTML = `<i class="bi ${isFav ? "bi-heart-fill" : "bi-heart"}"></i>`;
  $("#fav-toggle-btn").classList.toggle("active", isFav);
  renderPlaceNote(place);

  showSheet("place-sheet");
}

function favoriteCount() { return state.favorites.filter((f) => f.savedType === "favorito").length; }

function toggleFavoriteCurrent() {
  const place = state.selectedPlace;
  if (!place) return;
  const idx = state.favorites.findIndex((f) => f.lat === place.lat && f.lon === place.lon);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    showToast("Removido dos favoritos.");
  } else {
    if (!isPremiumActive() && favoriteCount() >= FREE_FAVORITES_MAX) {
      openPaywall(t("fav.limit").replace("{n}", FREE_FAVORITES_MAX));
      return;
    }
    state.favorites.push({ ...place, savedType: "favorito", savedAt: Date.now() });
    showToast("Adicionado aos favoritos.", "success");
  }
  saveFavorites();
  openPlaceCard(place);
  if ($("#panel-favorites").classList.contains("open")) renderFavoritesPanel();
}

function addToHistory(place) {
  state.history = state.history.filter((h) => !(h.lat === place.lat && h.lon === place.lon));
  state.history.unshift({ ...place, searchedAt: Date.now() });
  state.history = state.history.slice(0, 12);
  saveHistory();
}

/* -------------------------------------------------------------------------
   ROTAS (OSRM / ORS)
   ------------------------------------------------------------------------- */
async function requestRoute(profile) {
  if (!state.userPosition) {
    showToast("Precisamos da sua localização para calcular a rota. Ative o GPS.", "error");
    requestLocation();
    return;
  }
  if (!state.selectedPlace) return;

  if (profile === "motorcycle" && state.routeProfile !== "motorcycle") {
    showToast("Para mota usamos a mesma rede de estradas do carro — as APIs gratuitas ainda não têm um perfil próprio para motas.", "info");
  }

  state.routeProfile = profile;
  setRouteButtonsActive(profile);
  showRouteLoading(true);

  try {
    let data;
    if (CONFIG.ROUTING_PROVIDER === "ors" && CONFIG.ORS_API_KEY) {
      data = await fetchRouteORS(profile);
    } else {
      data = await fetchRouteOSRM(profile);
    }
    if (!data || (Array.isArray(data) && !data.length)) throw new Error("no-route");
    state.routeOptions = Array.isArray(data) ? data : [data];
    state.routeIdx = 0;
    drawRoute(true);
  } catch (err) {
    showToast("Não foi possível calcular a rota para este modo de transporte. Tente outro meio de transporte.", "error");
  } finally {
    showRouteLoading(false);
  }
}

async function fetchRouteOSRM(profile) {
  const osrmProfile = PROFILE_TO_OSRM[profile];
  const { lat: lat1, lon: lon1 } = state.userPosition;
  const { lat: lat2, lon: lon2 } = state.selectedPlace;
  const stops = activeStops();
  const pts = [[lon1, lat1], ...stops.map((s) => [s.lon, s.lat]), [lon2, lat2]].map((c) => c.join(",")).join(";");
  // o OSRM só sugere alternativas em rotas de 2 pontos
  let url = `${CONFIG.OSRM_BASE_URL}/${osrmProfile}/${pts}?overview=full&geometries=geojson&steps=true&alternatives=${stops.length || isDataSaver() ? "false" : "true"}`;
  if (isPremiumActive() && state.avoid.size && (profile === "driving" || profile === "motorcycle")) {
    url += `&exclude=${Array.from(state.avoid).join(",")}`;
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes || !json.routes.length) return null;
  return json.routes.slice(0, 3).map((route) => ({
    coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: route.distance,
    duration: route.duration,
    steps: route.legs.flatMap((leg, li) => leg.steps.map((st) => mapOsrmStep(st, li < route.legs.length - 1 ? li + 1 : null))),
  }));
}

function mapOsrmStep(step, stopNo) {
  const isStopArrival = stopNo && step.maneuver.type === "arrive";
  return {
    instruction: isStopArrival ? `${t("stops.arrived")} ${stopNo}` : instructionFromManeuver(step.maneuver, step.name),
    icon: iconForManeuver(step.maneuver),
    distance: step.distance,
    location: [step.maneuver.location[1], step.maneuver.location[0]],
  };
}

async function fetchRouteORS(profile) {
  const orsProfile = PROFILE_TO_ORS[profile];
  const { lat: lat1, lon: lon1 } = state.userPosition;
  const { lat: lat2, lon: lon2 } = state.selectedPlace;
  const res = await fetch(`https://api.openrouteservice.org/v2/directions/${orsProfile}/geojson`, {
    method: "POST",
    headers: {
      Authorization: CONFIG.ORS_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ coordinates: [[lon1, lat1], ...activeStops().map((s) => [s.lon, s.lat]), [lon2, lat2]] }),
  });
  if (!res.ok) return null;
  const json = await res.json();
  const feature = json.features && json.features[0];
  if (!feature) return null;
  const segs = feature.properties.segments;
  return {
    coords: feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distance: segs.reduce((a, x) => a + x.distance, 0),
    duration: segs.reduce((a, x) => a + x.duration, 0),
    steps: segs.flatMap((seg) => seg.steps).map((s) => ({
      instruction: s.instruction,
      distance: s.distance,
      location: feature.geometry.coordinates[s.way_points[0]]
        ? [feature.geometry.coordinates[s.way_points[0]][1], feature.geometry.coordinates[s.way_points[0]][0]]
        : null,
    })),
  };
}

const TURN_PT = {
  left: "Vire à esquerda", right: "Vire à direita",
  "slight left": "Mantenha-se ligeiramente à esquerda", "slight right": "Mantenha-se ligeiramente à direita",
  "sharp left": "Vire acentuadamente à esquerda", "sharp right": "Vire acentuadamente à direita",
  straight: "Siga em frente", uturn: "Faça inversão de marcha",
};

function instructionFromManeuver(maneuver, roadName) {
  const road = roadName ? ` para ${roadName}` : "";
  switch (maneuver.type) {
    case "depart": return `Siga em frente${road}`;
    case "arrive": return "Você chegou ao destino";
    case "roundabout": case "rotary": return `Entre na rotunda e saia${road}`;
    case "merge": return `Junte-se à via${road}`;
    case "fork": return `Mantenha-se ${maneuver.modifier === "left" ? "à esquerda" : "à direita"} na bifurcação${road}`;
    case "end of road": return `${TURN_PT[maneuver.modifier] || "Vire"}${road}`;
    case "continue": return `Continue em frente${road}`;
    case "new name": return `Continue${road}`;
    case "turn": return `${TURN_PT[maneuver.modifier] || "Vire"}${road}`;
    default: return `Siga${road}`;
  }
}

function iconForManeuver(m) {
  const mod = m.modifier || "";
  if (m.type === "arrive") return "bi-flag-fill";
  if (m.type === "roundabout" || m.type === "rotary") return "bi-arrow-repeat";
  if (mod === "uturn") return "bi-arrow-return-left";
  if (mod.includes("left")) return mod.includes("slight") ? "bi-arrow-up-left-circle-fill" : "bi-arrow-left-circle-fill";
  if (mod.includes("right")) return mod.includes("slight") ? "bi-arrow-up-right-circle-fill" : "bi-arrow-right-circle-fill";
  return "bi-arrow-up-circle-fill";
}

function setRouteButtonsActive(profile) {
  $all(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.profile === profile));
}

function showRouteLoading(isLoading) {
  $("#route-calc-status").classList.toggle("hidden", !isLoading);
}

function clearRoute() {
  if (state.routeLayer) state.map.removeLayer(state.routeLayer);
  if (state.routeCasing) state.map.removeLayer(state.routeCasing);
  state.routeLayer = null;
  state.routeCasing = null;
  state.altLayers.forEach((l) => state.map.removeLayer(l));
  state.altLayers = [];
}

function drawRoute(fit) {
  clearRoute();
  const list = state.routeOptions;
  const data = list[state.routeIdx];
  state.routeCoords = data.coords;
  state.routeSteps = data.steps;
  state.routeSummary = { distance: data.distance, duration: data.duration };

  // alternativas em cinzento (toque para escolher)
  list.forEach((opt, i) => {
    if (i === state.routeIdx) return;
    const alt = L.polyline(opt.coords, { className: "route-alt", color: "#8A8078", weight: 6, opacity: 0.75, lineCap: "round", lineJoin: "round" }).addTo(state.map);
    alt.on("click", () => selectRoute(i));
    state.altLayers.push(alt);
  });

  state.routeCasing = L.polyline(data.coords, { color: "#FFFFFF", weight: 12, opacity: 0.95, lineCap: "round", lineJoin: "round", interactive: false }).addTo(state.map);
  state.routeLayer = L.polyline(data.coords, {
    className: "route-line",
    color: "#FF5A36",
    weight: 7,
    opacity: 0.95,
    lineCap: "round",
    lineJoin: "round",
  }).addTo(state.map);

  if (fit) {
    state.follow = false;
    state.map.fitBounds(state.routeLayer.getBounds(), { padding: [60, 60] });
  }

  $("#route-distance").textContent = formatDistance(data.distance);
  $("#route-duration").textContent = formatDuration(data.duration);
  updateCostChip();
  renderStops();
  renderRouteAlternatives();
  showSheet("route-sheet");
}

function selectRoute(i) {
  if (i === state.routeIdx || !state.routeOptions[i]) return;
  state.routeIdx = i;
  drawRoute(false);
}

function renderRouteAlternatives() {
  const box = $("#route-alts");
  const list = state.routeOptions;
  if (list.length < 2) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  const fastest = Math.min(...list.map((o) => o.duration));
  box.innerHTML = list
    .map((o, i) => `<button type="button" class="alt-chip ${i === state.routeIdx ? "selected" : ""}" onclick="selectRoute(${i})">
      <b>${formatDuration(o.duration)}</b><span>${formatDistance(o.distance)}${o.duration === fastest ? " · Mais rápida" : ""}</span></button>`)
    .join("");
}

/* -------------------------------------------------------------------------
   MODO NAVEGAÇÃO
   ------------------------------------------------------------------------- */
function startNavigation() {
  if (!state.routeLayer || !state.routeSteps.length) {
    showToast("Calcule uma rota primeiro.", "error");
    return;
  }
  state.isNavigating = true;
  state.navStartedAt = Date.now();
  state.currentStepIdx = state.routeSteps.length > 1 ? 1 : 0;
  state.spoken = {};
  state.follow = true;
  state.altLayers.forEach((l) => state.map.removeLayer(l));
  state.altLayers = [];
  soundStart();
  beginTripRecording();
  document.body.classList.add("navigating");
  showSheet(null);
  $("#nav-hud").classList.remove("hidden");
  updateNavHud();
  state.prevTilt = state.tiltOn;
  if (state.settings.autoTilt !== false) setTiltView(true);
  if (state.userPosition) state.map.setView([state.userPosition.lat, state.userPosition.lon], 17);
  syncNavButtons();
  showToast("Navegação iniciada.", "success");
  state.speedOver = false;
  $("#nav-speed-box").classList.remove("over");
  const first = state.routeSteps[state.currentStepIdx];
  speak(`Navegação iniciada. ${first ? first.instruction : ""}`);
}

function endNavigation() {
  state.isNavigating = false;
  document.body.classList.remove("navigating");
  $("#nav-hud").classList.add("hidden");
  $("#recalc-btn").classList.add("hidden");
  state.speedOver = false;
  $("#nav-speed-box").classList.remove("over");
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  if (state.settings.autoTilt !== false && !state.prevTilt) setTiltView(false);
}

function updateNavigationProgress(lat, lon) {
  if (!state.routeCoords.length) return;

  // distância mínima até à polyline
  let minDist = Infinity;
  let closestIdx = 0;
  for (let i = 0; i < state.routeCoords.length; i++) {
    const [rlat, rlon] = state.routeCoords[i];
    const d = haversineMeters(lat, lon, rlat, rlon);
    if (d < minDist) { minDist = d; closestIdx = i; }
  }

  const offRoute = minDist > CONFIG.OFF_ROUTE_THRESHOLD_M;
  $("#recalc-btn").classList.toggle("hidden", !offRoute);
  if (offRoute && !state.spoken.off) { state.spoken.off = true; speak("Saiu da rota. Toque em recalcular."); }
  if (!offRoute) state.spoken.off = false;

  let remaining = 0;
  for (let i = closestIdx; i < state.routeCoords.length - 1; i++) {
    const [lat1, lon1] = state.routeCoords[i];
    const [lat2, lon2] = state.routeCoords[i + 1];
    remaining += haversineMeters(lat1, lon1, lat2, lon2);
  }

  const totalDistance = state.routeSummary.distance || remaining;
  const fractionLeft = totalDistance > 0 ? remaining / totalDistance : 0;
  const remainingDuration = state.routeSummary.duration * fractionLeft;

  // próxima manobra: avança quando o utilizador passa pelo ponto da manobra
  const steps = state.routeSteps;
  let idx = state.currentStepIdx || 0;
  while (idx < steps.length - 1 && steps[idx].location && haversineMeters(lat, lon, steps[idx].location[0], steps[idx].location[1]) < 30) idx++;
  state.currentStepIdx = idx;
  const step = steps[idx];
  const dToStep = step && step.location ? haversineMeters(lat, lon, step.location[0], step.location[1]) : remaining;

  if (step) {
    $("#nav-instruction").textContent = step.instruction;
    $("#nav-step-distance").textContent = `em ${formatDistance(dToStep)}`;
    $("#nav-turn-icon").className = `bi ${step.icon || "bi-arrow-up-circle-fill"} turn-icon`;
    // voz: aviso a ~300 m e a ~80 m
    const k300 = `${idx}-300`, k80 = `${idx}-80`;
    if (dToStep <= 80 && !state.spoken[k80]) { state.spoken[k80] = state.spoken[k300] = true; speak(step.instruction); }
    else if (dToStep <= 300 && dToStep > 80 && !state.spoken[k300]) {
      state.spoken[k300] = true;
      speak(`Em ${Math.max(50, Math.round(dToStep / 50) * 50)} metros, ${step.instruction.charAt(0).toLowerCase()}${step.instruction.slice(1)}`);
    }
  }
  $("#nav-remaining-distance").textContent = formatDistance(remaining);
  $("#nav-remaining-time").textContent = formatDuration(remainingDuration);
  $("#nav-eta").textContent = `Chegada ${formatEta(remainingDuration)}`;
  $("#nav-speed").textContent = state.speed != null ? `${Math.round(state.speed * 3.6)}` : "—";
  checkSpeedAlert();
  checkStopReached(lat, lon);

  recordTripPoint(lat, lon);
  if (state.isNavigating) followUser(lat, lon);

  if (remaining < 25) {
    finishTripRecording(true);
    endNavigation();
    speak(t("toast.arrived"));
    showArrival();
  }
}

function recalculateRoute() {
  showToast("A recalcular rota...", "info");
  requestRoute(state.routeProfile).then(() => {
    state.currentStepIdx = state.routeSteps.length > 1 ? 1 : 0;
    state.spoken = {};
    // uma rota nova abre o cartão; durante a navegação, continuamos no HUD
    if (state.isNavigating) {
      showSheet(null);
      state.altLayers.forEach((l) => state.map.removeLayer(l));
      state.altLayers = [];
      $("#recalc-btn").classList.add("hidden");
      if (state.userPosition) state.map.setView([state.userPosition.lat, state.userPosition.lon], 17, { animate: false });
    }
  });
}

function updateNavHud() {
  if (!state.routeSteps.length) return;
  const first = state.routeSteps[state.currentStepIdx] || state.routeSteps[0];
  $("#nav-instruction").textContent = first.instruction;
  $("#nav-step-distance").textContent = `em ${formatDistance(first.distance)}`;
  $("#nav-turn-icon").className = `bi ${first.icon || "bi-arrow-up-circle-fill"} turn-icon`;
  $("#nav-remaining-distance").textContent = formatDistance(state.routeSummary.distance);
  $("#nav-remaining-time").textContent = formatDuration(state.routeSummary.duration);
  $("#nav-eta").textContent = `Chegada ${formatEta(state.routeSummary.duration)}`;
  $("#nav-speed").textContent = "—";
}

function syncNavButtons() {
  const v = $("#nav-voice-btn");
  if (v) v.innerHTML = `<i class="bi ${state.settings.voice !== false ? "bi-volume-up-fill" : "bi-volume-mute-fill"}"></i>`;
  const t = $("#nav-tilt-btn");
  if (t) t.classList.toggle("active", state.tiltOn);
}

/* -------------------------------------------------------------------------
   CATEGORIAS (Overpass API)
   ------------------------------------------------------------------------- */
async function searchCategory(key) {
  if (key === "bairros") return showBairrosList();
  const cat = CATEGORY_TAGS[key];
  if (!cat) return;

  const center = (state.userPosition && !isFarFromCity(state.userPosition))
    ? state.userPosition
    : { lat: state.map.getCenter().lat, lon: state.map.getCenter().lng };
  const [tagKey, tagVal] = cat.tag.split("=");
  const radius = 4000;
  const query = `[out:json][timeout:25];(node["${tagKey}"="${tagVal}"](around:${radius},${center.lat},${center.lon});way["${tagKey}"="${tagVal}"](around:${radius},${center.lat},${center.lon}););out center 40;`;

  clearCategoryMarkers();
  showToast(`A procurar ${cat.label.toLowerCase()}s próximos...`);

  try {
    const res = await fetch(CONFIG.OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query,
    });
    if (!res.ok) throw new Error("overpass-error");
    const json = await res.json();
    renderCategoryResults(json.elements || [], cat, center);
  } catch (err) {
    showToast("O serviço de pesquisa de locais está temporariamente indisponível. Tente novamente.", "error");
  }
}

function clearCategoryMarkers() {
  state.categoryMarkers.forEach((m) => state.map.removeLayer(m));
  state.categoryMarkers = [];
}

function renderCategoryResults(elements, cat, center) {
  if (!elements.length) {
    showToast(`Nenhum(a) ${cat.label.toLowerCase()} encontrado(a) nas proximidades.`, "info");
    return;
  }
  const icon = categoryDivIcon(cat.icon);
  const bounds = [];

  elements.slice(0, 30).forEach((el) => {
    const lat = el.lat || (el.center && el.center.lat);
    const lon = el.lon || (el.center && el.center.lon);
    if (!lat || !lon) return;
    const name = (el.tags && el.tags.name) || cat.label;
    const marker = L.marker([lat, lon], { icon }).addTo(state.map);
    marker.on("click", () => {
      selectPlace({ name, address: (el.tags && el.tags["addr:street"]) || cat.label, lat, lon, category: cat.label });
    });
    state.categoryMarkers.push(marker);
    bounds.push([lat, lon]);
  });

  if (bounds.length) state.map.fitBounds(bounds, { padding: [70, 70], maxZoom: 16 });
  showToast(`${bounds.length} resultado(s) encontrado(s).`, "success");
}

/* -------------------------------------------------------------------------
   PAINÉIS: MENU, FAVORITOS, HISTÓRICO, DEFINIÇÕES
   ------------------------------------------------------------------------- */
function showSheet(id) {
  $all(".bottom-sheet").forEach((s) => s.classList.remove("open"));
  if (id) $(`#${id}`).classList.add("open");
  else setBottomNavActive("map");
}

function toggleMenu(forceOpen) {
  const menu = $("#side-menu");
  const overlay = $("#menu-overlay");
  const open = forceOpen !== undefined ? forceOpen : !menu.classList.contains("open");
  menu.classList.toggle("open", open);
  overlay.classList.toggle("open", open);
  document.body.classList.toggle("menu-open", open);
}

function openPanel(id) {
  toggleMenu(false);
  $all(".panel").forEach((p) => p.classList.remove("open"));
  $(`#${id}`).classList.add("open");
  if (id === "panel-favorites") renderFavoritesPanel();
  if (id === "panel-history") renderHistoryPanel();
  if (id === "panel-profile") updateProfileUI();
  if (id === "panel-trips") renderTripsPanel();
  if (id === "panel-premium") refreshPremiumUI();
  if (id === "panel-stats") renderStatsPanel();
  if (id === "panel-offline") renderOfflinePanel();
  setBottomNavActive(id === "panel-favorites" ? "favorites" : id === "panel-profile" ? "profile" : "map");
}

function closePanel(id) {
  $(`#${id}`).classList.remove("open");
  setBottomNavActive("map");
}

function closeAllPanels() {
  $all(".panel").forEach((p) => p.classList.remove("open"));
}

/* -------------------------------------------------------------------------
   NAVBAR FLUTUANTE (estilo Google Maps)
   ------------------------------------------------------------------------- */
function wireBottomNav() {
  $all(".bn-item").forEach((btn) => btn.addEventListener("click", () => onBottomNavClick(btn.dataset.bn)));
}

function setBottomNavActive(key) {
  const items = $all(".bn-item");
  items.forEach((b) => b.classList.toggle("active", b.dataset.bn === key));
  const idx = Math.max(0, items.findIndex((b) => b.dataset.bn === key));
  const indicator = $("#bn-indicator");
  if (indicator) indicator.style.transform = `translateX(${idx * 100}%)`;
}

function onBottomNavClick(key) {
  setBottomNavActive(key);
  if (key === "map") {
    showSheet(null);
    closeAllPanels();
    toggleMenu(false);
  } else if (key === "routes") {
    closeAllPanels();
    toggleMenu(false);
    if (state.routeLayer && state.routeSummary) {
      showSheet("route-sheet");
    } else if (state.selectedPlace) {
      openPlaceCard(state.selectedPlace);
    } else {
      showSheet(null);
      showToast("Pesquise um destino para traçar uma rota.", "info");
      $("#search-input").focus();
    }
  } else if (key === "favorites") {
    showSheet(null);
    openPanel("panel-favorites");
  } else if (key === "profile") {
    showSheet(null);
    openPanel("panel-profile");
  }
}

function renderFavoritesPanel() {
  const counter = $("#fav-counter");
  const showCounter = !isPremiumActive();
  counter.classList.toggle("hidden", !showCounter);
  if (showCounter) counter.textContent = t("fav.counter").replace("{a}", favoriteCount()).replace("{n}", FREE_FAVORITES_MAX);
  const list = $("#favorites-list");
  if (!state.favorites.length) {
    list.innerHTML = `<p class="empty-state"><i class="bi bi-heart"></i> Ainda não tem favoritos guardados.</p>`;
    return;
  }
  list.innerHTML = state.favorites
    .map(
      (f, i) => `
      <li class="fav-row">
        <span class="result-icon"><i class="bi ${f.savedType === "casa" ? "bi-house-door-fill" : f.savedType === "trabalho" ? "bi-briefcase-fill" : "bi-heart-fill"}"></i></span>
        <span class="result-text" onclick="goToFavorite(${i})">
          <span class="result-name">${escapeHtml(f.name)}</span>
          <span class="result-address">${escapeHtml(f.address || "")}</span>
          ${getNote(f) ? `<span class="result-note"><i class="bi bi-sticky-fill"></i> ${escapeHtml(getNote(f))}</span>` : ""}
        </span>
        <button class="icon-btn-small" onclick="removeFavorite(${i})" aria-label="Remover"><i class="bi bi-trash"></i></button>
      </li>`
    )
    .join("");
}

function goToFavorite(i) {
  const place = state.favorites[i];
  closePanel("panel-favorites");
  selectPlace(place);
}

function removeFavorite(i) {
  state.favorites.splice(i, 1);
  saveFavorites();
  renderFavoritesPanel();
}

function setHomeOrWork(type) {
  if (!state.selectedPlace) { showToast("Pesquise um local primeiro.", "error"); return; }
  state.favorites = state.favorites.filter((f) => f.savedType !== type);
  state.favorites.push({ ...state.selectedPlace, savedType: type, savedAt: Date.now() });
  saveFavorites();
  showToast(type === "casa" ? "Casa definida." : "Trabalho definido.", "success");
}

function renderHistoryPanel() {
  const list = $("#history-list");
  if (!state.history.length) {
    list.innerHTML = `<p class="empty-state"><i class="bi bi-clock-history"></i> Sem pesquisas recentes.</p>`;
    return;
  }
  list.innerHTML = state.history
    .map(
      (h, i) => `
      <li class="fav-row">
        <span class="result-icon"><i class="bi bi-clock-history"></i></span>
        <span class="result-text" onclick="goToHistory(${i})">
          <span class="result-name">${escapeHtml(h.name)}</span>
          <span class="result-address">${escapeHtml(h.address || "")}</span>
        </span>
      </li>`
    )
    .join("");
}

function goToHistory(i) {
  const place = state.history[i];
  closePanel("panel-history");
  selectPlace(place);
}

function clearHistory() {
  state.history = [];
  saveHistory();
  renderHistoryPanel();
  showToast("Histórico limpo.");
}

function clearFavorites() {
  state.favorites = [];
  saveFavorites();
  renderFavoritesPanel();
  showToast("Favoritos limpos.");
}

/* -------------------------------------------------------------------------
   DEFINIÇÕES
   ------------------------------------------------------------------------- */
function applyTheme() {
  document.documentElement.setAttribute("data-theme", state.settings.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", state.settings.theme === "dark" ? "#141110" : "#FF5A36");
  $("#theme-toggle-icon").className = `bi ${state.settings.theme === "dark" ? "bi-sun-fill" : "bi-moon-fill"}`;
  refreshBaseLayer();
}

function desiredBase() {
  // sem internet e com áreas offline guardadas: usa o mapa que está guardado
  if (navigator.onLine === false && offlineConfigured() && state.offline.areas.length) return "map";
  if (state.settings.mapType === "satellite" && !isDataSaver()) return "satellite";
  if ((state.settings.mapType === "voyager" || state.settings.mapType === "positron") && isPremiumActive()) return state.settings.mapType;
  return state.settings.theme === "dark" ? "dark" : "map";
}

function refreshBaseLayer() {
  if (!state.map || !state.tileLayers.map) return;
  const want = desiredBase();
  if (state.currentTileType === want) return;
  state.tileLayers[state.currentTileType].remove();
  state.tileLayers[want].addTo(state.map);
  state.currentTileType = want;
}

function toggleTheme() {
  state.settings.theme = state.settings.theme === "dark" ? "light" : "dark";
  saveSettings();
  applyTheme();
  syncSettingsUI();
}

function setUnits(units) {
  state.settings.units = units;
  saveSettings();
  syncSettingsUI();
  showToast(`Unidades alteradas para ${units === "km" ? "quilómetros" : "milhas"}.`);
}

function setMapType(type) {
  if (state.settings.mapType === type) return;
  if (type === "satellite" && isDataSaver()) { showToast(t("saver.nosat"), "info"); return; }
  if ((type === "voyager" || type === "positron") && !requirePremium("Este tema de mapa é um recurso Premium.")) return;
  state.settings.mapType = type;
  saveSettings();
  refreshBaseLayer();
  syncSettingsUI();
}

function toggleMapType() {
  setMapType(state.settings.mapType === "map" ? "satellite" : "map");
}

function syncSettingsUI() {
  $all("[data-units]").forEach((b) => b.classList.toggle("active", b.dataset.units === state.settings.units));
  $all("[data-maptype]").forEach((b) => b.classList.toggle("active", b.dataset.maptype === state.settings.mapType));
  $all(".avoid-chip").forEach((b) => b.classList.toggle("active", state.avoid.has(b.dataset.avoid)));
  const isDark = state.settings.theme === "dark";
  $("#theme-switch").checked = isDark;
  const voiceSwitch = $("#voice-switch");
  if (voiceSwitch) voiceSwitch.checked = state.settings.voice !== false;
  const tiltSwitch = $("#autotilt-switch");
  if (tiltSwitch) tiltSwitch.checked = state.settings.autoTilt !== false;
  const soundSwitch = $("#sound-switch");
  if (soundSwitch) soundSwitch.checked = state.settings.sound !== false;
  const switch2 = $("#theme-switch-2");
  if (switch2) switch2.checked = isDark;
}

/* -------------------------------------------------------------------------
   VISTA 3D ("DE PÉ"), DIREÇÃO E BÚSSOLA
   ------------------------------------------------------------------------- */
function normDeg(d) { return ((d % 360) + 360) % 360; }
function angleDelta(a, b) { let d = normDeg(b - a); if (d > 180) d -= 360; return d; }

function bearingBetween(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return normDeg((Math.atan2(y, x) * 180) / Math.PI);
}

function setHeading(h, source) {
  if (source === "compass" && Date.now() - state.gpsHeadingAt < 3000) return; // GPS em movimento tem prioridade
  if (source === "gps") state.gpsHeadingAt = Date.now();
  state.heading = normDeg(state.heading + angleDelta(state.heading, h) * 0.3);
  if (state.viewRaf) return;
  state.viewRaf = requestAnimationFrame(() => { state.viewRaf = 0; applyMapView(false); });
}

function applyMapView(force) {
  const now = performance.now();
  const rot = state.tiltOn && state.headingUp && state.hasHeading ? state.heading : 0;
  if (!force) {
    if (Math.abs(angleDelta(state.appliedRot || 0, rot)) < 2.5 && Math.abs(angleDelta(state.appliedHeading || 0, state.heading)) < 4) return;
    if (now - (state.lastViewAt || 0) < 140) {
      if (!state.viewTimer) state.viewTimer = setTimeout(() => { state.viewTimer = 0; applyMapView(true); }, 150);
      return;
    }
  }
  state.lastViewAt = now;
  state.appliedRot = rot;
  state.appliedHeading = state.heading;

  // só o #map é transformado (compositor/GPU); nada de variáveis CSS globais
  const mapEl = $("#map");
  mapEl.style.transform = state.tiltActive ? `translateY(150px) rotateX(58deg) rotateZ(${(-rot).toFixed(1)}deg)` : "";
  if (state.labelPane && (force === true || Math.abs(angleDelta(state.labelRot || 0, rot)) >= 5)) {
    state.labelRot = rot;
    state.labelPane.style.setProperty("--inv-rot", `${rot.toFixed(0)}deg`);
  }
  const markerEl = state.userMarker && state.userMarker.getElement();
  const cone = markerEl && markerEl.querySelector(".user-cone");
  if (cone) cone.style.transform = `rotate(${(state.heading - rot).toFixed(1)}deg)`;
  if (state.coneShown !== state.hasHeading) {
    state.coneShown = state.hasHeading;
    $("#app").classList.toggle("has-heading", state.hasHeading);
  }
  const needle = $("#compass-needle");
  if (needle) needle.style.transform = `rotate(${(-rot).toFixed(1)}deg)`;
}

// Na vista 3D o mapa é maior que o ecrã: menos mosaicos de margem, sem animação de
// fade e só carrega novos mosaicos quando o movimento pára.
function applyTiltTileOptions(on) {
  const saver = isDataSaver();
  Object.values(state.tileLayers).forEach((l) => {
    l.options.keepBuffer = on || saver ? 0 : 1;
    l.options.updateWhenIdle = on || saver ? true : !!L.Browser.mobile;
    l.options.updateWhenZooming = !(on || saver);
  });
  if (state.map) state.map._fadeAnimated = !on && L.Browser.any3d; // sem fade dos mosaicos em 3D
}

function setTiltView(on) {
  if (state.tiltOn === on) return;
  state.tiltOn = on;
  applyTiltTileOptions(on);
  const app = $("#app");
  if (on) {
    state.follow = true;
    app.classList.add("tilt-on");
    state.map.invalidateSize({ animate: false });
    if (state.userPosition) state.map.setView([state.userPosition.lat, state.userPosition.lon], Math.max(state.map.getZoom(), 17), { animate: false });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!state.tiltOn) return;
      app.classList.add("tilt-active");
      state.tiltActive = true;
      applyMapView(true);
    }));
    setTimeout(() => { if (state.tiltOn) app.classList.add("tilt-settled"); }, 1000);
    state.map.dragging.disable();
    startCompass();
  } else {
    app.classList.remove("tilt-active", "tilt-settled");
    state.tiltActive = false;
    state.map.dragging.enable();
    setTimeout(() => {
      if (!state.tiltOn) {
        app.classList.remove("tilt-on");
        state.map.invalidateSize({ animate: false });
      }
    }, 900);
  }
  applyMapView(true);
  const tb = $("#tilt-btn");
  if (tb) tb.classList.toggle("active", on);
  $("#compass-btn").classList.toggle("hidden", !on);
  syncNavButtons();
}

function toggleTilt() {
  setTiltView(!state.tiltOn);
  if (state.tiltOn) showToast("Vista 3D ativa: o mapa segue a sua direção. Toque na bússola para fixar o norte.", "info");
}

function toggleHeadingUp() {
  state.headingUp = !state.headingUp;
  applyMapView(true);
  showToast(state.headingUp ? "O mapa gira com a sua direção." : "Mapa fixo com o norte para cima.", "info");
}

let compassStarted = false;
function compassHeadingFromEuler(alpha, beta, gamma) {
  const d = Math.PI / 180;
  const cA = Math.cos(alpha * d), sA = Math.sin(alpha * d);
  const sB = Math.sin(beta * d);
  const cG = Math.cos(gamma * d), sG = Math.sin(gamma * d);
  const rA = -cA * sG - sA * sB * cG;
  const rB = -sA * sG + cA * sB * cG;
  let h = Math.atan(rA / rB);
  if (rB < 0) h += Math.PI; else if (rA < 0) h += 2 * Math.PI;
  return (h * 180) / Math.PI;
}

function startCompass() {
  if (compassStarted) return;
  const attach = () => {
    compassStarted = true;
    const handler = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === "number" && typeof e.beta === "number" && typeof e.gamma === "number") h = compassHeadingFromEuler(e.alpha, e.beta, e.gamma);
      if (h === null || Number.isNaN(h)) return;
      state.hasHeading = true;
      setHeading(h, "compass");
    };
    window.addEventListener("deviceorientationabsolute", handler, true);
    window.addEventListener("deviceorientation", handler, true);
  };
  if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((r) => { if (r === "granted") attach(); else showToast("Sem permissão da bússola. A direção virá do GPS ao mover-se.", "info"); })
      .catch(() => {});
  } else {
    attach();
  }
}

/* -------------------------------------------------------------------------
   VOZ DE NAVEGAÇÃO
   ------------------------------------------------------------------------- */
function speak(text) {
  if (state.settings.voice === false || !("speechSynthesis" in window) || !text) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "pt-PT";
    u.rate = 1;
    speechSynthesis.speak(u);
  } catch (e) { /* voz indisponível */ }
}

function toggleVoice() {
  state.settings.voice = state.settings.voice === false;
  saveSettings();
  syncSettingsUI();
  syncNavButtons();
  if (state.settings.voice) speak("Voz de navegação ligada.");
  else if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* -------------------------------------------------------------------------
   PARTILHAR, ONDE ESTACIONEI, MARCAR LOCAL NO MAPA
   ------------------------------------------------------------------------- */
async function shareCurrentPlace() {
  const p = state.selectedPlace;
  if (!p) return;
  const url = `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=18/${p.lat}/${p.lon}`;
  const text = `${p.name}${p.address ? " — " + p.address : ""}`;
  if (navigator.share) {
    try { await navigator.share({ title: p.name, text, url }); } catch (e) { /* cancelado */ }
  } else {
    try { await navigator.clipboard.writeText(`${text}\n${url}`); showToast("Link do local copiado.", "success"); }
    catch (e) { showToast("Não foi possível copiar o link.", "error"); }
  }
}

function parkingIcon() {
  return L.divIcon({ className: "parking-marker", html: `<div class="parking-pin">P</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
}

function loadParking() {
  try { return JSON.parse(localStorage.getItem("navigo:parking")); } catch (e) { return null; }
}

function renderParking() {
  if (state.parkMarker) { state.map.removeLayer(state.parkMarker); state.parkMarker = null; }
  const park = loadParking();
  const has = !!park;
  $("#go-car-btn").classList.toggle("hidden", !has);
  $("#forget-car-btn").classList.toggle("hidden", !has);
  if (has) state.parkMarker = L.marker([park.lat, park.lon], { icon: parkingIcon() }).addTo(state.map);
}

function markParking() {
  toggleMenu(false);
  if (!state.userPosition) { showToast("Precisamos do GPS para marcar onde estacionou.", "error"); requestLocation(true); return; }
  localStorage.setItem("navigo:parking", JSON.stringify({ ...state.userPosition, t: Date.now() }));
  renderParking();
  showToast("Local do carro guardado. Use 'Voltar ao meu carro' quando precisar.", "success");
}

function goToCar() {
  toggleMenu(false);
  const park = loadParking();
  if (!park) return;
  selectPlace({ name: "O meu carro", address: "Local onde estacionou", lat: park.lat, lon: park.lon, category: "parking" });
}

function forgetCar() {
  toggleMenu(false);
  localStorage.removeItem("navigo:parking");
  renderParking();
  showToast("Local do carro removido.");
}

async function dropPin(latlng) {
  const lat = latlng.lat, lon = latlng.lng;
  let name = "Local marcado";
  let address = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  showToast("A identificar o local...");
  try {
    const params = new URLSearchParams({ format: "jsonv2", lat, lon, zoom: "18", addressdetails: "1" });
    const res = await fetch(`${CONFIG.NOMINATIM_BASE_URL}/reverse?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (res.ok) {
      const j = await res.json();
      if (j && j.display_name) {
        name = j.name || (j.address && (j.address.road || j.address.suburb)) || j.display_name.split(",")[0];
        address = j.display_name;
      }
    }
  } catch (e) { /* mantém coordenadas */ }
  selectPlace({ name, address, lat, lon, category: "pin" });
}

/* -------------------------------------------------------------------------
   IDIOMA (PT / EN) — cobre a interface fixa do app
   ------------------------------------------------------------------------- */
const I18N = {
  pt: {
    "search.placeholder": "Para onde você quer ir?",
    "cat.bairros": "Bairros", "cat.restaurantes": "Restaurantes", "cat.hospitais": "Hospitais",
    "cat.farmacias": "Farmácias", "cat.combustivel": "Combustível", "cat.supermercados": "Supermercados", "cat.hoteis": "Hotéis",
    "nav.map": "Mapa", "nav.routes": "Rotas", "nav.favorites": "Favoritos", "nav.profile": "Perfil",
    "mode.driving": "Carro", "mode.motorcycle": "Mota", "mode.walking": "A pé", "mode.cycling": "Bicicleta",
    "sheet.routes": "Rotas", "sheet.cancel": "Cancelar", "sheet.viewroute": "Ver rota", "sheet.start": "Iniciar", "sheet.routetitle": "Rota",
    "nav.recalc": "Recalcular rota", "nav.end": "ENCERRAR",
    "brand.tagline": "Navegue com liberdade",
    "menu.history": "Histórico", "menu.mylocation": "Minha localização", "menu.markparking": "Marcar onde estacionei",
    "menu.gocar": "Voltar ao meu carro", "menu.forgetcar": "Esquecer local do carro", "menu.settings": "Definições",
    "menu.darktheme": "Tema escuro", "menu.about": "Sobre",
    "panel.favorites": "Favoritos", "panel.history": "Pesquisas recentes", "trips.title": "Minhas viagens",
    "panel.settings": "Definições", "panel.about": "Sobre o NaviGo", "panel.profile": "Perfil",
    "fav.clear": "Limpar favoritos", "hist.clear": "Apagar histórico", "fav.sethome": "Definir Casa", "fav.setwork": "Definir Trabalho",
    "profile.searches": "Pesquisas", "profile.searchhistory": "Histórico de pesquisas", "profile.appsettings": "Definições do app",
    "profile.save": "Guardar alterações",
    "settings.language": "Idioma", "settings.appearance": "Aparência", "settings.darktheme": "Tema escuro",
    "settings.darkthemedesc": "Mapa e menus em tons escuros", "settings.mapsection": "Mapa", "settings.maptype": "Tipo de mapa",
    "settings.map": "Mapa", "settings.satellite": "Satélite", "settings.units": "Unidades",
    "settings.km": "Quilómetros", "settings.mi": "Milhas", "settings.navigation": "Navegação",
    "settings.tilt": "Vista 3D ao navegar", "settings.tiltdesc": "Mapa inclinado que segue a sua direção",
    "settings.voice": "Voz de navegação", "settings.voicedesc": "Instruções faladas no seu idioma",
    "settings.sound": "Sons e vibração", "settings.sounddesc": "Ao iniciar e ao chegar ao destino",
    "settings.data": "Dados", "settings.clearhist": "Limpar histórico", "settings.clearhistdesc": "Apaga as pesquisas recentes",
    "settings.clearfav": "Limpar favoritos", "settings.clearfavdesc": "Remove todos os locais guardados",
    "trips.clear": "Apagar viagens guardadas",
    "toast.tripstarted": "Navegação iniciada.", "toast.arrived": "Você chegou ao seu destino.",
    "toast.langchanged": "Idioma alterado para Português.",
    "toast.voiceon": "Voz de navegação ligada.", "toast.mic.unsupported": "A pesquisa por voz não é suportada neste navegador. Funciona melhor no Chrome para Android.",
    "toast.mic.denied": "Permissão do microfone recusada.", "toast.mic.listening": "A ouvir...",
    "toast.share.copied": "Detalhes da viagem copiados.", "toast.share.fail": "Não foi possível partilhar agora.",
    "trips.empty": "Ainda não fez nenhuma viagem guiada pelo NaviGo.",
    "trips.km": "km percorridos", "trips.completed": "Concluída", "trips.stopped": "Interrompida",
    "stats.title": "Estatísticas de viagem",
    "premium.includes": "O que inclui", "premium.perk1": "Temas de mapa exclusivos (Aventureiro e Minimalista)",
    "premium.perk2": "Rotas sem portagens ou sem autoestradas", "premium.perk3": "Exportar as suas viagens em GPX",
    "premium.perk4": "Estatísticas completas das suas viagens", "premium.plans": "Planos",
    "premium.day": "1 dia", "premium.week": "1 semana", "premium.month": "1 mês",
    "premium.howto": "Como pagar",
    "premium.howtotext": "Envie o valor do plano por M-Pesa para o número abaixo, depois entre em contacto a confirmar o pagamento. Vai receber um código para desbloquear o Premium.",
    "premium.mpesanumber": "Número M-Pesa", "premium.copy": "Copiar número",
    "premium.redeem": "Já pagou? Introduza o código", "premium.unlock": "Ativar",
    "premium.codehint": "O código é fornecido depois de confirmarmos o pagamento consigo.",
    "premium.theme.voyager": "Aventureiro", "premium.theme.positron": "Minimalista",
    "premium.avoidtoll": "Evitar portagens", "premium.avoidhw": "Evitar autoestradas",
    "premium.export": "Exportar tudo (GPX)",
  },
  en: {
    "search.placeholder": "Where do you want to go?",
    "cat.bairros": "Neighborhoods", "cat.restaurantes": "Restaurants", "cat.hospitais": "Hospitals",
    "cat.farmacias": "Pharmacies", "cat.combustivel": "Fuel", "cat.supermercados": "Supermarkets", "cat.hoteis": "Hotels",
    "nav.map": "Map", "nav.routes": "Routes", "nav.favorites": "Favorites", "nav.profile": "Profile",
    "mode.driving": "Car", "mode.motorcycle": "Moto", "mode.walking": "Walk", "mode.cycling": "Bike",
    "sheet.routes": "Routes", "sheet.cancel": "Cancel", "sheet.viewroute": "View route", "sheet.start": "Start", "sheet.routetitle": "Route",
    "nav.recalc": "Recalculate route", "nav.end": "END",
    "brand.tagline": "Navigate freely",
    "menu.history": "History", "menu.mylocation": "My location", "menu.markparking": "Mark where I parked",
    "menu.gocar": "Back to my car", "menu.forgetcar": "Forget car location", "menu.settings": "Settings",
    "menu.darktheme": "Dark theme", "menu.about": "About",
    "panel.favorites": "Favorites", "panel.history": "Recent searches", "trips.title": "My trips",
    "panel.settings": "Settings", "panel.about": "About NaviGo", "panel.profile": "Profile",
    "fav.clear": "Clear favorites", "hist.clear": "Clear history", "fav.sethome": "Set Home", "fav.setwork": "Set Work",
    "profile.searches": "Searches", "profile.searchhistory": "Search history", "profile.appsettings": "App settings",
    "profile.save": "Save changes",
    "settings.language": "Language", "settings.appearance": "Appearance", "settings.darktheme": "Dark theme",
    "settings.darkthemedesc": "Map and menus in dark tones", "settings.mapsection": "Map", "settings.maptype": "Map type",
    "settings.map": "Map", "settings.satellite": "Satellite", "settings.units": "Units",
    "settings.km": "Kilometers", "settings.mi": "Miles", "settings.navigation": "Navigation",
    "settings.tilt": "3D view while navigating", "settings.tiltdesc": "Tilted map that follows your heading",
    "settings.voice": "Turn-by-turn voice", "settings.voicedesc": "Spoken directions in your language",
    "settings.sound": "Sound & vibration", "settings.sounddesc": "When starting and arriving",
    "settings.data": "Data", "settings.clearhist": "Clear history", "settings.clearhistdesc": "Deletes your recent searches",
    "settings.clearfav": "Clear favorites", "settings.clearfavdesc": "Removes all saved places",
    "trips.clear": "Clear saved trips",
    "toast.tripstarted": "Navigation started.", "toast.arrived": "You have arrived at your destination.",
    "toast.langchanged": "Language switched to English.",
    "toast.voiceon": "Turn-by-turn voice turned on.", "toast.mic.unsupported": "Voice search isn't supported in this browser. It works best on Chrome for Android.",
    "toast.mic.denied": "Microphone permission denied.", "toast.mic.listening": "Listening...",
    "toast.share.copied": "Trip details copied.", "toast.share.fail": "Couldn't share right now.",
    "trips.empty": "You haven't taken any NaviGo-guided trip yet.",
    "trips.km": "km traveled", "trips.completed": "Completed", "trips.stopped": "Stopped",
    "stats.title": "Trip statistics",
    "premium.includes": "What's included", "premium.perk1": "Exclusive map themes (Adventurer and Minimalist)",
    "premium.perk2": "Toll-free or highway-free routes", "premium.perk3": "Export your trips as GPX",
    "premium.perk4": "Full statistics of your trips", "premium.plans": "Plans",
    "premium.day": "1 day", "premium.week": "1 week", "premium.month": "1 month",
    "premium.howto": "How to pay",
    "premium.howtotext": "Send the plan amount via M-Pesa to the number below, then contact to confirm payment. You'll receive a code to unlock Premium.",
    "premium.mpesanumber": "M-Pesa number", "premium.copy": "Copy number",
    "premium.redeem": "Already paid? Enter the code", "premium.unlock": "Activate",
    "premium.codehint": "The code is provided once we confirm your payment with you.",
    "premium.theme.voyager": "Adventurer", "premium.theme.positron": "Minimalist",
    "premium.avoidtoll": "Avoid tolls", "premium.avoidhw": "Avoid highways",
    "premium.export": "Export all (GPX)",
  },
};

Object.assign(I18N.pt, {
  "premium.perk5": "Favoritos ilimitados", "premium.perk6": "Várias paragens numa rota",
  "premium.perk7": "Estimativa do custo de combustível", "premium.perk8": "Alertas de velocidade",
  "fav.limit": "No plano grátis pode guardar até {n} favoritos. Com o Premium são ilimitados.",
  "fav.counter": "{a} de {n} favoritos · ilimitados no Premium",
  "stops.add": "Adicionar paragem", "stops.cancel": "Cancelar paragem",
  "stops.premium": "Várias paragens é um recurso Premium.", "stops.hint": "Pesquise o local da paragem.",
  "stops.max": "Máximo de {n} paragens.", "stops.confirm": "Adicionar paragem", "stops.title": "Paragem",
  "stops.arrived": "Chegou à paragem", "stops.reached": "Paragem alcançada:",
  "cost.label": "Combustível", "cost.premium": "A estimativa de custo é um recurso Premium.", "cost.lock": "Premium",
  "stats.fuelcost": "Gasto est. (MT)", "stats.fuelliters": "Combustível (L)",
  "settings.fuel": "Combustível", "settings.fueldesc": "Usado para estimar o custo das viagens de carro e mota",
  "settings.fuelprice": "Preço do combustível (MT/litro)", "settings.conscar": "Consumo do carro (L/100 km)",
  "settings.consmoto": "Consumo da mota (L/100 km)",
  "settings.speed": "Alerta de velocidade", "settings.speedalert": "Avisar ao passar do limite",
  "settings.speedalertdesc": "Sinal sonoro e vibração durante a navegação", "settings.speedlimit": "Limite de velocidade (km/h)",
  "speed.premium": "Os alertas de velocidade são um recurso Premium.", "speed.warn": "Velocidade acima do limite. Reduza.",
  "premium.perk9": "Mapas offline", "premium.perk10": "Notas nos locais guardados",
  "premium.perk11": "Resumo mensal das viagens", "premium.perk12": "Modo poupança de dados",
  "note.btn": "Nota", "note.premium": "As notas nos locais são um recurso Premium.",
  "note.placeholder": "Ex: portão azul, entrada pelo lado esquerdo", "note.save": "Guardar",
  "note.saved": "Nota guardada.", "note.removed": "Nota removida.", "sheet.cancel2": "Cancelar",
  "stats.monthly": "Resumo mensal", "stats.mtrips": "Viagens", "stats.mkm": "Km", "stats.mtime": "Tempo", "stats.mcost": "Gasto est. (MT)",
  "stats.mmore": "{p}% mais km do que em {m}", "stats.mless": "{p}% menos km do que em {m}", "stats.mempty": "Ainda sem viagens neste mês.",
  "settings.saver": "Poupança de dados", "settings.saverdesc": "Sem satélite, menos mosaicos do mapa e sem rotas alternativas",
  "saver.premium": "O modo poupança de dados é um recurso Premium.", "saver.nosat": "O satélite está desativado no modo poupança de dados.",
  "offline.title": "Mapas offline", "offline.intro": "Guarde o mapa no telemóvel para o ver, com a sua posição GPS, sem dados. A pesquisa e o cálculo de rotas continuam a precisar de internet, por isso calcule a rota antes de sair.",
  "offline.newarea": "Nova área", "offline.name": "Nome da área", "offline.detail": "Nível de detalhe",
  "offline.d14": "Básico", "offline.d16": "Normal", "offline.d17": "Detalhado",
  "offline.save": "Guardar a área visível no mapa", "offline.cancel": "Cancelar descarga",
  "offline.saved": "Áreas guardadas", "offline.none": "Ainda não guardou nenhuma área.",
  "offline.premium": "Os mapas offline são um recurso Premium.", "offline.defaultname": "Minha área",
  "offline.tiles": "mosaicos", "offline.toobig": "Área grande demais. Aproxime o mapa ou escolha menos detalhe.",
  "offline.datawarn": "Vai usar cerca de {mb} MB de dados. Melhor com Wi-Fi.",
  "offline.needonline": "Precisa de internet para guardar uma área.", "offline.unsupported": "Este navegador não suporta guardar mapas offline.",
  "offline.progress": "A guardar {a} de {n}...", "offline.done": "Área guardada. Já pode usá-la sem internet.",
  "offline.cancelled": "Descarga cancelada.", "offline.failed": "Não foi possível guardar a área (sem espaço ou ligação instável). Tente de novo.",
  "offline.working": "Sem ligação. Os mapas offline guardados continuam a funcionar.",
  "offline.used": "Espaço usado pelo app:",
});
Object.assign(I18N.en, {
  "premium.perk5": "Unlimited favorites", "premium.perk6": "Multi-stop routes",
  "premium.perk7": "Fuel cost estimate", "premium.perk8": "Speed alerts",
  "fav.limit": "The free plan allows up to {n} favorites. Premium is unlimited.",
  "fav.counter": "{a} of {n} favorites · unlimited with Premium",
  "stops.add": "Add stop", "stops.cancel": "Cancel stop",
  "stops.premium": "Multiple stops is a Premium feature.", "stops.hint": "Search for the stop's location.",
  "stops.max": "Maximum of {n} stops.", "stops.confirm": "Add stop", "stops.title": "Stop",
  "stops.arrived": "You reached stop", "stops.reached": "Stop reached:",
  "cost.label": "Fuel", "cost.premium": "Cost estimate is a Premium feature.", "cost.lock": "Premium",
  "stats.fuelcost": "Est. spend (MT)", "stats.fuelliters": "Fuel (L)",
  "settings.fuel": "Fuel", "settings.fueldesc": "Used to estimate the cost of car and motorcycle trips",
  "settings.fuelprice": "Fuel price (MT/liter)", "settings.conscar": "Car consumption (L/100 km)",
  "settings.consmoto": "Motorcycle consumption (L/100 km)",
  "settings.speed": "Speed alert", "settings.speedalert": "Warn when over the limit",
  "settings.speedalertdesc": "Beep and vibration while navigating", "settings.speedlimit": "Speed limit (km/h)",
  "speed.premium": "Speed alerts are a Premium feature.", "speed.warn": "Over the speed limit. Slow down.",
  "premium.perk9": "Offline maps", "premium.perk10": "Notes on saved places",
  "premium.perk11": "Monthly trip summary", "premium.perk12": "Data saver mode",
  "note.btn": "Note", "note.premium": "Place notes are a Premium feature.",
  "note.placeholder": "E.g. blue gate, enter on the left side", "note.save": "Save",
  "note.saved": "Note saved.", "note.removed": "Note removed.", "sheet.cancel2": "Cancel",
  "stats.monthly": "Monthly summary", "stats.mtrips": "Trips", "stats.mkm": "Km", "stats.mtime": "Time", "stats.mcost": "Est. spend (MT)",
  "stats.mmore": "{p}% more km than in {m}", "stats.mless": "{p}% fewer km than in {m}", "stats.mempty": "No trips this month yet.",
  "settings.saver": "Data saver", "settings.saverdesc": "No satellite, fewer map tiles and no alternative routes",
  "saver.premium": "Data saver mode is a Premium feature.", "saver.nosat": "Satellite is disabled in data saver mode.",
  "offline.title": "Offline maps", "offline.intro": "Save the map on your phone to view it, with your GPS position, without data. Search and route calculation still need internet, so calculate your route before you leave.",
  "offline.newarea": "New area", "offline.name": "Area name", "offline.detail": "Level of detail",
  "offline.d14": "Basic", "offline.d16": "Normal", "offline.d17": "Detailed",
  "offline.save": "Save the area visible on the map", "offline.cancel": "Cancel download",
  "offline.saved": "Saved areas", "offline.none": "You haven't saved any area yet.",
  "offline.premium": "Offline maps are a Premium feature.", "offline.defaultname": "My area",
  "offline.tiles": "tiles", "offline.toobig": "Area too large. Zoom in or choose less detail.",
  "offline.datawarn": "This will use about {mb} MB of data. Best on Wi-Fi.",
  "offline.needonline": "You need internet to save an area.", "offline.unsupported": "This browser can't save offline maps.",
  "offline.progress": "Saving {a} of {n}...", "offline.done": "Area saved. You can now use it without internet.",
  "offline.cancelled": "Download cancelled.", "offline.failed": "Couldn't save the area (no space or unstable connection). Try again.",
  "offline.working": "No connection. Your saved offline maps keep working.",
  "offline.used": "Space used by the app:",
});

function t(key) {
  const lang = state.settings.lang || "pt";
  return (I18N[lang] && I18N[lang][key]) || I18N.pt[key] || key;
}

function applyI18n() {
  const lang = state.settings.lang || "pt";
  document.documentElement.setAttribute("lang", lang === "en" ? "en" : "pt-MZ");
  $all("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $all("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  $all("#lang-switch button").forEach((b) => b.classList.toggle("active", b.dataset.lang === lang));
}

function setLanguage(lang) {
  if (state.settings.lang === lang) return;
  state.settings.lang = lang;
  saveSettings();
  applyI18n();
  showToast(t("toast.langchanged"), "success");
}

/* -------------------------------------------------------------------------
   PESQUISA POR VOZ (Web Speech API — nativa do navegador, sem chaves)
   ------------------------------------------------------------------------- */
let recognizer = null;

function getRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (!recognizer) recognizer = new SR();
  recognizer.lang = state.settings.lang === "en" ? "en-US" : "pt-MZ";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  return recognizer;
}

function toggleVoiceSearch() {
  const rec = getRecognizer();
  const btn = $("#mic-btn");
  if (!rec) {
    showToast(t("toast.mic.unsupported"), "error");
    return;
  }
  if (state.listening) { rec.stop(); return; }

  rec.onstart = () => { state.listening = true; btn.classList.add("listening"); showToast(t("toast.mic.listening")); };
  rec.onend = () => { state.listening = false; btn.classList.remove("listening"); };
  rec.onerror = (e) => {
    state.listening = false;
    btn.classList.remove("listening");
    if (e.error === "not-allowed" || e.error === "service-not-allowed") showToast(t("toast.mic.denied"), "error");
  };
  rec.onresult = (e) => {
    const text = e.results[0][0].transcript;
    $("#search-input").value = text;
    $("#search-clear").classList.remove("hidden");
    runSearch(text);
    vibrate(15);
  };
  try { rec.start(); } catch (e) { /* já a correr */ }
}

/* -------------------------------------------------------------------------
   VIAGENS GUARDADAS (trajeto percorrido)
   ------------------------------------------------------------------------- */
function loadTrips() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.trips)) || []; } catch (e) { return []; }
}
function saveTrips() { localStorage.setItem(STORAGE_KEYS.trips, JSON.stringify(state.trips.slice(0, 20))); }

/* -------------------------------------------------------------------------
   NAVIGO PREMIUM (sem backend: teste grátis de 30 dias + códigos manuais)
   ------------------------------------------------------------------------- */
function loadPremium() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.premium)); } catch (e) { return null; }
}
function savePremium(p) { state.premium = p; localStorage.setItem(STORAGE_KEYS.premium, JSON.stringify(p)); }

function trialEndsAt() {
  const start = state.userProfile && state.userProfile.acceptedAt ? state.userProfile.acceptedAt : Date.now();
  return start + TRIAL_DAYS * 86400000;
}

function isPremiumActive() {
  if (Date.now() < trialEndsAt()) return true;
  return !!(state.premium && state.premium.unlockedUntil > Date.now());
}

function premiumSourceLabel() {
  if (Date.now() < trialEndsAt()) {
    const daysLeft = Math.max(1, Math.ceil((trialEndsAt() - Date.now()) / 86400000));
    return { title: "Teste grátis ativo", sub: `Faltam ${daysLeft} dia${daysLeft === 1 ? "" : "s"} do seu primeiro mês grátis.` };
  }
  if (state.premium && state.premium.unlockedUntil > Date.now()) {
    const d = new Date(state.premium.unlockedUntil);
    const ds = d.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" });
    const hs = d.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
    return { title: "Premium ativo", sub: `Válido até ${ds} às ${hs}.` };
  }
  return { title: "Premium bloqueado", sub: "O seu mês grátis terminou. Veja os planos para desbloquear." };
}

function redeemPremiumCode(raw) {
  const code = raw.trim().toUpperCase().replace(/\s+/g, "");
  const match = Object.keys(PREMIUM_CODES).find((k) => k.toUpperCase() === code);
  if (!match) {
    showToast("Código inválido. Verifique com atenção ou contacte para confirmar o pagamento.", "error");
    return false;
  }
  const plan = PREMIUM_CODES[match];
  const now = Date.now();
  const base = state.premium && state.premium.unlockedUntil > now ? state.premium.unlockedUntil : now;
  savePremium({ unlockedUntil: base + plan.days * 86400000, plan: plan.plan, code: match });
  refreshPremiumUI();
  showToast("Premium ativado! Obrigado.", "success");
  vibrate([40, 40, 40]);
  return true;
}

function openPaywall(featureNote) {
  if (featureNote) showToast(featureNote, "info");
  closeAllPanels();
  openPanel("panel-premium");
}

function refreshPremiumUI() {
  if (state.map && isDataSaver() !== state.saverApplied) applyDataSaver();
  const active = isPremiumActive();
  document.body.classList.toggle("is-premium", active);
  const info = premiumSourceLabel();
  $("#premium-status-title").textContent = info.title;
  $("#premium-status-sub").textContent = info.sub;
  $("#premium-hero-title").textContent = info.title;
  $("#premium-hero-sub").textContent = info.sub;
  $("#stats-lock").classList.toggle("unlocked", active);
  $("#perk-offline").classList.toggle("xh", !offlineConfigured());
  $("#offline-menu-group").classList.toggle("xh", !offlineConfigured());
  const icon = $("#premium-card-btn .premium-ico i");
  if (icon) icon.className = active ? "bi bi-gem-fill" : "bi bi-lock-fill";
}

function requirePremium(featureNote) {
  if (isPremiumActive()) return true;
  openPaywall(featureNote);
  return false;
}

/* ---- Exportar viagens em GPX (ficheiro padrão, funciona no Google Earth, Garmin, etc.) ---- */
function tripToGpxTrack(trip) {
  const pts = trip.path
    .map(([lat, lon]) => `      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`)
    .join("\n");
  return `  <trk><name>${escapeXml(trip.destName)}</name><trkseg>\n${pts}\n    </trkseg></trk>`;
}
function escapeXml(s) { return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])); }

function exportTripsGpx() {
  if (!requirePremium("Exportar viagens é um recurso Premium.")) return;
  if (!state.trips.length) { showToast("Ainda não tem viagens guardadas para exportar.", "info"); return; }
  const tracks = state.trips.map(tripToGpxTrack).join("\n");
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="NaviGo" xmlns="http://www.topografix.com/GPX/1/1">\n${tracks}\n</gpx>`;
  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `navigo-viagens-${new Date().toISOString().slice(0, 10)}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  showToast("Ficheiro GPX descarregado.", "success");
}

/* ---- Estatísticas (Premium) ---- */
function renderStatsPanel() {
  const body = $("#stats-body");
  if (!requirePremiumInline()) {
    body.innerHTML = `<div class="stats-locked"><i class="bi bi-lock-fill"></i>Estatísticas são um recurso Premium.<br><button class="btn btn-primary" style="margin-top:14px;" onclick="openPaywall()">Ver planos</button></div>`;
    return;
  }
  const totalKm = state.trips.reduce((sum, t) => sum + t.distance, 0) / 1000;
  const completed = state.trips.filter((t) => t.completed).length;
  const longest = state.trips.reduce((max, t) => Math.max(max, t.distance), 0) / 1000;
  const fuelTotal = state.trips.reduce((acc, tr) => {
    const e = estimateFuel(tr.distance, tr.profile);
    if (e) { acc.cost += e.cost; acc.liters += e.liters; }
    return acc;
  }, { cost: 0, liters: 0 });
  body.innerHTML = `
    <div class="stat-grid">
      <div><b>${state.trips.length}</b><span>Viagens</span></div>
      <div><b>${totalKm.toFixed(1)}</b><span>Km percorridos</span></div>
      <div><b>${completed}</b><span>Concluídas</span></div>
      <div><b>${longest.toFixed(1)}</b><span>Maior viagem (km)</span></div>
      <div><b>${Math.round(fuelTotal.cost)}</b><span>${t("stats.fuelcost")}</span></div>
      <div><b>${fuelTotal.liters.toFixed(1)}</b><span>${t("stats.fuelliters")}</span></div>
    </div>${monthlyHtml()}`;
}
function requirePremiumInline() { return isPremiumActive(); }



function beginTripRecording() {
  const dest = state.selectedPlace;
  state.activeTrip = {
    id: `${Date.now()}`,
    destName: dest ? dest.name : "Destino",
    originCity: state.userProfile ? state.userProfile.city : "",
    startedAt: Date.now(),
    profile: state.routeProfile,
    path: state.userPosition ? [[state.userPosition.lat, state.userPosition.lon]] : [],
    distance: 0,
  };
}

function recordTripPoint(lat, lon) {
  const trip = state.activeTrip;
  if (!trip) return;
  const last = trip.path[trip.path.length - 1];
  if (last) {
    const d = haversineMeters(last[0], last[1], lat, lon);
    if (d < 15) return; // amostra a cada ~15 m para não pesar o armazenamento
    trip.distance += d;
  }
  trip.path.push([lat, lon]);
  if (trip.path.length > 400) trip.path.splice(1, 40); // mantém a viagem leve em rotas muito longas
}

function finishTripRecording(completed) {
  const trip = state.activeTrip;
  state.activeTrip = null;
  if (!trip || trip.path.length < 2) return;
  trip.endedAt = Date.now();
  trip.completed = completed;
  state.trips.unshift(trip);
  state.trips = state.trips.slice(0, 20);
  saveTrips();
  addTripToMonthly(trip);
}

function tripIcon() {
  return t("trips.completed") === "Completed" ? "bi-flag-fill" : "bi-flag-fill";
}

function renderTripsPanel() {
  const list = $("#trips-list");
  if (!state.trips.length) {
    list.innerHTML = `<p class="empty-state"><i class="bi bi-signpost-2"></i> ${t("trips.empty")}</p>`;
    return;
  }
  list.innerHTML = state.trips
    .map((trip, i) => {
      const km = (trip.distance / 1000).toFixed(1);
      const date = new Date(trip.startedAt).toLocaleDateString(state.settings.lang === "en" ? "en-GB" : "pt-PT", { day: "2-digit", month: "short" });
      const status = trip.completed ? t("trips.completed") : t("trips.stopped");
      return `<li class="trip-row" onclick="showTripOnMap(${i})">
        <span class="trip-icon"><i class="bi bi-flag-fill"></i></span>
        <span class="trip-text"><b>${escapeHtml(trip.destName)}</b><span>${date} · ${km} ${t("trips.km")} · ${status}</span></span>
        <button class="icon-btn-small" onclick="event.stopPropagation(); deleteTrip(${i})" aria-label="Remover"><i class="bi bi-trash"></i></button>
      </li>`;
    })
    .join("");
}

function showTripOnMap(i) {
  const trip = state.trips[i];
  if (!trip) return;
  closeAllPanels();
  setBottomNavActive("map");
  if (state.tripPathLayer) state.map.removeLayer(state.tripPathLayer);
  state.tripPathLayer = L.polyline(trip.path, { color: "#2F6DF6", weight: 5, opacity: 0.85, dashArray: "2 10", lineCap: "round", className: "trip-path" }).addTo(state.map);
  state.map.fitBounds(state.tripPathLayer.getBounds(), { padding: [60, 60] });
  showToast(`${trip.destName} · ${(trip.distance / 1000).toFixed(1)} ${t("trips.km")}`, "info");
}

function deleteTrip(i) {
  state.trips.splice(i, 1);
  saveTrips();
  renderTripsPanel();
}

function clearTrips() {
  state.trips = [];
  saveTrips();
  renderTripsPanel();
  showToast("OK");
}

/* -------------------------------------------------------------------------
   PARTILHAR VIAGEM (estado atual, não em tempo real — o app não tem servidor)
   ------------------------------------------------------------------------- */
async function shareTripStatus() {
  if (!state.isNavigating || !state.selectedPlace) return;
  const dest = state.selectedPlace.name;
  const remaining = $("#nav-remaining-distance").textContent;
  const eta = $("#nav-eta").textContent;
  let posLine = "";
  if (state.userPosition) {
    const { lat, lon } = state.userPosition;
    posLine = `\nA minha posição agora: https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  }
  const text = `🧭 A caminho de ${dest} pelo NaviGo.\nFaltam ${remaining} · ${eta}${posLine}`;
  if (navigator.share) {
    try { await navigator.share({ title: "A minha viagem no NaviGo", text }); } catch (e) { /* cancelado */ }
  } else {
    try { await navigator.clipboard.writeText(text); showToast(t("toast.share.copied"), "success"); }
    catch (e) { showToast(t("toast.share.fail"), "error"); }
  }
}

/* -------------------------------------------------------------------------
   SOM E VIBRAÇÃO (Web Audio API — sem ficheiros de áudio)
   ------------------------------------------------------------------------- */
let audioCtx = null;

function getAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) audioCtx = new AC();
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function playTones(notes) {
  const ctx = getAudio();
  if (!ctx) return;
  const now = ctx.currentTime;
  notes.forEach((n) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.type || "sine";
    osc.frequency.value = n.f;
    gain.gain.setValueAtTime(0.0001, now + n.t);
    gain.gain.linearRampToValueAtTime(n.vol || 0.25, now + n.t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + n.t);
    osc.stop(now + n.t + n.d + 0.05);
  });
}

function vibrate(pattern) {
  if (state.settings.sound !== false && navigator.vibrate) navigator.vibrate(pattern);
}

function soundStart() {
  if (state.settings.sound === false) return;
  playTones([
    { f: 523.25, t: 0, d: 0.28 },
    { f: 659.25, t: 0.12, d: 0.28 },
    { f: 783.99, t: 0.24, d: 0.5 },
  ]);
  vibrate([90, 50, 90]);
}

function soundArrive() {
  if (state.settings.sound === false) return;
  playTones([
    { f: 783.99, t: 0, d: 0.3 },
    { f: 987.77, t: 0.15, d: 0.3 },
    { f: 1174.66, t: 0.3, d: 0.3 },
    { f: 1567.98, t: 0.45, d: 0.9, vol: 0.22 },
  ]);
  vibrate([200, 100, 200, 100, 500]);
}

/* -------------------------------------------------------------------------
   CHEGADA AO DESTINO (animação + som)
   ------------------------------------------------------------------------- */
function showArrival() {
  const place = state.selectedPlace;
  $("#arrival-place").textContent = place ? place.name : "Destino";
  const arrNote = getNote(place);
  $("#arrival-note").classList.toggle("xh", !arrNote);
  $("#arrival-note").innerHTML = arrNote ? `<i class="bi bi-sticky-fill"></i> ${escapeHtml(arrNote)}` : "";
  $("#arrival-distance").textContent = state.routeSummary ? formatDistance(state.routeSummary.distance) : "—";
  const elapsed = state.navStartedAt ? (Date.now() - state.navStartedAt) / 1000 : 0;
  $("#arrival-time").textContent = formatDuration(Math.max(elapsed, 60));

  const burst = $("#arrival-burst");
  burst.innerHTML = "";
  const colors = ["#FF5A36", "#FFB199", "#FFD166", "#1E9E5A", "#FFFFFF"];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement("span");
    p.style.setProperty("--a", `${(360 / 18) * i}deg`);
    p.style.setProperty("--d", `${110 + Math.random() * 70}px`);
    p.style.setProperty("--c", colors[i % colors.length]);
    p.style.animationDelay = `${0.35 + Math.random() * 0.2}s`;
    burst.appendChild(p);
  }
  const overlay = $("#arrival-overlay");
  overlay.classList.remove("hidden");
  // reinicia as animações
  overlay.classList.remove("play");
  void overlay.offsetWidth;
  overlay.classList.add("play");
  soundArrive();
}

function closeArrival() {
  $("#arrival-overlay").classList.add("hidden");
  clearRoute();
  clearStops();
  showSheet(null);
}

/* -------------------------------------------------------------------------
   CIDADE DO UTILIZADOR: centrar mapa, bairros e avenidas
   ------------------------------------------------------------------------- */
async function geocodeCity(name) {
  const params = new URLSearchParams({ format: "jsonv2", q: name, limit: "5", addressdetails: "1" });
  const res = await fetch(`${CONFIG.NOMINATIM_BASE_URL}/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error("network");
  const data = await res.json();
  if (!data.length) return null;
  const best = data.find((r) => ["place", "boundary"].includes(r.category || r.class)) || data[0];
  const lat = parseFloat(best.lat);
  const lon = parseFloat(best.lon);
  // boundingbox do Nominatim: [sul, norte, oeste, leste]
  let [south, north, west, east] = (best.boundingbox || []).map(parseFloat);
  if ([south, north, west, east].some((v) => Number.isNaN(v))) {
    south = lat - 0.05; north = lat + 0.05; west = lon - 0.05; east = lon + 0.05;
  }
  const halfMin = 0.035, halfMax = 0.15;
  if (north - south < halfMin * 2) { south = lat - halfMin; north = lat + halfMin; }
  if (east - west < halfMin * 2) { west = lon - halfMin; east = lon + halfMin; }
  if (north - south > halfMax * 2) { south = lat - halfMax; north = lat + halfMax; }
  if (east - west > halfMax * 2) { west = lon - halfMax; east = lon + halfMax; }
  return { lat, lon, bbox: [south, west, north, east], display: best.display_name };
}

async function setupCity(profile) {
  try {
    if (!profile.cityGeo) {
      const geo = await geocodeCity(profile.city);
      if (!geo) {
        showToast("Não conseguimos encontrar a sua cidade no mapa. Altere-a em Perfil.", "error");
        return false;
      }
      profile.cityGeo = geo;
      saveUserProfile(profile);
    }
  } catch (e) {
    showToast("Sem ligação para localizar a sua cidade. Tente novamente mais tarde.", "error");
    return false;
  }
  const g = profile.cityGeo;
  state.cityCenter = { lat: g.lat, lon: g.lon };
  state.cityBbox = g.bbox;
  const [s, w, n, e] = g.bbox;
  state.map.fitBounds([[s, w], [n, e]], { maxZoom: 14, animate: true });
  loadCityData(profile);
  return true;
}

async function changeCity() {
  if (!state.userProfile) return;
  const newName = $("#profile-name-input").value.trim();
  const newCity = $("#settings-city-input").value.trim();
  const newPhone = $("#profile-phone-input").value.trim();
  const newEmail = $("#profile-email-input").value.trim();
  if (newName.length < 2 || newCity.length < 2) {
    showToast("Preencha o nome e a cidade.", "error");
    return;
  }
  if (newEmail && !isValidEmail(newEmail)) {
    showToast("O e-mail não parece válido. Verifique e tente novamente.", "error");
    return;
  }
  const btn = $("#change-city-btn");
  btn.disabled = true;
  try {
    const cityChanged = newCity.toLowerCase() !== state.userProfile.city.toLowerCase();
    if (cityChanged) {
      const geo = await geocodeCity(newCity);
      if (!geo) {
        showToast("Não conseguimos encontrar essa cidade. Tente outro nome.", "error");
        return;
      }
      state.userProfile.city = newCity;
      state.userProfile.cityGeo = geo;
    }
    Object.assign(state.userProfile, {
      name: newName,
      phone: newPhone,
      email: newEmail,
      bairro: $("#profile-bairro-input").value.trim(),
      transport: state.editTransport || state.userProfile.transport || "driving",
    });
    saveUserProfile(state.userProfile);
    updateProfileUI();
    if (cityChanged) {
      closeAllPanels();
      setBottomNavActive("map");
      await setupCity(state.userProfile);
      showToast(`Cidade alterada para ${newCity}.`, "success");
    } else {
      showToast("Perfil atualizado.", "success");
    }
  } catch (e) {
    showToast("Sem ligação para guardar as alterações agora.", "error");
  } finally {
    btn.disabled = false;
  }
}

const AVENUE_MIN_ZOOM = { trunk: 14, primary: 14, secondary: 15, tertiary: 16 };

async function loadCityData(profile) {
  const g = profile.cityGeo;
  const key = `navigo:cityData:${profile.city.toLowerCase()}`;
  let data = null;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.t < 7 * 24 * 3600 * 1000) data = cached.d;
  } catch (e) { /* ignora cache inválida */ }

  if (!data) {
    const [s, w, n, e] = g.bbox;
    const bb = `${s},${w},${n},${e}`;
    const query = `[out:json][timeout:30];(node["place"~"^(suburb|neighbourhood|quarter|village|hamlet)$"](${bb});way["highway"~"^(trunk|primary|secondary|tertiary)$"]["name"](${bb}););out center 900;`;
    try {
      const res = await fetch(CONFIG.OVERPASS_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: query });
      if (!res.ok) throw new Error("overpass");
      const json = await res.json();
      data = { bairros: [], avenues: [] };
      const seenB = new Set(), seenA = new Set();
      (json.elements || []).forEach((el) => {
        const name = el.tags && el.tags.name;
        if (!name) return;
        const lat = el.lat || (el.center && el.center.lat);
        const lon = el.lon || (el.center && el.center.lon);
        if (!lat || !lon) return;
        if (el.tags.place) {
          if (seenB.has(name)) return;
          seenB.add(name);
          data.bairros.push({ name, lat, lon });
        } else if (el.tags.highway) {
          if (seenA.has(name)) return;
          seenA.add(name);
          data.avenues.push({ name, lat, lon, hw: el.tags.highway });
        }
      });
      data.bairros.sort((a, b) => a.name.localeCompare(b.name, "pt"));
      localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data }));
    } catch (err) {
      showToast("Não foi possível carregar os bairros e avenidas agora. O mapa continua a funcionar.", "error");
      return;
    }
  }
  state.cityData = data;
  renderCityLabels(true);
}

function renderCityLabels(force) {
  if (!state.cityData) return;
  const map = state.map;
  if (!state.labelLayer) state.labelLayer = L.layerGroup().addTo(map);
  const zoom = map.getZoom();
  const c = map.getCenter();
  const last = state.labelRender;
  if (!force && last && last.zoom === zoom) {
    const mpp = (156543 * Math.cos((c.lat * Math.PI) / 180)) / Math.pow(2, zoom);
    if (map.distance(c, last.center) < 140 * mpp) return; // quase não mexeu: não refaz nada
  }
  state.labelRender = { zoom, center: c };
  state.labelLayer.clearLayers();
  const bounds = map.getBounds().pad(0.15);
  const dist = (o) => (o.lat - c.lat) ** 2 + (o.lon - c.lng) ** 2;
  const mk = (o, cls) => L.marker([o.lat, o.lon], {
    interactive: false, keyboard: false, pane: "labels",
    icon: L.divIcon({ className: "map-label", html: `<span class="${cls}">${escapeHtml(o.name)}</span>`, iconSize: [0, 0] }),
  }).addTo(state.labelLayer);

  if (zoom >= 12) {
    state.cityData.bairros
      .filter((b) => bounds.contains([b.lat, b.lon]))
      .sort((a, b) => dist(a) - dist(b))
      .slice(0, 40)
      .forEach((b) => mk(b, "bairro-tag"));
  }
  state.cityData.avenues
    .filter((a) => zoom >= (AVENUE_MIN_ZOOM[a.hw] || 16) && bounds.contains([a.lat, a.lon]))
    .sort((a, b) => dist(a) - dist(b))
    .slice(0, 50)
    .forEach((a) => mk(a, "avenida-tag"));
}

function showBairrosList() {
  const list = state.cityData && state.cityData.bairros;
  if (!list || !list.length) {
    showToast("Ainda estamos a carregar os bairros da sua cidade. Tente novamente em instantes.", "info");
    return;
  }
  const city = state.userProfile ? state.userProfile.city : "";
  const panel = $("#search-panel");
  panel.classList.remove("hidden");
  panel.dataset.results = JSON.stringify(
    list.map((b) => ({ name: b.name, address: `${b.name}, ${city}`, lat: b.lat, lon: b.lon, category: "bairro" }))
  );
  panel.innerHTML = `<div class="panel-title-row"><i class="bi bi-pin-map-fill"></i> Bairros de ${escapeHtml(city)}</div><ul class="result-list">${list
    .map(
      (b, i) => `
    <li class="result-row" onclick="onResultClick(${i})">
      <span class="result-icon"><i class="bi bi-pin-map-fill"></i></span>
      <span class="result-text"><span class="result-name">${escapeHtml(b.name)}</span><span class="result-address">Bairro · ${escapeHtml(city)}</span></span>
    </li>`
    )
    .join("")}</ul>`;
}

/* -------------------------------------------------------------------------
   ARRANQUE DO APP: splash -> (novo: funcionalidades -> cadastro) | (existente: mapa)
   ------------------------------------------------------------------------- */
const SPLASH_DURATION_MS = 6000;

function startAppFlow() {
  const existingProfile = loadUserProfile();
  $("#onboarding-root").style.display = "block";
  showOnbScreen("splash-screen");

  setTimeout(() => {
    if (existingProfile) {
      state.userProfile = existingProfile;
      $("#onboarding-root").style.display = "none";
      updateProfileUI();
      setupCity(existingProfile).then(() => requestLocation());
    } else {
      showOnbScreen("features-screen");
    }
  }, SPLASH_DURATION_MS);
}

function showOnbScreen(id) {
  $all(".onb-screen").forEach((s) => s.classList.add("hidden"));
  $(`#${id}`).classList.remove("hidden");
}

function finishOnboarding(profile) {
  saveUserProfile(profile);
  state.userProfile = profile;
  $("#onboarding-root").style.display = "none";
  updateProfileUI();
  setupCity(profile).then(() => requestLocation());
  showToast(`Bem-vindo(a) ao NaviGo, ${profile.name.split(" ")[0]}!`, "success");
}

function updateProfileUI() {
  const profile = state.userProfile;
  if (!profile) return;
  const firstInitial = profile.name.trim().charAt(0).toUpperCase() || "?";
  const gradient = AVATAR_GRADIENTS[profile.avatar || 0];
  ["#menu-avatar", "#settings-avatar"].forEach((sel) => {
    $(sel).textContent = firstInitial;
    $(sel).style.background = gradient;
  });
  $("#menu-profile-name").textContent = profile.name;
  $("#menu-profile-city").textContent = profile.bairro ? `${profile.bairro}, ${profile.city}` : profile.city;
  $("#menu-profile").classList.remove("hidden");
  $("#settings-profile-name").textContent = profile.name;
  $("#settings-profile-city").textContent = profile.bairro ? `${profile.bairro}, ${profile.city}` : profile.city;
  $("#settings-city-input").value = profile.city;
  $("#profile-name-input").value = profile.name;
  $("#profile-phone-input").value = profile.phone || "";
  $("#profile-email-input").value = profile.email || "";
  $("#profile-bairro-input").value = profile.bairro || "";
  state.editTransport = profile.transport || "driving";
  $all("[data-ptransport]").forEach((x) => x.classList.toggle("active", x.dataset.ptransport === state.editTransport));
  $("#stat-favs").textContent = state.favorites.length;
  $("#stat-history").textContent = state.history.length;

  // preferências do perfil
  state.routeProfile = profile.transport || "driving";
  setRouteButtonsActive(state.routeProfile);
  applyInterestOrder(profile.interests || []);
}

function applyInterestOrder(interests) {
  const bar = $(".quick-cats");
  const chips = $all(".quick-cat");
  const ordered = [];
  const bairros = chips.find((c) => c.dataset.cat === "bairros");
  if (bairros) ordered.push(bairros);
  interests.forEach((k) => { const c = chips.find((x) => x.dataset.cat === k); if (c && !ordered.includes(c)) ordered.push(c); });
  chips.forEach((c) => { if (!ordered.includes(c)) ordered.push(c); });
  ordered.forEach((c) => bar.appendChild(c));
}

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#FF7A50,#E8441F)",
  "linear-gradient(135deg,#7C6CF0,#3B2FB5)",
  "linear-gradient(135deg,#1DC9A0,#00805F)",
  "linear-gradient(135deg,#3AA0F5,#095AA8)",
  "linear-gradient(135deg,#F0589E,#B2245F)",
  "linear-gradient(135deg,#4A4F52,#111315)",
];

const reg = { step: 1, avatar: 0, transport: "driving", interests: new Set(), locationOk: false };

function isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
function phoneDigits(v) { return v.replace(/\D/g, ""); }

function validateRegisterForm() {
  let ok = false;
  if (reg.step === 1) {
    const name = $("#reg-name").value.trim();
    const digits = phoneDigits($("#reg-phone").value);
    const email = $("#reg-email").value.trim();
    ok = name.length >= 2 && digits.length >= 7 && digits.length <= 12 && (!email || isValidEmail(email));
  } else if (reg.step === 2) {
    ok = $("#reg-city").value.trim().length >= 2;
  } else if (reg.step === 3) {
    ok = !!reg.transport;
  } else {
    ok = $("#reg-terms").checked;
  }
  $("#register-submit-btn").disabled = !ok;
}

function goStep(n, back) {
  reg.step = n;
  $all(".reg-step").forEach((el) => {
    const active = Number(el.dataset.step) === n;
    el.classList.toggle("active", active);
    el.classList.toggle("back", !!back);
  });
  $all("#reg-progress span").forEach((el, i) => el.classList.toggle("on", i < n));
  $("#reg-step-label").textContent = `${n}/4`;
  $("#register-submit-btn").textContent = n === 4 ? "Começar a navegar" : "Continuar";
  $(".reg-body").scrollTop = 0;
  validateRegisterForm();
}

function updateRegAvatar() {
  const el = $("#reg-avatar-preview");
  const name = $("#reg-name").value.trim();
  el.textContent = name ? name.charAt(0).toUpperCase() : "?";
  el.style.background = AVATAR_GRADIENTS[reg.avatar];
}

async function finalizeRegistration() {
  const btn = $("#register-submit-btn");
  const name = $("#reg-name").value.trim();
  const city = $("#reg-city").value.trim();
  btn.disabled = true;
  btn.textContent = "A localizar a sua cidade...";
  let cityGeo = null;
  try {
    cityGeo = await geocodeCity(city);
    if (!cityGeo) {
      showToast("Não conseguimos encontrar essa cidade. Verifique o nome (ex.: Quelimane, Maputo, Beira).", "error");
      goStep(2, true);
      return;
    }
  } catch (e) {
    showToast("Sem ligação para localizar a cidade agora. Vamos tentar de novo ao abrir o mapa.", "error");
  }
  state.settings.sound = $("#reg-sound").checked;
  saveSettings();
  finishOnboarding({
    name,
    phone: `${$("#reg-dial").value} ${phoneDigits($("#reg-phone").value)}`,
    email: $("#reg-email").value.trim(),
    city,
    bairro: $("#reg-bairro").value.trim(),
    cityGeo,
    avatar: reg.avatar,
    transport: reg.transport,
    interests: Array.from(reg.interests),
    acceptedAt: Date.now(),
  });
}

function wireOnboardingEvents() {
  $("#features-continue-btn").addEventListener("click", () => { showOnbScreen("register-screen"); goStep(1); });

  ["#reg-name", "#reg-phone", "#reg-email", "#reg-city"].forEach((sel) => $(sel).addEventListener("input", () => {
    validateRegisterForm();
    if (sel === "#reg-name") updateRegAvatar();
  }));
  $("#reg-terms").addEventListener("change", validateRegisterForm);

  // cores de avatar
  const swatches = $("#reg-swatches");
  AVATAR_GRADIENTS.forEach((g, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (i === 0 ? " selected" : "");
    b.style.background = g;
    b.setAttribute("aria-label", `Cor ${i + 1}`);
    b.addEventListener("click", () => {
      reg.avatar = i;
      $all(".swatch").forEach((el, j) => el.classList.toggle("selected", j === i));
      updateRegAvatar();
    });
    swatches.appendChild(b);
  });
  updateRegAvatar();

  // cidades sugeridas
  $all("#reg-city-chips .chip").forEach((chip) => chip.addEventListener("click", () => {
    $("#reg-city").value = chip.dataset.city;
    $all("#reg-city-chips .chip").forEach((c) => c.classList.toggle("selected", c === chip));
    validateRegisterForm();
  }));
  $("#reg-city").addEventListener("input", () => {
    const v = $("#reg-city").value.trim().toLowerCase();
    $all("#reg-city-chips .chip").forEach((c) => c.classList.toggle("selected", c.dataset.city.toLowerCase() === v));
  });

  // transporte
  $all("#reg-transport .transport-card").forEach((card) => card.addEventListener("click", () => {
    reg.transport = card.dataset.transport;
    $all("#reg-transport .transport-card").forEach((c) => c.classList.toggle("selected", c === card));
    validateRegisterForm();
  }));

  // interesses
  $all("#reg-interests .chip").forEach((chip) => chip.addEventListener("click", () => {
    const k = chip.dataset.interest;
    if (reg.interests.has(k)) reg.interests.delete(k); else reg.interests.add(k);
    chip.classList.toggle("selected", reg.interests.has(k));
  }));

  // tema
  $all("#reg-theme button").forEach((b) => b.addEventListener("click", () => {
    state.settings.theme = b.dataset.regtheme;
    saveSettings();
    applyTheme();
    syncSettingsUI();
    $all("#reg-theme button").forEach((x) => x.classList.toggle("active", x === b));
  }));

  // permissão de localização
  $("#perm-btn").addEventListener("click", () => {
    if (!("geolocation" in navigator)) {
      $("#perm-status").textContent = "O seu navegador não suporta geolocalização.";
      return;
    }
    $("#perm-status").textContent = "A pedir permissão...";
    navigator.geolocation.getCurrentPosition(
      () => {
        reg.locationOk = true;
        $("#perm-card").classList.add("ok");
        $("#perm-status").textContent = "Localização ativada ✓";
        vibrate(20);
      },
      (err) => {
        $("#perm-status").textContent = err.code === 1
          ? "Permissão recusada. Pode ativar mais tarde nas definições do navegador."
          : "Não foi possível obter o GPS agora. Pode tentar mais tarde.";
      },
      { enableHighAccuracy: true, timeout: 12000 }
    );
  });

  // navegação entre passos
  $("#register-submit-btn").addEventListener("click", () => {
    if (reg.step < 4) goStep(reg.step + 1);
    else finalizeRegistration();
  });
  $("#reg-back").addEventListener("click", () => {
    if (reg.step > 1) goStep(reg.step - 1, true);
    else showOnbScreen("features-screen");
  });

  $("#terms-link").addEventListener("click", (e) => {
    e.preventDefault();
    $("#terms-modal").classList.remove("hidden");
  });
  $("#terms-close-btn").addEventListener("click", () => $("#terms-modal").classList.add("hidden"));
  $("#terms-modal").addEventListener("click", (e) => {
    if (e.target.id === "terms-modal") $("#terms-modal").classList.add("hidden");
  });
}

/* -------------------------------------------------------------------------
   SENSAÇÃO NATIVA: háptico, arrastar cartões, botões do perfil
   ------------------------------------------------------------------------- */
function wireNativeFeel() {
  // vibração leve ao tocar em elementos interativos
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button, .bn-item, .quick-cat, .mode-btn, .result-row, .menu-item, .transport-card, .chip, .swatch")) vibrate(8);
  }, { passive: true });

  // arrastar cartões inferiores para baixo para fechar
  $all(".bottom-sheet").forEach((sheet) => {
    let startY = null, dy = 0;
    sheet.addEventListener("touchstart", (e) => {
      if (sheet.scrollTop > 0) return;
      startY = e.touches[0].clientY; dy = 0;
      sheet.style.transition = "none";
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (startY === null) return;
      dy = Math.max(0, e.touches[0].clientY - startY);
      sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener("touchend", () => {
      if (startY === null) return;
      sheet.style.transition = "";
      sheet.style.transform = "";
      if (dy > 90) showSheet(null);
      startY = null;
    });
  });

  // modo de transporte padrão no perfil
  $all("[data-ptransport]").forEach((b) => b.addEventListener("click", () => {
    state.editTransport = b.dataset.ptransport;
    $all("[data-ptransport]").forEach((x) => x.classList.toggle("active", x === b));
  }));
}

/* -------------------------------------------------------------------------
   INICIALIZAÇÃO / EVENTOS
   ------------------------------------------------------------------------- */
function wireEvents() {
  $("#search-input").addEventListener("input", onSearchInput);
  $("#search-input").addEventListener("focus", () => {
    if (!$("#search-input").value && state.history.length) renderSearchPanel("recents");
  });
  $("#search-input").addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSearchPanel();
  });
  // fecha o cartão de pesquisa ao tocar fora dele (mapa, botões, etc.)
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#search-panel") || e.target.closest(".search-row") || e.target.closest("[data-cat='bairros']")) return;
    closeSearchPanel();
  });
  $("#search-clear").addEventListener("click", () => {
    $("#search-input").value = "";
    $("#search-clear").classList.add("hidden");
    renderSearchPanel(null);
  });

  $("#menu-btn").addEventListener("click", () => toggleMenu());
  $("#menu-overlay").addEventListener("click", () => toggleMenu(false));
  $all("[data-open-panel]").forEach((b) => b.addEventListener("click", () => openPanel(b.dataset.openPanel)));
  $all("[data-close-panel]").forEach((b) => b.addEventListener("click", () => closePanel(b.dataset.closePanel)));

  $("#locate-btn").addEventListener("click", () => requestLocation(true));
  $("#zoom-in").addEventListener("click", () => state.map.zoomIn());
  $("#zoom-out").addEventListener("click", () => state.map.zoomOut());
  $("#layers-btn").addEventListener("click", () => toggleMapType());

  $all(".quick-cat").forEach((btn) => btn.addEventListener("click", () => searchCategory(btn.dataset.cat)));

  $("#sheet-close").addEventListener("click", () => showSheet(null));
  $("#fav-toggle-btn").addEventListener("click", toggleFavoriteCurrent);
  $("#routes-btn").addEventListener("click", () => requestRoute(state.routeProfile || "driving"));

  $all(".mode-btn").forEach((btn) => btn.addEventListener("click", () => requestRoute(btn.dataset.profile)));
  $("#route-sheet-close").addEventListener("click", () => showSheet(null));
  $("#route-cancel-btn").addEventListener("click", () => {
    clearRoute();
    clearStops();
    showSheet(null);
  });
  $("#start-nav-btn").addEventListener("click", startNavigation);
  $("#view-route-btn").addEventListener("click", () => {
    if (state.routeLayer) state.map.fitBounds(state.routeLayer.getBounds(), { padding: [60, 60] });
  });
  $("#end-nav-btn").addEventListener("click", () => { finishTripRecording(false); endNavigation(); });
  $("#recalc-btn").addEventListener("click", recalculateRoute);

  $("#theme-switch").addEventListener("change", toggleTheme);
  $("#sound-switch").addEventListener("change", (e) => {
    state.settings.sound = e.target.checked;
    saveSettings();
    if (state.settings.sound) soundStart();
  });
  $("#change-city-btn").addEventListener("click", changeCity);
  $("#voice-switch").addEventListener("change", (e) => { state.settings.voice = e.target.checked; saveSettings(); syncNavButtons(); });
  $("#autotilt-switch").addEventListener("change", (e) => { state.settings.autoTilt = e.target.checked; saveSettings(); });
  $("#tilt-btn").addEventListener("click", toggleTilt);
  $("#compass-btn").addEventListener("click", toggleHeadingUp);
  $("#nav-tilt-btn").addEventListener("click", toggleTilt);
  $("#nav-voice-btn").addEventListener("click", toggleVoice);
  $("#nav-share-btn").addEventListener("click", shareTripStatus);
  $("#mic-btn").addEventListener("click", toggleVoiceSearch);
  $("#clear-trips-btn").addEventListener("click", clearTrips);
  $("#export-trips-btn").addEventListener("click", exportTripsGpx);
  $("#premium-redeem-btn").addEventListener("click", () => redeemPremiumCode($("#premium-code-input").value));
  $("#premium-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") redeemPremiumCode(e.target.value); });
  $("#copy-mpesa-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText("844309266"); showToast("Número copiado.", "success"); }
    catch (e) { showToast("Não foi possível copiar. Número: 844 309 266", "info"); }
  });
  $all(".avoid-chip").forEach((chip) => chip.addEventListener("click", () => {
    if (!requirePremium("Evitar portagens/autoestradas é um recurso Premium.")) return;
    const key = chip.dataset.avoid;
    if (state.avoid.has(key)) state.avoid.delete(key); else state.avoid.add(key);
    chip.classList.toggle("active", state.avoid.has(key));
    if (state.selectedPlace && state.routeLayer) requestRoute(state.routeProfile);
  }));
  $all("#lang-switch button").forEach((b) => b.addEventListener("click", () => setLanguage(b.dataset.lang)));
  $("#share-btn").addEventListener("click", shareCurrentPlace);
  $("#park-btn").addEventListener("click", markParking);
  $("#go-car-btn").addEventListener("click", goToCar);
  $("#forget-car-btn").addEventListener("click", forgetCar);
  state.map.on("contextmenu", (e) => { if (!state.tiltOn) dropPin(e.latlng); });
  $("#arrival-done-btn").addEventListener("click", closeArrival);
  $all("[data-units]").forEach((b) => b.addEventListener("click", () => setUnits(b.dataset.units)));
  $all("[data-maptype]").forEach((b) => b.addEventListener("click", () => setMapType(b.dataset.maptype)));
  $("#clear-history-btn").addEventListener("click", clearHistory);
  $("#clear-favorites-btn").addEventListener("click", clearFavorites);
  $("#clear-history-btn2").addEventListener("click", clearHistory);

  $("#set-home-btn").addEventListener("click", () => setHomeOrWork("casa"));
  $("#set-work-btn").addEventListener("click", () => setHomeOrWork("trabalho"));

  window.addEventListener("online", () => { showToast("Ligação restabelecida.", "success"); refreshBaseLayer(); });
  window.addEventListener("offline", () => {
    refreshBaseLayer();
    const hasOffline = offlineConfigured() && state.offline.areas.length;
    showToast(hasOffline ? t("offline.working") : "Sem ligação à internet. O mapa e as rotas precisam de internet.", hasOffline ? "info" : "error");
  });
}

function init() {
  // cada passo é isolado: se um falhar, os restantes continuam a funcionar
  const steps = [
    loadStorage, applyTheme, applyI18n, syncSettingsUI, initMap, wireEvents, wirePremiumExtras, wireExtras2, wireOnboardingEvents,
    () => renderSearchPanel(null), wireBottomNav, wireNativeFeel, renderParking, syncNavButtons, startAppFlow,
  ];
  steps.forEach((fn) => {
    try { fn(); } catch (err) { console.error("[NaviGo] erro em", fn.name || "passo", err); }
  });
  try { refreshPremiumUI(); } catch (err) { console.error("[NaviGo] erro no Premium", err); }
  setInterval(() => { try { refreshPremiumUI(); } catch (e) {} }, 60000);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./service-worker.js", { updateViaCache: "none" })
      .then((reg) => reg.update())
      .catch(() => { /* PWA é opcional */ });
  }
}

/* -------------------------------------------------------------------------
   PREMIUM: PARAGENS, CUSTO DE COMBUSTÍVEL E ALERTA DE VELOCIDADE
   ------------------------------------------------------------------------- */
function activeStops() { return isPremiumActive() ? state.stops : []; }

function stopDivIcon(n) {
  return L.divIcon({ className: "stop-marker", html: `<div class="stop-pin">${n}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function renderStops() {
  const list = $("#stops-list");
  list.innerHTML = state.stops
    .map((s, i) => `<div class="stop-chip"><b>${i + 1}</b><span>${escapeHtml(s.name)}</span><button type="button" onclick="removeStop(${i})" aria-label="Remover"><i class="bi bi-x-lg"></i></button></div>`)
    .join("");
  const btn = $("#add-stop-btn");
  btn.classList.toggle("hidden", state.stops.length >= MAX_STOPS && !state.addingStop);
  btn.classList.toggle("active", state.addingStop);
  $("#add-stop-label").textContent = t(state.addingStop ? "stops.cancel" : "stops.add");
  state.stopMarkers.forEach((m) => state.map.removeLayer(m));
  state.stopMarkers = state.stops.map((s, i) => L.marker([s.lat, s.lon], { icon: stopDivIcon(i + 1), interactive: false }).addTo(state.map));
}

function removeStop(i) {
  state.stops.splice(i, 1);
  renderStops();
  if (state.selectedPlace && state.routeLayer) requestRoute(state.routeProfile);
}

function clearStops() {
  state.stops = [];
  state.addingStop = false;
  state.stopCandidate = null;
  if (state.stopCandidateMarker) { state.map.removeLayer(state.stopCandidateMarker); state.stopCandidateMarker = null; }
  if (state.map) renderStops();
}

function toggleAddStop() {
  if (state.addingStop) { cancelStop(); return; }
  if (!requirePremium(t("stops.premium"))) return;
  if (!state.selectedPlace) return;
  if (state.stops.length >= MAX_STOPS) { showToast(t("stops.max").replace("{n}", MAX_STOPS), "info"); return; }
  state.addingStop = true;
  renderStops();
  $("#search-input").value = "";
  $("#search-clear").classList.add("hidden");
  $("#search-input").focus();
  showToast(t("stops.hint"), "info");
}

function proposeStop(place) {
  state.stopCandidate = place;
  renderSearchPanel(null);
  $("#search-input").value = "";
  if (state.stopCandidateMarker) state.map.removeLayer(state.stopCandidateMarker);
  state.stopCandidateMarker = L.marker([place.lat, place.lon], { icon: stopDivIcon("+"), interactive: false }).addTo(state.map);
  state.follow = false;
  state.map.setView([place.lat, place.lon], 16, { animate: true });
  $("#stop-sheet-title").textContent = place.name;
  $("#stop-sheet-address").textContent = place.address || "";
  showSheet("stop-sheet");
}

function confirmStop() {
  const place = state.stopCandidate;
  if (!place) return;
  state.stops.push({ name: place.name, address: place.address || "", lat: place.lat, lon: place.lon });
  state.addingStop = false;
  state.stopCandidate = null;
  if (state.stopCandidateMarker) { state.map.removeLayer(state.stopCandidateMarker); state.stopCandidateMarker = null; }
  const dest = state.selectedPlace;
  $("#search-input").value = dest ? dest.name : "";
  $("#search-clear").classList.toggle("hidden", !dest);
  renderStops();
  requestRoute(state.routeProfile);
}

function cancelStop() {
  state.addingStop = false;
  state.stopCandidate = null;
  if (state.stopCandidateMarker) { state.map.removeLayer(state.stopCandidateMarker); state.stopCandidateMarker = null; }
  const dest = state.selectedPlace;
  $("#search-input").value = dest ? dest.name : "";
  $("#search-clear").classList.toggle("hidden", !dest);
  renderSearchPanel(null);
  renderStops();
  showSheet(state.routeLayer ? "route-sheet" : null);
}

function checkStopReached(lat, lon) {
  if (!state.stops.length) return;
  const i = state.stops.findIndex((s) => haversineMeters(lat, lon, s.lat, s.lon) < 40);
  if (i < 0) return;
  const s = state.stops.splice(i, 1)[0];
  renderStops();
  showToast(`${t("stops.reached")} ${s.name}`, "success");
}

// custo de combustível: só carro e mota
function estimateFuel(distanceM, profile) {
  if (profile !== "driving" && profile !== "motorcycle") return null;
  const cons = profile === "motorcycle" ? state.settings.consMoto : state.settings.consCar;
  const price = state.settings.fuelPrice;
  if (!(cons > 0) || !(price > 0) || !(distanceM > 0)) return null;
  const liters = (distanceM / 1000) * (cons / 100);
  return { liters, cost: liters * price };
}

function updateCostChip() {
  const chip = $("#route-cost-chip");
  const est = estimateFuel(state.routeSummary ? state.routeSummary.distance : 0, state.routeProfile);
  chip.classList.toggle("hidden", !est);
  if (!est) return;
  const premium = isPremiumActive();
  chip.classList.toggle("locked", !premium);
  $("#route-cost").innerHTML = premium
    ? `≈ ${Math.round(est.cost)} MT<small>${est.liters.toFixed(1)} L</small>`
    : `<i class="bi bi-lock-fill"></i> ${t("cost.lock")}`;
}

function saveFuelSetting(key, raw) {
  const v = parseFloat(String(raw).replace(",", "."));
  if (Number.isFinite(v) && v > 0) { state.settings[key] = v; saveSettings(); }
  updateCostChip();
}

// alerta de velocidade
function checkSpeedAlert() {
  const box = $("#nav-speed-box");
  const on = state.settings.speedAlert && isPremiumActive() && state.speed != null;
  if (!on) { state.speedOver = false; box.classList.remove("over"); return; }
  const kmh = state.speed * 3.6;
  const limit = state.settings.speedLimit || 80;
  const wasOver = state.speedOver;
  if (kmh > limit) state.speedOver = true;
  else if (kmh <= limit - 2) state.speedOver = false;   // margem para o valor não oscilar
  box.classList.toggle("over", state.speedOver);
  if (!state.speedOver) return;
  const now = Date.now();
  if (now - state.lastSpeedAlertAt < 12000) return;
  state.lastSpeedAlertAt = now;
  if (state.settings.sound !== false) {
    playTones([{ f: 880, t: 0, d: 0.16, type: "square", vol: 0.18 }, { f: 880, t: 0.22, d: 0.16, type: "square", vol: 0.18 }]);
  }
  vibrate([160, 80, 160]);
  if (!wasOver) speak(t("speed.warn"));
}

function syncPremiumSettingsUI() {
  $("#fuel-price-input").value = state.settings.fuelPrice;
  $("#cons-car-input").value = state.settings.consCar;
  $("#cons-moto-input").value = state.settings.consMoto;
  $("#speed-alert-switch").checked = !!state.settings.speedAlert;
  $("#speed-limit-input").value = state.settings.speedLimit;
  $("#datasaver-switch").checked = !!state.settings.dataSaver;
  $all("[data-speed]").forEach((b) => b.classList.toggle("active", Number(b.dataset.speed) === Number(state.settings.speedLimit)));
}

function wirePremiumExtras() {
  $("#add-stop-btn").addEventListener("click", toggleAddStop);
  $("#stop-confirm-btn").addEventListener("click", confirmStop);
  $("#stop-cancel-btn").addEventListener("click", cancelStop);
  $("#stop-sheet-close").addEventListener("click", cancelStop);
  $("#route-cost-chip").addEventListener("click", () => { if (!isPremiumActive()) openPaywall(t("cost.premium")); });
  $("#fuel-price-input").addEventListener("change", (e) => { saveFuelSetting("fuelPrice", e.target.value); syncPremiumSettingsUI(); });
  $("#cons-car-input").addEventListener("change", (e) => { saveFuelSetting("consCar", e.target.value); syncPremiumSettingsUI(); });
  $("#cons-moto-input").addEventListener("change", (e) => { saveFuelSetting("consMoto", e.target.value); syncPremiumSettingsUI(); });
  $("#speed-alert-switch").addEventListener("change", (e) => {
    if (e.target.checked && !isPremiumActive()) {
      e.target.checked = false;
      openPaywall(t("speed.premium"));
      return;
    }
    state.settings.speedAlert = e.target.checked;
    saveSettings();
  });
  $("#speed-limit-input").addEventListener("change", (e) => {
    const v = Math.round(parseFloat(e.target.value));
    if (Number.isFinite(v) && v >= 10 && v <= 200) { state.settings.speedLimit = v; saveSettings(); }
    syncPremiumSettingsUI();
  });
  $all("[data-speed]").forEach((b) => b.addEventListener("click", () => {
    state.settings.speedLimit = Number(b.dataset.speed);
    saveSettings();
    syncPremiumSettingsUI();
  }));
  syncPremiumSettingsUI();
}

/* -------------------------------------------------------------------------
   PREMIUM: NOTAS NOS LOCAIS
   ------------------------------------------------------------------------- */
function noteKey(p) { return `${Number(p.lat).toFixed(5)},${Number(p.lon).toFixed(5)}`; }
function getNote(p) {
  if (!p || p.lat == null || !isPremiumActive()) return "";
  const n = state.notes[noteKey(p)];
  return n ? n.text : "";
}
function persistNotes() { try { localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(state.notes)); } catch (e) {} }

function renderPlaceNote(place) {
  const txt = getNote(place);
  $("#place-note").classList.toggle("xh", !txt);
  $("#place-note-text").textContent = txt;
  $("#note-editor").classList.add("xh");
}

function openNoteEditor() {
  if (!requirePremium(t("note.premium"))) return;
  const place = state.selectedPlace;
  if (!place) return;
  $("#note-input").value = getNote(place);
  $("#note-editor").classList.remove("xh");
  $("#note-input").focus();
}

function saveNoteFromEditor() {
  const place = state.selectedPlace;
  if (!place) return;
  const text = $("#note-input").value.trim().slice(0, 200);
  const key = noteKey(place);
  if (text) { state.notes[key] = { text, name: place.name, at: Date.now() }; showToast(t("note.saved"), "success"); }
  else { delete state.notes[key]; showToast(t("note.removed")); }
  persistNotes();
  renderPlaceNote(place);
  if ($("#panel-favorites").classList.contains("open")) renderFavoritesPanel();
}

/* -------------------------------------------------------------------------
   PREMIUM: RESUMO MENSAL
   ------------------------------------------------------------------------- */
function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function shiftMonthKey(key, delta) {
  const [y, m] = key.split("-").map(Number);
  return monthKey(new Date(y, m - 1 + delta, 1).getTime());
}
function persistMonthly() { try { localStorage.setItem(STORAGE_KEYS.monthly, JSON.stringify(state.monthly)); } catch (e) {} }

function addTripToMonthly(trip) {
  const k = monthKey(trip.startedAt || Date.now());
  const m = state.monthly[k] || { trips: 0, completed: 0, km: 0, sec: 0, liters: 0, cost: 0 };
  m.trips += 1;
  if (trip.completed) m.completed += 1;
  m.km += (trip.distance || 0) / 1000;
  m.sec += Math.max(0, ((trip.endedAt || Date.now()) - (trip.startedAt || Date.now())) / 1000);
  const f = estimateFuel(trip.distance, trip.profile);
  if (f) { m.liters += f.liters; m.cost += f.cost; }
  state.monthly[k] = m;
  persistMonthly();
}

function seedMonthlyFromTrips() {
  state.monthly = {};
  state.trips.forEach((tr) => { if (tr && tr.startedAt) addTripToMonthly(tr); });
  persistMonthly();
}

function monthLabel(key, opts) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(state.settings.lang === "en" ? "en-GB" : "pt-PT", opts);
}

function shiftStatsMonth(d) {
  const cur = monthKey(Date.now());
  const next = shiftMonthKey(state.statsMonth || cur, d);
  if (next > cur) return;
  state.statsMonth = next;
  renderStatsPanel();
}
function selectStatsMonth(k) { state.statsMonth = k; renderStatsPanel(); }

function monthlyHtml() {
  const cur = monthKey(Date.now());
  const sel = state.statsMonth || cur;
  const m = state.monthly[sel] || { trips: 0, km: 0, sec: 0, cost: 0 };
  const prev = state.monthly[shiftMonthKey(sel, -1)];
  let delta = "";
  if (prev && prev.km > 0 && m.km > 0) {
    const pct = Math.round(((m.km - prev.km) / prev.km) * 100);
    if (pct !== 0) delta = t(pct > 0 ? "stats.mmore" : "stats.mless").replace("{p}", Math.abs(pct)).replace("{m}", monthLabel(shiftMonthKey(sel, -1), { month: "long" }));
  }
  const keys = [-5, -4, -3, -2, -1, 0].map((d) => shiftMonthKey(sel, d));
  const maxKm = Math.max(1, ...keys.map((k) => (state.monthly[k] ? state.monthly[k].km : 0)));
  const bars = keys.map((k) => {
    const km = state.monthly[k] ? state.monthly[k].km : 0;
    const h = km > 0 ? Math.max(6, Math.round((km / maxKm) * 64)) : 3;
    return `<button type="button" class="mbar ${k === sel ? "sel" : ""}" onclick="selectStatsMonth('${k}')" aria-label="${monthLabel(k, { month: "long", year: "numeric" })}"><i style="height:${h}px"></i><span>${monthLabel(k, { month: "short" })}</span></button>`;
  }).join("");
  return `
    <h3 class="month-title">${t("stats.monthly")}</h3>
    <div class="month-head">
      <button type="button" onclick="shiftStatsMonth(-1)" aria-label="‹"><i class="bi bi-chevron-left"></i></button>
      <b>${monthLabel(sel, { month: "long", year: "numeric" })}</b>
      <button type="button" onclick="shiftStatsMonth(1)" ${sel >= cur ? "disabled" : ""} aria-label="›"><i class="bi bi-chevron-right"></i></button>
    </div>
    <div class="stat-grid">
      <div><b>${m.trips}</b><span>${t("stats.mtrips")}</span></div>
      <div><b>${m.km.toFixed(1)}</b><span>${t("stats.mkm")}</span></div>
      <div><b>${m.sec > 0 ? formatDuration(m.sec) : "—"}</b><span>${t("stats.mtime")}</span></div>
      <div><b>${Math.round(m.cost)}</b><span>${t("stats.mcost")}</span></div>
    </div>
    ${m.trips === 0 ? `<p class="month-delta">${t("stats.mempty")}</p>` : delta ? `<p class="month-delta">${delta}</p>` : ""}
    <div class="month-bars">${bars}</div>`;
}

/* -------------------------------------------------------------------------
   PREMIUM: MODO POUPANÇA DE DADOS
   ------------------------------------------------------------------------- */
function isDataSaver() { return !!state.settings.dataSaver && isPremiumActive(); }

function applyDataSaver() {
  if (!state.map || !state.tileLayers.map) return;
  const on = isDataSaver();
  state.saverApplied = on;
  Object.values(state.tileLayers).forEach((l) => {
    const lean = on || state.tiltOn;
    l.options.keepBuffer = lean ? 0 : 1;               // sem mosaicos de margem
    l.options.updateWhenIdle = lean ? true : !!L.Browser.mobile;
    l.options.updateWhenZooming = !lean;
  });
  refreshBaseLayer();                                  // tira o satélite se estiver ativo
  const cur = state.tileLayers[state.currentTileType];
  if (cur) { cur.remove(); cur.addTo(state.map); }     // volta a ligar com as novas opções
  syncSettingsUI();
}

/* -------------------------------------------------------------------------
   PREMIUM: MAPAS OFFLINE
   ------------------------------------------------------------------------- */
const OFFLINE_CACHE = "navigo-offline-tiles-v1";   // o service worker usa o mesmo nome
const AVG_TILE_KB = 22;

function offlineConfigured() { return !!CONFIG.OFFLINE_TILE_URL; }

function lon2tile(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
function lat2tile(lat, z) {
  const r = (Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}
function tileRange(b, z) {
  const xa = lon2tile(b.w, z), xb = lon2tile(b.e, z), ya = lat2tile(b.n, z), yb = lat2tile(b.s, z);
  return { x1: Math.min(xa, xb), x2: Math.max(xa, xb), y1: Math.min(ya, yb), y2: Math.max(ya, yb) };
}
function countTiles(b, zmin, zmax) {
  let n = 0;
  for (let z = zmin; z <= zmax; z++) { const r = tileRange(b, z); n += (r.x2 - r.x1 + 1) * (r.y2 - r.y1 + 1); }
  return n;
}
function offlineTileUrl(z, x, y) {
  return CONFIG.OFFLINE_TILE_URL.replace("{z}", z).replace("{x}", x).replace("{y}", y).replace("{r}", "");
}
function listTileUrls(b, zmin, zmax) {
  const out = [];
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(b, z);
    for (let x = r.x1; x <= r.x2; x++) for (let y = r.y1; y <= r.y2; y++) out.push(offlineTileUrl(z, x, y));
  }
  return out;
}
function viewBounds() {
  const bb = state.map.getBounds();
  return { s: Math.max(-85, bb.getSouth()), w: bb.getWest(), n: Math.min(85, bb.getNorth()), e: bb.getEast() };
}
function persistOfflineAreas() { try { localStorage.setItem(STORAGE_KEYS.offlineAreas, JSON.stringify(state.offline.areas)); } catch (e) {} }

function offlineEstimate() {
  const b = viewBounds();
  const n = countTiles(b, CONFIG.OFFLINE_MIN_ZOOM, state.offline.zmax);
  return { b, n, mb: (n * AVG_TILE_KB) / 1024 };
}

function renderOfflinePanel() {
  if (!offlineConfigured()) return;
  if (!$("#offline-name").value) $("#offline-name").value = (state.userProfile && state.userProfile.city) || t("offline.defaultname");
  $all("[data-zmax]").forEach((b) => b.classList.toggle("active", Number(b.dataset.zmax) === state.offline.zmax));
  const est = offlineEstimate();
  const tooBig = est.n > CONFIG.OFFLINE_MAX_TILES;
  const el = $("#offline-estimate");
  el.classList.toggle("bad", tooBig);
  el.textContent = tooBig
    ? `${est.n} ${t("offline.tiles")} · ${t("offline.toobig")}`
    : `${est.n} ${t("offline.tiles")} · ≈ ${est.mb.toFixed(est.mb < 10 ? 1 : 0)} MB. ${t("offline.datawarn").replace("{mb}", est.mb.toFixed(est.mb < 10 ? 1 : 0))}`;
  $("#offline-download-btn").disabled = tooBig || state.offline.downloading;
  const list = $("#offline-list");
  if (!state.offline.areas.length) list.innerHTML = `<li class="empty-state"><i class="bi bi-cloud-arrow-down"></i> ${t("offline.none")}</li>`;
  else {
    list.innerHTML = state.offline.areas.map((a) => `
      <li class="offline-row">
        <div class="offline-info"><b>${escapeHtml(a.name)}</b><small>${a.count} ${t("offline.tiles")} · z${a.zmin}–z${a.zmax} · ≈ ${((a.count * AVG_TILE_KB) / 1024).toFixed(1)} MB</small></div>
        <button type="button" class="icon-btn-small" onclick="viewOfflineArea('${a.id}')" aria-label="Ver"><i class="bi bi-geo-alt-fill"></i></button>
        <button type="button" class="icon-btn-small" onclick="deleteOfflineArea('${a.id}')" aria-label="Apagar"><i class="bi bi-trash"></i></button>
      </li>`).join("");
  }
  const usedEl = $("#offline-storage");
  usedEl.textContent = "";
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => { if (e && e.usage != null) usedEl.textContent = `${t("offline.used")} ${(e.usage / 1048576).toFixed(1)} MB`; }).catch(() => {});
  }
}

function setOfflineUiBusy(busy) {
  $("#offline-progress").classList.toggle("xh", !busy);
  $("#offline-cancel-btn").classList.toggle("xh", !busy);
  $("#offline-download-btn").classList.toggle("xh", busy);
}

function updateOfflineProgress(done, total) {
  $("#offline-progress-bar").style.width = `${Math.round((done / total) * 100)}%`;
  $("#offline-progress-text").textContent = t("offline.progress").replace("{a}", done).replace("{n}", total);
}

async function startOfflineDownload() {
  if (!requirePremium(t("offline.premium"))) return;
  if (!offlineConfigured() || state.offline.downloading) return;
  if (!navigator.onLine) { showToast(t("offline.needonline"), "error"); return; }
  if (!("caches" in window)) { showToast(t("offline.unsupported"), "error"); return; }
  const zmin = CONFIG.OFFLINE_MIN_ZOOM, zmax = state.offline.zmax;
  const b = viewBounds();
  const urls = listTileUrls(b, zmin, zmax);
  if (urls.length > CONFIG.OFFLINE_MAX_TILES) { showToast(t("offline.toobig"), "error"); return; }
  const name = ($("#offline-name").value || "").trim().slice(0, 40) || t("offline.defaultname");
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  state.offline.downloading = true;
  state.offline.cancel = false;
  state.offline.aborted = false;
  setOfflineUiBusy(true);
  updateOfflineProgress(0, urls.length);

  const added = [];
  let done = 0, failed = 0, next = 0;
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    const worker = async () => {
      while (!state.offline.cancel) {
        const i = next++;
        if (i >= urls.length) break;
        const u = urls[i];
        try {
          if (!(await cache.match(u))) {
            const r = await fetch(u, { mode: "cors" });
            if (!r.ok) throw new Error("http");
            await cache.put(u, r);
            added.push(u);
          }
        } catch (e) { failed++; }
        done++;
        updateOfflineProgress(done, urls.length);
        // muitos erros seguidos: sem espaço ou sem rede — pára
        if (failed >= 15 && failed / done > 0.3) { state.offline.aborted = true; state.offline.cancel = true; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    if (state.offline.cancel || failed > urls.length * 0.05) {
      await Promise.all(added.map((u) => cache.delete(u)));   // não deixa mosaicos soltos
      showToast(state.offline.aborted || !state.offline.cancel ? t("offline.failed") : t("offline.cancelled"), state.offline.cancel && !state.offline.aborted ? "info" : "error");
    } else {
      state.offline.areas.push({ id: `${Date.now()}`, name, bounds: b, zmin, zmax, count: urls.length, createdAt: Date.now() });
      persistOfflineAreas();
      showToast(t("offline.done"), "success");
    }
  } catch (e) {
    showToast(t("offline.failed"), "error");
  } finally {
    state.offline.downloading = false;
    setOfflineUiBusy(false);
    renderOfflinePanel();
  }
}

async function deleteOfflineArea(id) {
  const area = state.offline.areas.find((a) => a.id === id);
  if (!area) return;
  const others = new Set();
  state.offline.areas.filter((a) => a.id !== id).forEach((a) => listTileUrls(a.bounds, a.zmin, a.zmax).forEach((u) => others.add(u)));
  try {
    const cache = await caches.open(OFFLINE_CACHE);
    await Promise.all(listTileUrls(area.bounds, area.zmin, area.zmax).filter((u) => !others.has(u)).map((u) => cache.delete(u)));
  } catch (e) { /* ignora */ }
  state.offline.areas = state.offline.areas.filter((a) => a.id !== id);
  persistOfflineAreas();
  renderOfflinePanel();
}

function viewOfflineArea(id) {
  const a = state.offline.areas.find((x) => x.id === id);
  if (!a) return;
  closeAllPanels();
  state.follow = false;
  state.map.fitBounds([[a.bounds.s, a.bounds.w], [a.bounds.n, a.bounds.e]], { padding: [20, 20] });
}

function wireExtras2() {
  $("#note-btn").addEventListener("click", openNoteEditor);
  $("#place-note").addEventListener("click", openNoteEditor);
  $("#note-save-btn").addEventListener("click", saveNoteFromEditor);
  $("#note-cancel-btn").addEventListener("click", () => $("#note-editor").classList.add("xh"));
  $("#datasaver-switch").addEventListener("change", (e) => {
    if (e.target.checked && !isPremiumActive()) { e.target.checked = false; openPaywall(t("saver.premium")); return; }
    state.settings.dataSaver = e.target.checked;
    saveSettings();
    applyDataSaver();
  });
  $all("[data-zmax]").forEach((b) => b.addEventListener("click", () => { state.offline.zmax = Number(b.dataset.zmax); renderOfflinePanel(); }));
  $("#offline-download-btn").addEventListener("click", startOfflineDownload);
  $("#offline-cancel-btn").addEventListener("click", () => { state.offline.cancel = true; });
  applyDataSaver();
}

document.addEventListener("DOMContentLoaded", init);
