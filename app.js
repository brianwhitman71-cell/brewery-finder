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
let mapInstances = {};      // id → Leaflet map
let mapObserver = null;     // IntersectionObserver for lazy map init
let currentBreweries = [];  // filtered + sorted list currently displayed
let currentSort = 'distance';
let scrapedDataCache = {};  // breweryId → scrape results (for sort-by-open)
let visibleCount = 0;       // tracks how many cards are still shown after closure removal

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
const sortBtns        = document.querySelectorAll('.sort-btn');

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

function buildSectionHTML(title, icon, key, breweryId) {
  const safeId = CSS.escape(`section-${key}-${breweryId}`);
  return `
    <div class="card-section" id="section-${key}-${escapeHtml(breweryId)}" data-section="${key}">
      <div class="section-title">
        <span class="section-title-icon">${icon}</span>
        ${escapeHtml(title)}
      </div>
      <div class="section-content section-fetching">
        <span class="fetch-dot"></span><span class="fetch-dot"></span><span class="fetch-dot"></span>
      </div>
    </div>
  `;
}

function setSectionContent(breweryId, key, html) {
  const el = document.getElementById(`section-${key}-${breweryId}`);
  if (!el) return;
  const content = el.querySelector('.section-content');
  if (!content) return;
  content.classList.remove('section-fetching');
  content.innerHTML = html;
}

function renderHours(data) {
  if (!data) return noDataHTML();
  if (data.lines && data.lines.length) {
    const rows = data.lines.map(l =>
      `<div class="hours-row">${escapeHtml(l)}</div>`
    ).join('');
    return `<div class="hours-list">${rows}</div>`;
  }
  if (data.raw) {
    return `<p class="section-text">${escapeHtml(truncateDisplay(data.raw, 280))}</p>`;
  }
  return noDataHTML();
}

function renderTapList(data, website, name) {
  if (!data) return noDataHTML(website, name, 'tap list');

  if (data.type === 'untappd-widget') {
    return `
      <div class="taplist-integration untappd">
        <a class="integration-link" href="https://untappd.com/venue/${data.id}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View tap list on Untappd</span>
        </a>
        <span class="integration-badge">via Untappd</span>
      </div>
      <div class="untappd-embed-wrap" data-lid="${escapeHtml(data.id)}">
        <button class="load-widget-btn" onclick="loadUntappdWidget(this, '${escapeHtml(data.id)}')">
          Load live tap list ↓
        </button>
      </div>`;
  }
  if (data.type === 'untappd-venue') {
    return `
      <div class="taplist-integration untappd">
        <a class="integration-link" href="https://untappd.com/venue/${data.id}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View tap list on Untappd</span>
        </a>
        <span class="integration-badge">via Untappd</span>
      </div>`;
  }
  if (data.type === 'untappd-brewery') {
    return `
      <div class="taplist-integration untappd">
        <a class="integration-link" href="https://untappd.com/brewery/${data.id}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View beers on Untappd</span>
        </a>
        <span class="integration-badge">via Untappd</span>
      </div>`;
  }
  if (data.type === 'beermenus') {
    return `
      <div class="taplist-integration beermenus">
        <a class="integration-link" href="https://www.beermenus.com/places/${data.slug}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View tap list on BeerMenus</span>
        </a>
        <span class="integration-badge">via BeerMenus</span>
      </div>`;
  }
  if (data.type === 'taplist-io') {
    return `
      <div class="taplist-integration taplist-io">
        <a class="integration-link" href="https://taplist.io/board/${data.slug}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View live tap list</span>
        </a>
        <span class="integration-badge">via Taplist.io</span>
      </div>`;
  }
  if (data.type === 'digitalpour') {
    return `
      <div class="taplist-integration digitalpour">
        <a class="integration-link" href="https://www.digitalpour.com/menu/${data.id}" target="_blank" rel="noopener">
          <span class="integration-icon">🍺</span>
          <span>View tap list on DigitalPour</span>
        </a>
        <span class="integration-badge">via DigitalPour</span>
      </div>`;
  }
  if (data.type === 'parsed-list' && data.items && data.items.length) {
    const items = data.items.map(i =>
      `<li class="beer-item">${escapeHtml(i)}</li>`
    ).join('');
    return `<ul class="beer-list">${items}</ul>`;
  }
  return noDataHTML(website, name, 'tap list');
}

