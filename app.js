/**
 * Brewery Finder — The Taproom Atlas
 * Uses Open Brewery DB (openbrewerydb.org) — free, no API key needed
 * Maps via Leaflet + CartoDB Dark Matter tiles
 * Geocoding via Nominatim (OpenStreetMap)
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────

const BREWERY_API   = 'https://api.openbrewerydb.org/v1/breweries';
const NOMINATIM_API = 'https://nominatim.openstreetmap.org';
const TILE_URL      = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR     = '&copy; <a href="https://carto.com">CARTO</a>';

const TYPE_LABELS = {
  micro:       'Microbrewery',
  nano:        'Nanobrewery',
  regional:    'Regional',
  brewpub:     'Brewpub',
  large:       'Large Brewery',
  planning:    'Coming Soon',
  bar:         'Beer Bar',
  contract:    'Contract Brewery',
  proprietor:  'Proprietor',
  taproom:     'Taproom',
  closed:      'Closed',
};

// ─── State ──────────────────────────────────────────────────────────────────

let currentLat = null;
let currentLng = null;
let mapInstances = {};   // id → Leaflet map
let mapObserver = null;  // IntersectionObserver for lazy map init

// ─── DOM References ─────────────────────────────────────────────────────────

const searchForm      = document.getElementById('search-form');
const locationInput   = document.getElementById('location-input');
const radiusSelect    = document.getElementById('radius-select');
const useLocationBtn  = document.getElementById('use-location-btn');
const searchBtn       = document.getElementById('search-btn');
const breweryGrid     = document.getElementById('brewery-grid');
const statusBar       = document.getElementById('status-bar');
const statusText      = document.getElementById('status-text');
const loadingState    = document.getElementById('loading-state');
const errorState      = document.getElementById('error-state');
const errorMessage    = document.getElementById('error-message');
const emptyState      = document.getElementById('empty-state');
const welcomeState    = document.getElementById('welcome-state');
const retryBtn        = document.getElementById('retry-btn');

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Haversine distance between two lat/lng points, in miles.
 */
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function formatDistance(miles) {
  if (miles < 0.1) return '< 0.1 mi';
  return miles.toFixed(1) + ' mi';
}

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)
    return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1')
    return `+1 (${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`;
  return raw;
}

function getInitials(name) {
  return name
    .split(/\s+/)
    .filter(w => /[A-Za-z]/.test(w))
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

function getFaviconUrl(websiteUrl) {
  try {
    const domain = new URL(websiteUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  } catch {
    return null;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showState(which) {
  // Hide all states, then show the requested one
  for (const el of [loadingState, errorState, emptyState, welcomeState]) {
    el.hidden = el !== which;
  }
  // Never hide the grid — it may coexist with status bar
  if (which !== null) breweryGrid.innerHTML = '';
}

function setStatus(text) {
  statusText.textContent = text;
  statusBar.hidden = !text;
}

// ─── Geolocation ────────────────────────────────────────────────────────────

function getUserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by your browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(new Error(err.message || 'Unable to get location.')),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

async function reverseGeocode(lat, lng) {
  const url = `${NOMINATIM_API}/reverse?lat=${lat}&lon=${lng}&format=json`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'BreweryFinder/1.0' }
  });
  if (!res.ok) throw new Error('Reverse geocoding failed.');
  const data = await res.json();
  const addr = data.address || {};
  const city  = addr.city || addr.town || addr.village || addr.hamlet || '';
  const state = addr.state || '';
  return city && state ? `${city}, ${state}` : data.display_name || `${lat}, ${lng}`;
}

async function geocodeAddress(query) {
  const url = `${NOMINATIM_API}/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
  const res = await fetch(url, {
    headers: { 'Accept-Language': 'en', 'User-Agent': 'BreweryFinder/1.0' }
  });
  if (!res.ok) throw new Error('Geocoding failed.');
  const results = await res.json();
  if (!results.length) throw new Error(`No location found for "${query}".`);
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchBreweries(lat, lng) {
  // Fetch up to 200 breweries sorted by proximity; we filter by radius client-side
  const url = `${BREWERY_API}?by_dist=${lat},${lng}&per_page=200`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Brewery API error: ${res.status}`);
  return res.json();
}