function renderEvents(data, website, name) {
  if (!data) return noDataHTML(website, name, 'upcoming events');

  if (data.type === 'schema' && data.events && data.events.length) {
    const items = data.events.map(e => `
      <div class="event-item">
        ${e.name ? `<div class="event-name">${escapeHtml(e.name)}</div>` : ''}
        ${e.date ? `<div class="event-date">${escapeHtml(e.date)}</div>` : ''}
        ${e.desc ? `<div class="event-desc">${escapeHtml(e.desc)}</div>` : ''}
      </div>`).join('');
    return `<div class="events-list">${items}</div>`;
  }
  if (data.type === 'eventbrite') {
    return `
      <div class="taplist-integration">
        <a class="integration-link" href="${encodeURI(data.url || 'https://eventbrite.com')}" target="_blank" rel="noopener">
          <span class="integration-icon">📅</span>
          <span>View events on Eventbrite</span>
        </a>
        <span class="integration-badge">via Eventbrite</span>
      </div>`;
  }
  if (data.type === 'facebook') {
    return `
      <div class="taplist-integration">
        <a class="integration-link" href="https://www.facebook.com/${escapeHtml(data.page || '')}/events" target="_blank" rel="noopener">
          <span class="integration-icon">📅</span>
          <span>View events on Facebook</span>
        </a>
        <span class="integration-badge">via Facebook</span>
      </div>`;
  }
  if ((data.type === 'dom' || data.type === 'text') && data.items && data.items.length) {
    const items = data.items.map(i => `<div class="event-item"><div class="event-desc">${escapeHtml(i)}</div></div>`).join('');
    return `<div class="events-list">${items}</div>`;
  }
  return noDataHTML(website, name, 'upcoming events');
}

function renderSpecials(data, website, name) {
  if (!data) return noDataHTML(website, name, 'specials');

  if (data.type === 'dom' && data.items && data.items.length) {
    const items = data.items.map(i => `<div class="special-item">${escapeHtml(i)}</div>`).join('');
    return `<div class="specials-list">${items}</div>`;
  }
  if (data.raw) {
    return `<p class="section-text">${escapeHtml(truncateDisplay(data.raw, 280))}</p>`;
  }
  return noDataHTML(website, name, 'specials');
}

function renderFoodMenu(data, website, name) {
  if (!data) return noDataHTML(website, name, 'food menu');

  if (data.type === 'toast') {
    return `
      <div class="taplist-integration">
        <a class="integration-link" href="${encodeURI(data.url)}" target="_blank" rel="noopener">
          <span class="integration-icon">🍔</span>
          <span>View menu &amp; order online</span>
        </a>
        <span class="integration-badge">via Toast</span>
      </div>`;
  }
  if (data.href || data.url) {
    const href = encodeURI(data.href || data.url);
    const label = escapeHtml(data.label || 'View Food Menu');
    return `
      <div class="taplist-integration">
        <a class="integration-link" href="${href}" target="_blank" rel="noopener">
          <span class="integration-icon">🍔</span>
          <span>${label}</span>
        </a>
        ${data.href && /\.pdf/i.test(data.href) ? '<span class="integration-badge">PDF</span>' : ''}
      </div>`;
  }
  return noDataHTML(website, name, 'food menu');
}

function renderFoodTruck(data, website, name) {
  if (!data) return noDataHTML(website, name, 'food truck schedule');

  if (data.type === 'text' && data.items && data.items.length) {
    const items = data.items.map(i => `<div class="foodtruck-item">${escapeHtml(i)}</div>`).join('');
    return `<div class="foodtruck-list">${items}</div>`;
  }
  if (data.type === 'dom' && data.text) {
    return `<p class="section-text">${escapeHtml(truncateDisplay(data.text, 280))}</p>`;
  }
  if (data.type === 'mentioned') {
    return `<p class="section-text found-mention">Food trucks are mentioned on this brewery's website.
      ${website ? `<a href="${encodeURI(website)}" target="_blank" rel="noopener">Check for current schedule →</a>` : ''}</p>`;
  }
  return noDataHTML(website, name, 'food truck info');
}

function noDataHTML(website, name, label) {
  if (website && name && label) {
    return `<p class="section-unavailable">Visit <a href="${encodeURI(website)}" target="_blank" rel="noopener">${escapeHtml(name)}'s website</a> for ${label}.</p>`;
  }
  return `<p class="section-unavailable">Not found on website.</p>`;
}

function truncateDisplay(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max).replace(/\s+\S*$/, '') + '…' : str;
}

function buildOwnershipHTML(brewery) {
  const ownership = lookupOwnership(brewery.name, brewery.city);

  if (!ownership) {
    // Not in corporate database — independently owned
    return `
      <div class="ownership-badge ownership-independent" title="Not owned by any major beverage corporation">
        <span class="ownership-icon">◆</span>
        <span class="ownership-label">Independent</span>
      </div>`;
  }

  if (ownership.ownerType === 'employee-owned') {
    const tip = escapeHtml(ownership.note || 'Employee-owned brewery');
    return `
      <div class="ownership-badge ownership-employee" title="${tip}">
        <span class="ownership-icon">◆</span>
        <span class="ownership-label">Employee-Owned</span>
        ${ownership.since ? `<span class="ownership-since">since ${ownership.since}</span>` : ''}
      </div>`;
  }

  if (ownership.ownerType === 'family') {
    const tip = escapeHtml(ownership.note || 'Family-owned brewery');
    return `
      <div class="ownership-badge ownership-family" title="${tip}">
        <span class="ownership-icon">◆</span>
        <span class="ownership-label">Family-Owned</span>
      </div>`;
  }

  if (ownership.ownerType === 'publicly-traded') {
    const tip = escapeHtml(ownership.note || '');
    return `
      <div class="ownership-badge ownership-public" title="${tip}">
        <span class="ownership-icon">◆</span>
        <span class="ownership-label">Publicly Traded</span>
        <span class="ownership-corp">${escapeHtml(ownership.owner)}</span>
      </div>`;
  }

  // Corporate / Big Beer / International conglomerate
  const labelMap = {
    bigbeer:              'Owned by Big Beer',
    'beverage-conglomerate': 'Corporate Owned',
    international:        'Foreign Corporate Owned',
  };
  const label = labelMap[ownership.ownerType] || 'Corporate Owned';
  const tip   = escapeHtml(ownership.note || `Acquired by ${ownership.owner} in ${ownership.since}`);
  return `
    <div class="ownership-badge ownership-corporate" title="${tip}">
      <span class="ownership-icon">◆</span>
      <span class="ownership-label">${label}</span>
      <span class="ownership-corp">${escapeHtml(ownership.owner)}</span>
      ${ownership.since ? `<span class="ownership-since">acq. ${ownership.since}</span>` : ''}
    </div>`;
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
  const ownershipHTML = buildOwnershipHTML(brewery);

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

  // ── Extended sections (all start in "fetching" state, filled by scraper) ──
  const bid = escapeHtml(brewery.id);
  const sectionsInner = [
    buildSectionHTML('Hours',      '🕐', 'hours',     bid),
    buildSectionHTML('Tap List',   '🍺', 'taplist',   bid),
    buildSectionHTML('Events',     '📅', 'events',    bid),
    buildSectionHTML('Specials',   '★',  'specials',  bid),
    isFood ? buildSectionHTML('Food Menu', '🍔', 'food', bid) : '',
    buildSectionHTML('Food Truck', '🚚', 'foodtruck', bid),
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
            ${ownershipHTML}
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

// ─── Sort ─────────────────────────────────────────────────────────────────────

const SCHEMA_DAY = { Mo:1, Tu:2, We:3, Th:4, Fr:5, Sa:6, Su:0 };

/**
 * Try to determine if a brewery is open right now from scraped hours data.
 * Returns true (open), false (closed right now), or null (unknown).
 */
function isOpenNow(breweryId) {
  const data = scrapedDataCache[breweryId];
  if (!data?.hours) return null;
  const { src, lines } = data.hours;
  if (src !== 'schema' || !lines?.length) return null;

  const now     = new Date();
  const today   = now.getDay();     // 0=Sun…6=Sat
  const minutes = now.getHours() * 60 + now.getMinutes();

  for (const line of lines) {
    // "Mon–Fri: 11:00 AM – 10:00 PM" — our formatted output
    // Re-parse the raw schema line from scraper which is stored as formatted text.
    // Scraper stores raw schema as "Mo-Fr 11:00-22:00" before formatting.
    // We stored formatted, so parse that:
    const m = line.match(/^(\w{3})(?:–(\w{3}))?:\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*–\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i);
    if (!m) continue;
    const [, d1str, d2str, h1, m1='0', p1, h2, m2='0', p2] = m;

    const dayAbbr = { Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6,Sun:0 };
    const d1 = dayAbbr[d1str];
    const d2 = d2str ? dayAbbr[d2str] : d1;
    if (d1 === undefined) continue;

    // Build day range (handle wrap like Fri–Sun: 5,6,0)
    const daysInRange = [];
    if (d1 <= d2) {
      for (let d = d1; d <= d2; d++) daysInRange.push(d);
    } else {
      for (let d = d1; d <= 6; d++) daysInRange.push(d);
      for (let d = 0; d <= d2; d++) daysInRange.push(d);
    }
    if (!daysInRange.includes(today)) continue;

    const to24 = (h, m, p) => {
      let hr = parseInt(h);
      if (p.toUpperCase() === 'PM' && hr !== 12) hr += 12;
      if (p.toUpperCase() === 'AM' && hr === 12) hr = 0;
      return hr * 60 + parseInt(m);
    };
    const open  = to24(h1, m1, p1);
    let   close = to24(h2, m2, p2);
    if (close < open) close += 24 * 60; // past midnight

    if (minutes >= open && minutes < close) return true;
  }
  return false; // has hours but none match now
}

function sortedBreweries(breweries, sort) {
  const list = [...breweries];
  if (sort === 'alpha') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'open') {
    const rank = id => {
      const s = isOpenNow(id);
      return s === true ? 0 : s === null ? 1 : 2;
    };
    list.sort((a, b) => rank(a.id) - rank(b.id) || a._distance - b._distance);
  } else {
    list.sort((a, b) => a._distance - b._distance);
  }
  return list;
}

function applySort(sort) {
  currentSort = sort;

  // Update button states
  sortBtns.forEach(btn => {
    const active = btn.dataset.sort === sort;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
  });

  // Re-order cards in DOM without re-rendering (maps/scrapes stay intact)
  const sorted = sortedBreweries(currentBreweries, sort);
  sorted.forEach(b => {
    const card = document.getElementById(`card-${b.id}`);
    if (card) breweryGrid.appendChild(card); // moves to end in sorted order
  });
}

function renderBreweries(breweries) {
  currentBreweries = breweries;
  scrapedDataCache = {};
  visibleCount = breweries.length;

  // Destroy previous maps
  for (const map of Object.values(mapInstances)) map.remove();
  mapInstances = {};
  if (mapObserver) mapObserver.disconnect();

  // Reset sort to distance on new search
  currentSort = 'distance';
  sortBtns.forEach(btn => {
    const active = btn.dataset.sort === 'distance';
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active);
  });

  breweryGrid.innerHTML = breweries.map((b, i) => renderBreweryCard(b, i)).join('');

  // Lazy Leaflet map init via IntersectionObserver
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

  // Kick off website scraping for all breweries that have a website
  startScraping(breweries);
}