function filterByRadius(breweries, lat, lng, radiusMiles) {
  return breweries
    .filter(b => b.latitude && b.longitude && b.brewery_type !== 'closed')
    .map(b => ({
      ...b,
      _distance: haversineDistance(lat, lng, parseFloat(b.latitude), parseFloat(b.longitude))
    }))
    .filter(b => b._distance <= radiusMiles)
    .sort((a, b) => a._distance - b._distance);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function buildAddressLines(b) {
  const parts = [];
  if (b.address_1)  parts.push(escapeHtml(b.address_1));
  const cityLine = [b.city, b.state_province || b.state].filter(Boolean).map(escapeHtml).join(', ');
  if (cityLine) parts.push(cityLine + (b.postal_code ? ` ${escapeHtml(b.postal_code)}` : ''));
  return parts.join('<br>');
}

function buildLogoHTML(brewery) {
  const initials = escapeHtml(getInitials(brewery.name));
  if (brewery.website_url) {
    const favUrl = escapeHtml(getFaviconUrl(brewery.website_url));
    return `
      <img
        class="brewery-logo"
        src="${favUrl}"
        alt="${escapeHtml(brewery.name)} logo"
        onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"
        loading="lazy"
      >
      <div class="brewery-logo-fallback" style="display:none;">${initials}</div>
    `;
  }
  return `<div class="brewery-logo-fallback">${initials}</div>`;
}

function buildSectionHTML(title, icon, content) {
  return `
    <div class="card-section">
      <div class="section-title">
        <span class="section-title-icon">${icon}</span>
        ${escapeHtml(title)}
      </div>
      ${content}
    </div>
  `;
}

function buildUnavailableHTML(label, website, name) {
  if (website) {
    const safeUrl = encodeURI(website);
    const safeName = escapeHtml(name);
    return `<p class="section-unavailable">Visit <a href="${safeUrl}" target="_blank" rel="noopener">${safeName}'s website</a> for current ${label}.</p>`;
  }
  return `<p class="section-unavailable">Not available — check the brewery directly.</p>`;
}

function renderBreweryCard(brewery, index) {
  const type       = brewery.brewery_type || 'micro';
  const typeLabel  = TYPE_LABELS[type] || type;
  const distance   = formatDistance(brewery._distance);
  const phone      = formatPhone(brewery.phone);
  const website    = brewery.website_url;
  const address    = buildAddressLines(brewery);
  const mapId      = `map-${brewery.id.replace(/[^a-zA-Z0-9]/g, '-')}`;
  const hasCoords  = brewery.latitude && brewery.longitude;
  const isFood     = ['brewpub', 'bar'].includes(type);
  const name       = brewery.name;

  // ── Contact block ──
  let contactHTML = '';
  if (address) {
    contactHTML += `
      <div class="contact-item">
        <span class="contact-icon">◎</span>
        <span class="contact-text">${address}</span>
      </div>`;
  }
  if (phone) {
    contactHTML += `
      <div class="contact-item">
        <span class="contact-icon">◉</span>
        <span class="contact-text"><a href="tel:${phone.replace(/[^+\d]/g,'')}}">${escapeHtml(phone)}</a></span>
      </div>`;
  }
  if (website) {
    const safeUrl = encodeURI(website);
    const displayUrl = escapeHtml(website.replace(/^https?:\/\//, '').replace(/\/$/, ''));
    contactHTML += `
      <div class="contact-item">
        <span class="contact-icon">◈</span>
        <span class="contact-text"><a href="${safeUrl}" target="_blank" rel="noopener">${displayUrl}</a></span>
      </div>`;
  }

  // ── Extended sections ──
  const hoursHTML      = buildUnavailableHTML('hours', website, name);
  const taplistHTML    = buildUnavailableHTML('tap list', website, name);
  const eventsHTML     = buildUnavailableHTML('events', website, name);
  const specialsHTML   = buildUnavailableHTML('specials & deals', website, name);
  const foodtruckHTML  = buildUnavailableHTML('food truck schedule', website, name);
  const foodMenuHTML   = isFood ? buildUnavailableHTML('food menu', website, name) : null;

  const sectionsInner = [
    buildSectionHTML('Hours',    '🕐', hoursHTML),
    buildSectionHTML('Tap List', '🍺', taplistHTML),
    buildSectionHTML('Events',   '📅', eventsHTML),
    buildSectionHTML('Specials', '★',  specialsHTML),
    foodMenuHTML ? buildSectionHTML('Food Menu', '🍔', foodMenuHTML) : '',
    buildSectionHTML('Food Truck', '🚚', foodtruckHTML),
  ].join('');

  // ── Map ──
  const mapHTML = hasCoords
    ? `<div class="mini-map" id="${mapId}" data-lat="${brewery.latitude}" data-lng="${brewery.longitude}" data-name="${escapeHtml(name)}">
         <div class="map-placeholder">
           <span class="map-placeholder-icon">◎</span>
           <span class="map-placeholder-text">Loading map…</span>
         </div>
       </div>`
    : `<div class="mini-map">
         <div class="map-placeholder">
           <span class="map-placeholder-icon">◎</span>
           <span class="map-placeholder-text">No coordinates</span>
         </div>
       </div>`;

  return `
    <article class="brewery-card" id="card-${escapeHtml(brewery.id)}" aria-label="${escapeHtml(name)}">
      <div class="card-body">

        <div class="card-logo-col">
          <div class="brewery-logo-wrap">${buildLogoHTML(brewery)}</div>
          <div class="distance-badge" title="Distance from your search location">${escapeHtml(distance)}</div>
        </div>

        <div class="card-info-col">
          <div class="card-top">
            <span class="brewery-type-badge type-${escapeHtml(type)}">${escapeHtml(typeLabel)}</span>
          </div>
          <h2 class="brewery-name">${escapeHtml(name)}</h2>
          <div class="card-contact">${contactHTML}</div>
        </div>

        <div class="card-map-col">
          ${mapHTML}
        </div>

      </div>

      <div class="card-sections">
        ${sectionsInner}
      </div>
    </article>
  `;
}

function renderBreweries(breweries) {
  // Destroy previous maps
  for (const [id, map] of Object.entries(mapInstances)) {
    map.remove();
  }
  mapInstances = {};
  if (mapObserver) mapObserver.disconnect();

  breweryGrid.innerHTML = breweries.map((b, i) => renderBreweryCard(b, i)).join('');

  // Set up IntersectionObserver for lazy Leaflet map init
  mapObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        initMiniMap(entry.target);
        mapObserver.unobserve(entry.target);
      }
    }
  }, { rootMargin: '200px 0px' });

  document.querySelectorAll('.mini-map[data-lat]').forEach(el => {
    mapObserver.observe(el);
  });
}