// ─── Scraping Orchestration ───────────────────────────────────────────────────

let activeScrapeController = null; // lets us cancel if a new search fires

function startScraping(breweries) {
  // Cancel any previous run
  if (activeScrapeController) activeScrapeController.cancelled = true;
  const ctrl = { cancelled: false };
  activeScrapeController = ctrl;

  for (const brewery of breweries) {
    if (!brewery.website_url) {
      // No website — fill sections with "no website" message immediately
      markNoWebsite(brewery.id);
      continue;
    }

    scrapeQueue.add(async () => {
      if (ctrl.cancelled) return;
      // Mark card as "fetching" (already the default state, nothing to do)
      try {
        const results = await scrapeBrewery(brewery.website_url);
        if (ctrl.cancelled) return;
        applyScrapeResults(brewery, results);
      } catch (err) {
        if (ctrl.cancelled) return;
        markScrapeError(brewery.id, brewery.website_url, brewery.name);
      }
    });
  }
}

function markNoWebsite(id) {
  const msg = `<p class="section-unavailable">No website on record.</p>`;
  for (const key of ['hours','taplist','events','specials','food','foodtruck']) {
    setSectionContent(id, key, msg);
  }
}

function markScrapeError(id, website, name) {
  const msg = website
    ? `<p class="section-unavailable scrape-error">Could not fetch website. <a href="${encodeURI(website)}" target="_blank" rel="noopener">Visit ${escapeHtml(name)}'s site →</a></p>`
    : `<p class="section-unavailable scrape-error">Website unavailable.</p>`;
  for (const key of ['hours','taplist','events','specials','food','foodtruck']) {
    setSectionContent(id, key, msg);
  }
}

function applyScrapeResults(brewery, results) {
  const { id, name, website_url: website, brewery_type: type } = brewery;
  const isFood = ['brewpub', 'bar'].includes(type);

  // ── Closure handling ───────────────────────────────────────────────────────
  const closure = results.closure;

  if (closure?.confirmed) {
    removeClosedCard(id, name, closure.reasons);
    return;
  }

  if (closure?.possible) {
    showClosureWarning(id, closure.reasons);
  }

  // ── Cache hours for sort-by-open ───────────────────────────────────────────
  scrapedDataCache[id] = results;

  // ── Fill sections ──────────────────────────────────────────────────────────
  setSectionContent(id, 'hours',     renderHours(results.hours));
  setSectionContent(id, 'taplist',   renderTapList(results.tapList, website, name));
  setSectionContent(id, 'events',    renderEvents(results.events, website, name));
  setSectionContent(id, 'specials',  renderSpecials(results.specials, website, name));
  if (isFood || results.foodMenu) {
    setSectionContent(id, 'food',    renderFoodMenu(results.foodMenu, website, name));
  } else {
    setSectionContent(id, 'food',    `<p class="section-unavailable">Not a food-serving venue.</p>`);
  }
  setSectionContent(id, 'foodtruck', renderFoodTruck(results.foodTruck, website, name));

  // Re-apply sort if user is on "Open Now" (new data may change ranking)
  if (currentSort === 'open') applySort('open');
}

function removeClosedCard(id, name, reasons) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  visibleCount--;
  updateStatusCount();

  card.classList.add('card-closing');
  card.setAttribute('aria-label', `${name} — permanently closed`);

  // After animation, remove from DOM entirely
  card.addEventListener('animationend', () => card.remove(), { once: true });

  // Remove from currentBreweries so sort doesn't include it
  currentBreweries = currentBreweries.filter(b => b.id !== id);
}

function showClosureWarning(id, reasons) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  const banner = document.createElement('div');
  banner.className = 'closure-warning';
  banner.innerHTML = `
    <span class="closure-warning-icon">⚠</span>
    <span class="closure-warning-text">
      <strong>Possibly Closed</strong> — This brewery may no longer be in business.
      <span class="closure-reasons">${escapeHtml((reasons || []).join(' · '))}</span>
    </span>
  `;
  card.insertBefore(banner, card.firstChild);
  card.classList.add('card-possibly-closed');
}

function updateStatusCount() {
  if (visibleCount === 0) {
    showState(emptyState);
    setStatus('');
    return;
  }
  const radius = radiusSelect.value;
  const loc    = locationInput.value.trim();
  const txt    = statusText.textContent;
  // Replace the leading number in the existing status text
  statusText.textContent = txt.replace(/^\d+/, visibleCount);
}

// ─── Untappd Widget Loader (on-demand) ───────────────────────────────────────

window.loadUntappdWidget = function(btn, locationId) {
  const wrap = btn.closest('.untappd-embed-wrap');
  if (!wrap) return;

  btn.textContent = 'Loading…';
  btn.disabled = true;

  // Create the container div Untappd's script looks for
  const menuDiv = document.createElement('div');
  menuDiv.className = 'untappd_menu';
  wrap.innerHTML = '';
  wrap.appendChild(menuDiv);

  // Dynamically load the Untappd widget script
  const script = document.createElement('script');
  script.src = `https://widgets.untappd.com/beer_menu/v2/${encodeURIComponent(locationId)}`;
  script.charset = 'utf-8';
  script.onerror = () => {
    wrap.innerHTML = `<p class="section-unavailable scrape-error">Could not load Untappd widget.</p>`;
  };
  document.body.appendChild(script);
};

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

sortBtns.forEach(btn => {
  btn.addEventListener('click', () => applySort(btn.dataset.sort));
});

// ─── Init ─────────────────────────────────────────────────────────────────────

(async function init() {
  showState(welcomeState);
  // Auto-detect location on page load
  await detectLocation();
})();