function initMiniMap(container) {
  const lat  = parseFloat(container.dataset.lat);
  const lng  = parseFloat(container.dataset.lng);
  const name = container.dataset.name || '';

  if (!lat || !lng || mapInstances[container.id]) return;

  // Remove placeholder
  const placeholder = container.querySelector('.map-placeholder');
  if (placeholder) placeholder.remove();

  const map = L.map(container, {
    center: [lat, lng],
    zoom: 15,
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: false,
    dragging: false,
    doubleClickZoom: false,
  });

  L.tileLayer(TILE_URL, {
    attribution: TILE_ATTR,
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);

  // Custom copper-colored marker
  const markerIcon = L.divIcon({
    className: '',
    html: `<div style="
      width: 14px;
      height: 14px;
      background: #b87333;
      border: 2px solid #ece2c8;
      border-radius: 50%;
      box-shadow: 0 0 8px rgba(184,115,51,0.7);
    "></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

  L.marker([lat, lng], { icon: markerIcon })
    .addTo(map)
    .bindTooltip(name, { permanent: false, className: 'brewery-tooltip', offset: [10, 0] });

  mapInstances[container.id] = map;
}

// ─── Search Flow ─────────────────────────────────────────────────────────────

async function doSearch() {
  const locationQuery = locationInput.value.trim();
  const radiusMiles   = parseInt(radiusSelect.value, 10);

  if (!locationQuery) {
    locationInput.focus();
    return;
  }

  // If location input doesn't match our stored coords, re-geocode
  let lat = currentLat;
  let lng = currentLng;

  searchBtn.disabled = true;
  searchBtn.querySelector('.btn-text').textContent = 'Searching…';
  showState(loadingState);
  setStatus('');

  try {
    // Re-geocode if user typed a custom location
    if (!lat || !lng) {
      const coords = await geocodeAddress(locationQuery);
      lat = coords.lat;
      lng = coords.lng;
      currentLat = lat;
      currentLng = lng;
    } else {
      // If location input changed from what we stored, re-geocode
      // (simple heuristic: if it doesn't look like "lat, lng")
    }

    const allBreweries = await fetchBreweries(lat, lng);
    const filtered = filterByRadius(allBreweries, lat, lng, radiusMiles);

    loadingState.hidden = true;

    if (!filtered.length) {
      showState(emptyState);
      setStatus('');
      return;
    }

    showState(null); // hide all state panels
    renderBreweries(filtered);

    const count    = filtered.length;
    const nearest  = filtered[0];
    const farthest = filtered[filtered.length - 1];
    setStatus(
      `${count} ${count === 1 ? 'brewery' : 'breweries'} within ${radiusMiles} miles of ${locationQuery}` +
      (count > 1 ? ` · Nearest: ${formatDistance(nearest._distance)} · Farthest: ${formatDistance(farthest._distance)}` : '')
    );

  } catch (err) {
    loadingState.hidden = true;
    errorMessage.textContent = err.message || 'Something went wrong. Please try again.';
    showState(errorState);
    setStatus('');
    console.error('[BreweryFinder]', err);
  } finally {
    searchBtn.disabled = false;
    searchBtn.querySelector('.btn-text').textContent = 'Search Breweries';
  }
}

// ─── Location Detection ───────────────────────────────────────────────────────

async function detectLocation() {
  useLocationBtn.classList.add('locating');
  locationInput.placeholder = 'Detecting your location…';
  locationInput.value = '';
  currentLat = null;
  currentLng = null;

  try {
    const { lat, lng } = await getUserLocation();
    currentLat = lat;
    currentLng = lng;
    const locationName = await reverseGeocode(lat, lng);
    locationInput.value = locationName;
    locationInput.placeholder = '';
    // Auto-trigger search
    await doSearch();
  } catch (err) {
    locationInput.placeholder = 'Enter a city or address…';
    locationInput.value = '';
    // Don't show error state — just let user type manually
    console.warn('[BreweryFinder] Location detection:', err.message);
  } finally {
    useLocationBtn.classList.remove('locating');
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const locationQuery = locationInput.value.trim();
  if (!locationQuery) return;

  // If user typed something different than the detected location, re-geocode
  if (!currentLat || !currentLng) {
    try {
      const coords = await geocodeAddress(locationQuery);
      currentLat = coords.lat;
      currentLng = coords.lng;
    } catch (err) {
      errorMessage.textContent = err.message;
      showState(errorState);
      return;
    }
  }

  await doSearch();
});

locationInput.addEventListener('input', () => {
  // User is typing a new location — clear stored coords so it re-geocodes
  currentLat = null;
  currentLng = null;
});

useLocationBtn.addEventListener('click', detectLocation);

retryBtn.addEventListener('click', doSearch);

// ─── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  showState(welcomeState);
  // Auto-detect location on page load
  await detectLocation();
})();
