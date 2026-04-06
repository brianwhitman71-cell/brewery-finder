/**
 * Brewery Website Scraper
 *
 * Fetches each brewery's own website via CORS proxy and extracts:
 *   hours, tap list, events, specials, food menu, food truck info
 *
 * Strategy (in priority order):
 *   1. schema.org JSON-LD structured data  — highest fidelity
 *   2. Known third-party widget IDs        — Untappd, BeerMenus, Taplist.io, etc.
 *   3. DOM selector heuristics             — class/id keyword matching
 *   4. Body text pattern matching          — last resort regex
 */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const PROXIES = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

const FETCH_TIMEOUT_MS = 14000;
const MAX_CONCURRENT   = 3;

// ─── Concurrency Queue ────────────────────────────────────────────────────────

class Queue {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }
  add(fn) {
    return new Promise((resolve, reject) => {
      this.pending.push({ fn, resolve, reject });
      this._tick();
    });
  }
  _tick() {
    while (this.running < this.concurrency && this.pending.length) {
      const { fn, resolve, reject } = this.pending.shift();
      this.running++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        this.running--;
        this._tick();
      });
    }
  }
}

window.scrapeQueue = new Queue(MAX_CONCURRENT);

// ─── Closure Detection ────────────────────────────────────────────────────────

// Strong signals: explicitly stating closure → confirmed closed
const CLOSURE_STRONG = [
  /permanently\s+closed/i,
  /permanently\s+closing/i,
  /we(?:'ve|\s+have)\s+(?:permanently\s+)?closed\s+(?:our\s+)?doors/i,
  /closed\s+(?:our|its)\s+doors\s+(?:for\s+good|permanently|forever)/i,
  /no\s+longer\s+(?:open|in\s+business|operating|brewing|serving\s+(?:beer|guests))/i,
  /(?:gone|going)\s+out\s+of\s+business/i,
  /out\s+of\s+business/i,
  /ceased\s+(?:all\s+)?(?:operations?|business|brewing|production)/i,
  /our\s+(?:final|last)\s+(?:day|pour|pint|service)\s+(?:was|will\s+be)/i,
  /(?:closed|closing)\s+(?:for\s+)?good/i,
  /we\s+(?:are|were)\s+(?:officially\s+)?closed/i,
  /(?:business|taproom|brewery|brewpub)\s+(?:is\s+)?(?:now\s+)?closed\s+permanently/i,
];

// Domain parking / dead site
const PARKING_PATTERNS = [
  /this\s+domain\s+(?:name\s+)?(?:is\s+)?(?:for\s+sale|has\s+been\s+registered|is\s+parked)/i,
  /domain\s+(?:is\s+)?parked/i,
  /buy\s+this\s+domain/i,
  /domain\s+not\s+(?:configured|found)/i,
  /(?:your\s+)?account\s+(?:has\s+been\s+)?suspended/i,
  /this\s+(?:site|page|website)\s+(?:is\s+)?(?:under\s+construction|coming\s+soon)/i,
  /godaddy\.com\/domains\/find/i,
  /namecheap\.com\/domains\/registration/i,
  /sedo\.com/i,
];

// Moderate signals: softer language — need multiple or combine with HTTP error
const CLOSURE_MODERATE = [
  /(?:sadly|unfortunately|regrettably),?\s+(?:we\s+)?(?:are\s+|have\s+|will\s+be\s+)?clos/i,
  /(?:farewell|goodbye)\s+(?:from|to|dear|and\s+thank)/i,
  /(?:thank\s+you\s+for\s+(?:your\s+)?(?:\d+\s+)?(?:amazing\s+)?years)/i,
  /it\s+has\s+been\s+(?:an?\s+)?(?:honor|pleasure|privilege|wonderful\s+journey|great\s+run)/i,
  /we\s+(?:are|were)\s+(?:closing|shutting)\s+(?:our\s+(?:doors|taproom|brewery))/i,
  /our\s+last\s+day\s+(?:open\s+)?(?:was|will\s+be)/i,
  /(?:we\s+have|we've)\s+made\s+the\s+(?:difficult\s+)?decision\s+to\s+close/i,
  /effective\s+(?:immediately|[a-z]+\s+\d)/i,
];

function getClosureSnippet(text, pattern) {
  const m = text.match(pattern);
  if (!m) return null;
  const start = Math.max(0, m.index - 15);
  const end   = Math.min(text.length, m.index + m[0].length + 60);
  return '"…' + text.slice(start, end).replace(/\s+/g, ' ').trim() + '…"';
}

/**
 * Score closure signals. Returns:
 *   { score, confirmed (bool), possible (bool), reasons[] }
 *
 * score >= 8  → confirmed closed  (remove from results)
 * score 4–7   → possibly closed   (show warning)
 * score < 4   → assume open
 */
function detectClosure(html, httpStatus, schema) {
  const reasons = [];
  let score = 0;

  // HTTP-level signals
  if (httpStatus === 410) {
    score += 8;
    reasons.push('Website returns HTTP 410 (Gone — resource permanently removed)');
  } else if (httpStatus === 404) {
    score += 3;
    reasons.push('Website returns HTTP 404 (page not found)');
  } else if (httpStatus >= 500) {
    score += 1; // Server error — probably not closed, just broken
  }

  // Schema.org BusinessStatus
  const schemaStr = JSON.stringify(schema);
  if (/PermanentlyClosed/i.test(schemaStr)) {
    score += 10;
    reasons.push('Listed as Permanently Closed in schema.org structured data');
  }

  // Check first 100KB of content to avoid scanning huge pages
  const text = (html || '').slice(0, 100000);
  if (!text) {
    // Empty response — treat like 404 if we don't already have HTTP status
    if (score === 0) { score += 2; reasons.push('Empty response from website'); }
    return { score, confirmed: score >= 8, possible: score >= 4, reasons };
  }

  // Strong closure language
  for (const pattern of CLOSURE_STRONG) {
    const snippet = getClosureSnippet(text, pattern);
    if (snippet) {
      score += 10;
      reasons.push(`Closure language detected: ${snippet}`);
      break; // one strong match is enough
    }
  }

  // Domain parking
  for (const pattern of PARKING_PATTERNS) {
    if (pattern.test(text)) {
      score += 8;
      reasons.push('Website appears to be a domain parking / expired page');
      break;
    }
  }

  // Moderate closure language
  let moderateCount = 0;
  for (const pattern of CLOSURE_MODERATE) {
    if (pattern.test(text)) moderateCount++;
  }
  if (moderateCount >= 2) {
    score += 4;
    reasons.push(`Multiple soft closure indicators found on page (${moderateCount} matches)`);
  } else if (moderateCount === 1) {
    score += 2;
    reasons.push('Soft closure language found on page');
  }

  // Very short page with no real content (often parked/dead)
  if (text.length < 500 && !/<!DOCTYPE|<html/i.test(text)) {
    score += 2;
    reasons.push('Website returned unusually short content');
  }

  return {
    score,
    confirmed: score >= 8,
    possible:  score >= 4 && score < 8,
    reasons,
  };
}

// ─── Wayback Machine Check ────────────────────────────────────────────────────

/**
 * Check Wayback Machine CDX API for recent snapshots.
 * Only called when we already have a medium+ closure signal (to avoid unnecessary requests).
 * Returns { hasRecentSnapshot, lastTimestamp } or null on failure.
 */
async function checkWayback(websiteUrl) {
  try {
    const domain = new URL(websiteUrl).hostname;
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const from = oneYearAgo.toISOString().replace(/\D/g,'').slice(0, 8);

    // CDX API: find any snapshot of the domain in the past year
    const cdxUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${encodeURIComponent(domain)}/*` +
      `&output=json&limit=1&fl=timestamp&from=${from}&matchType=domain&collapse=urlkey`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(cdxUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json();

    // First row is header ["timestamp"], rest are results
    if (data.length > 1) {
      return { hasRecentSnapshot: true, lastTimestamp: data[1][0] };
    }

    // No snapshot in past year — check if it ever existed at all
    const allUrl =
      `https://web.archive.org/cdx/search/cdx` +
      `?url=${encodeURIComponent(domain)}/*&output=json&limit=1&fl=timestamp&matchType=domain&collapse=urlkey`;
    const allRes = await fetch(allUrl, { signal: AbortSignal.timeout(6000) });
    const allData = await allRes.json();
    return { hasRecentSnapshot: false, everArchived: allData.length > 1 };
  } catch {
    return null; // Wayback unavailable — ignore
  }
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

/** Returns { html, httpStatus } */
async function fetchViaProxy(url) {
  let lastErr;
  for (const makeUrl of PROXIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(makeUrl(url), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`Proxy HTTP ${res.status}`); continue; }
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        const httpStatus = json.status?.http_code ?? 200;
        return { html: json.contents || '', httpStatus };
      } catch {
        return { html: text, httpStatus: 200 };
      }
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All proxies failed');
}

// ─── DOM / Text Utilities ─────────────────────────────────────────────────────

function parseHtml(html) {
  return new DOMParser().parseFromString(html, 'text/html');
}

function cleanText(str) {
  return (str || '').replace(/\s+/g, ' ').trim();
}

function truncate(str, max) {
  const s = cleanText(str);
  return s.length > max ? s.slice(0, max).replace(/\s+\S*$/, '') + '…' : s;
}

function extractJsonLd(doc) {
  const results = [];
  doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const d = JSON.parse(s.textContent);
      const items = Array.isArray(d) ? d : (d['@graph'] ? d['@graph'] : [d]);
      results.push(...items);
    } catch {}
  });
  return results;
}

/** Flatten nested @graph and typed arrays into a single list */
function allSchemaItems(jsonLdItems) {
  const flat = [];
  const walk = item => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { item.forEach(walk); return; }
    flat.push(item);
    if (item['@graph']) walk(item['@graph']);
  };
  jsonLdItems.forEach(walk);
  return flat;
}

// ─── Time Formatting ──────────────────────────────────────────────────────────

const DAY_ABBR = { Mo:'Mon', Tu:'Tue', We:'Wed', Th:'Thu', Fr:'Fri', Sa:'Sat', Su:'Sun' };
const DAY_FULL = {
  monday:'Mon', tuesday:'Tue', wednesday:'Wed', thursday:'Thu',
  friday:'Fri', saturday:'Sat', sunday:'Sun',
};

function fmt24(t) {
  // "14:30" → "2:30 PM"
  const [h, m] = t.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour   = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m ? `${hour}:${String(m).padStart(2,'0')} ${suffix}` : `${hour} ${suffix}`;
}

function parseSchemaOpeningHours(raw) {
  // "Mo-Fr 11:00-22:00" or array of same
  const lines = Array.isArray(raw) ? raw : [raw];
  return lines.map(line => {
    const m = line.match(/^(\w{2})(?:-(\w{2}))?\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/);
    if (!m) return line;
    const [, d1, d2, t1, t2] = m;
    const days = d2 ? `${DAY_ABBR[d1]||d1}–${DAY_ABBR[d2]||d2}` : (DAY_ABBR[d1]||d1);
    return `${days}: ${fmt24(t1)} – ${fmt24(t2)}`;
  });
}

function parseSchemaHoursSpec(spec) {
  // openingHoursSpecification array
  const arr = Array.isArray(spec) ? spec : [spec];
  return arr.map(s => {
    const days = (Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek])
      .map(d => { const n = (d||'').split('/').pop(); return DAY_FULL[n.toLowerCase()] || n; })
      .join(', ');
    const open  = s.opens  ? fmt24(s.opens)  : '';
    const close = s.closes ? fmt24(s.closes) : '';
    return `${days}: ${open}${open && close ? ' – ' : ''}${close}`.trim();
  }).filter(Boolean);
}

function formatEventDate(dateStr) {
  if (!dateStr) return null;
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  } catch { return dateStr; }
}

// ─── Extractors ───────────────────────────────────────────────────────────────

function extractHours(doc, schema, html) {
  // 1. JSON-LD structured data
  for (const item of schema) {
    if (item.openingHours) {
      return { src: 'schema', lines: parseSchemaOpeningHours(item.openingHours) };
    }
    if (item.openingHoursSpecification) {
      return { src: 'schema', lines: parseSchemaHoursSpec(item.openingHoursSpecification) };
    }
  }

  // 2. DOM keyword selectors
  const selectors = ['[class*="hours"]','[id*="hours"]','[class*="schedule"]',
                     '[id*="schedule"]','[class*="opening"]','[class*="taproom"]'];
  for (const sel of selectors) {
    for (const el of doc.querySelectorAll(sel)) {
      const text = cleanText(el.textContent);
      if (text.length > 15 && text.length < 700 && /\d/.test(text) &&
          /(?:mon|tue|wed|thu|fri|sat|sun|am|pm)/i.test(text)) {
        return { src: 'dom', raw: text };
      }
    }
  }

  // 3. Body text pattern
  const body = doc.body ? doc.body.textContent : html;
  const re = /(?:(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)[\s\S]{0,8}?\d{1,2}(?::\d{2})?\s*(?:am|pm)[\s\S]{0,60}(?:\n|$))/gi;
  const matches = [...body.matchAll(re)].map(m => cleanText(m[0])).filter(Boolean);
  if (matches.length) return { src: 'text', lines: [...new Set(matches)].slice(0, 10) };

  return null;
}

function extractTapList(doc, html) {
  // 1. Untappd beer_menu widget (most common embed)
  const widgetM = html.match(/widgets\.untappd\.com\/beer_menu\/v2\/(\d+)/);
  if (widgetM) return { type: 'untappd-widget', id: widgetM[1] };

  // 2. Untappd venue link
  const venueM = html.match(/untappd\.com\/venue\/(\d+)/i);
  if (venueM) return { type: 'untappd-venue', id: venueM[1] };

  // 3. Untappd brewery/location link
  const locM = html.match(/untappd\.com\/(?:w\/[\w-]+|brewery)\/(\d+)/i);
  if (locM) return { type: 'untappd-brewery', id: locM[1] };

  // 4. BeerMenus
  const bmM = html.match(/beermenus\.com\/places\/([\w-]+)/i);
  if (bmM) return { type: 'beermenus', slug: bmM[1] };

  // 5. Taplist.io board
  const tlM = html.match(/taplist\.io\/board\/([\w-]+)/i);
  if (tlM) return { type: 'taplist-io', slug: tlM[1] };

  // 6. Digital Pour / COGS
  const dpM = html.match(/digitalpour\.com\/menu\/(\d+)/i);
  if (dpM) return { type: 'digitalpour', id: dpM[1] };

  // 7. Arryved Online Ordering (has tap list)
  const arM = html.match(/onlineorder\.arryved\.com\/(\w+)/i);
  if (arM) return { type: 'arryved', slug: arM[1] };

  // 8. Parse beer list from page HTML (look for ABV% near beer names)
  const items = [];
  const abvRe = /\d+\.?\d*\s*%\s*(?:abv)?/i;
  const trySelectors = ['[class*="beer"]','[class*="tap"]','[class*="draft"]',
                        '[class*="menu-item"]','[class*="brew"]','li','tr'];
  for (const sel of trySelectors) {
    doc.querySelectorAll(sel).forEach(el => {
      // Only leaf-ish nodes (few children)
      if (el.querySelectorAll('li,tr').length > 2) return;
      const text = cleanText(el.textContent);
      if (text.length > 4 && text.length < 180 && abvRe.test(text)) {
        items.push(text);
      }
    });
    if (items.length >= 3) break;
  }
  if (items.length >= 2) {
    const unique = [...new Set(items)].slice(0, 25);
    return { type: 'parsed-list', items: unique };
  }

  return null;
}

function extractEvents(doc, schema, html) {
  // 1. JSON-LD Event objects
  const schemaEvents = schema
    .filter(s => s['@type'] === 'Event' || s['@type'] === 'SocialEvent' ||
                 s['@type'] === 'MusicEvent' || s['@type'] === 'Festival')
    .map(s => ({
      name: s.name ? truncate(s.name, 80) : null,
      date: formatEventDate(s.startDate),
      desc: s.description ? truncate(s.description, 160) : null,
    }))
    .filter(e => e.name);
  if (schemaEvents.length) return { type: 'schema', events: schemaEvents.slice(0, 8) };

  // 2. Eventbrite
  const ebM = html.match(/eventbrite\.com\/(?:e\/[\w-]+|o\/([\w-]+))/i);
  if (ebM) return { type: 'eventbrite', url: `https://www.eventbrite.com/o/${ebM[1] || ''}` };

  // 3. Facebook events
  if (/facebook\.com\/events|fb\.com\/events/i.test(html)) {
    const fbM = html.match(/facebook\.com\/([\w.]+)/i);
    if (fbM) return { type: 'facebook', page: fbM[1] };
  }

  // 4. Trivia Night / Live Music patterns in body
  const body = doc.body ? doc.body.textContent : '';
  const eventKeywords = /(?:trivia|live music|live band|open mic|comedy|bingo|karaoke|tap takeover|beer release|tap list|brunch|drag|quiz night)/i;
  const datePattern   = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}\/\d{1,2}|mon|tue|wed|thu|fri|sat|sun)/i;

  const eventLines = [];
  doc.querySelectorAll('[class*="event"],[id*="event"],[class*="calendar"],[class*="upcoming"]')
    .forEach(el => {
      const text = cleanText(el.textContent);
      if (text.length > 8 && text.length < 400 && eventKeywords.test(text)) {
        eventLines.push(truncate(text, 200));
      }
    });
  if (eventLines.length) return { type: 'dom', items: [...new Set(eventLines)].slice(0, 6) };

  // 5. Scan list items for event-like text
  const listItems = [];
  doc.querySelectorAll('li').forEach(el => {
    const text = cleanText(el.textContent);
    if (text.length > 12 && text.length < 200 &&
        eventKeywords.test(text) && datePattern.test(text)) {
      listItems.push(truncate(text, 180));
    }
  });
  if (listItems.length) return { type: 'dom', items: [...new Set(listItems)].slice(0, 6) };

  return null;
}

function extractSpecials(doc, html) {
  const specials = [];
  const keywords = /(?:happy hour|special|deal|discount|half[- ]off|pint night|flight|growler|pitcher|$\d+|buck[s]?)/i;

  // DOM selectors
  doc.querySelectorAll('[class*="special"],[class*="deal"],[class*="happy"],[class*="promo"],[id*="special"]')
    .forEach(el => {
      const text = cleanText(el.textContent);
      if (text.length > 8 && text.length < 400 && keywords.test(text)) {
        specials.push(truncate(text, 200));
      }
    });
  if (specials.length) return { type: 'dom', items: [...new Set(specials)].slice(0, 5) };

  // Body text scan
  const body = doc.body ? doc.body.textContent : '';
  const m = body.match(/happy hour[\s\S]{0,400}/i);
  if (m) return { type: 'text', raw: truncate(m[0], 300) };

  return null;
}

function extractFoodMenu(doc, schema, html) {
  // 1. Schema.org hasMenu / Menu
  for (const item of schema) {
    if (item.hasMenu) {
      const menuUrl = typeof item.hasMenu === 'string' ? item.hasMenu : item.hasMenu.url;
      if (menuUrl) return { type: 'schema-link', url: menuUrl };
    }
    if (item['@type'] === 'Menu') {
      return { type: 'schema-menu', name: item.name, url: item.url };
    }
  }

  // 2. Menu links in page
  const menuLinks = [];
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || '';
    const text = cleanText(a.textContent).toLowerCase();
    if (/menu|food|kitchen/i.test(text) && href && !href.startsWith('#') &&
        !/facebook|instagram|twitter|yelp|untappd/i.test(href)) {
      menuLinks.push({ label: truncate(a.textContent, 50), href });
    }
  });

  // PDF menus
  const pdfMenu = menuLinks.find(l => /\.pdf/i.test(l.href));
  if (pdfMenu) return { type: 'link', label: pdfMenu.label || 'View Menu (PDF)', href: pdfMenu.href };

  // Food-specific links (not just "tap list" pages)
  const foodLink = menuLinks.find(l => /food|kitchen|eat|snack|bite/i.test(l.label) && !/beer|tap|drink/i.test(l.label));
  if (foodLink) return { type: 'link', label: foodLink.label || 'View Food Menu', href: foodLink.href };

  // Toast / Square Online / Clover ordering (often includes food menu)
  const toastM = html.match(/order\.toasttab\.com\/([\w-]+)/i);
  if (toastM) return { type: 'toast', url: `https://order.toasttab.com/${toastM[1]}` };

  // General menu link
  if (menuLinks.length) {
    const first = menuLinks[0];
    return { type: 'link', label: first.label || 'View Menu', href: first.href };
  }

  return null;
}

function extractFoodTruck(doc, html) {
  const keywords = /food\s*truck|food\s*cart|mobile\s*kitchen|pop[\s-]*up\s+(?:food|kitchen|restaurant)/i;

  // DOM selectors
  doc.querySelectorAll('[class*="truck"],[class*="food-"],[id*="truck"]').forEach(el => {
    const text = cleanText(el.textContent);
    if (text.length > 10 && keywords.test(text)) {
      return { type: 'dom', text: truncate(text, 250) };
    }
  });

  // Scan paragraphs and list items
  const candidates = [];
  doc.querySelectorAll('p,li,div').forEach(el => {
    if (el.children.length > 4) return; // skip containers
    const text = cleanText(el.textContent);
    if (text.length > 15 && text.length < 400 && keywords.test(text)) {
      candidates.push(truncate(text, 250));
    }
  });
  if (candidates.length) return { type: 'text', items: [...new Set(candidates)].slice(0, 4) };

  // Simple presence check
  if (keywords.test(html)) return { type: 'mentioned' };

  return null;
}

// ─── Resolve Relative URLs ────────────────────────────────────────────────────

function resolveUrl(href, baseUrl) {
  if (!href) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

// ─── Untappd Widget Script Parser ────────────────────────────────────────────

/**
 * Walk a string character-by-character and return the content of the first
 * balanced { … } block starting at or after `startPos`.
 * Correctly handles nested objects, arrays, and quoted strings.
 */
function extractBalancedObject(str, startPos = 0) {
  const open = str.indexOf('{', startPos);
  if (open === -1) return null;

  let depth = 0;
  let inStr  = false;
  let strCh  = '';
  let esc    = false;

  for (let i = open; i < str.length; i++) {
    const c = str[i];
    if (esc)            { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true;  continue; }
    if (inStr)          { if (c === strCh) inStr = false; continue; }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return str.slice(open, i + 1); }
  }
  return null;
}

/**
 * Recursively walk a parsed JSON object looking for beer-shaped nodes.
 * Untappd data can be nested under .menu.sections[].items[] or similar.
 */
function extractBeersFromObj(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 12) return [];

  // Beer item: has beer_name directly or nested under .beer
  const beerSrc = obj.beer_name ? obj : (obj.beer?.beer_name ? obj.beer : null);
  if (beerSrc) {
    const entry = {
      name:     beerSrc.beer_name        || null,
      style:    beerSrc.beer_style       || null,
      abv:      beerSrc.beer_abv != null ? Number(beerSrc.beer_abv) : null,
      ibu:      beerSrc.beer_ibu != null ? Number(beerSrc.beer_ibu) : null,
      desc:     beerSrc.beer_description || null,
      label:    beerSrc.beer_label       || null,
      rating:   beerSrc.rating_score     || null,
      brewery:  (obj.brewery || obj.brewer)?.brewery_name || null,
      price:    obj.price                || null,
      serving:  obj.serving_size         || null,
    };
    return entry.name ? [entry] : [];
  }

  const results = [];
  const children = Array.isArray(obj) ? obj : Object.values(obj);
  for (const child of children) {
    if (child && typeof child === 'object') {
      results.push(...extractBeersFromObj(child, depth + 1));
    }
  }
  return results;
}

/**
 * Fetch the Untappd widget JS file and parse out the beer menu data.
 * Returns an array of beer objects, or null if parsing fails.
 */
async function fetchAndParseUntappdWidget(locationId) {
  const widgetUrl = `https://widgets.untappd.com/beer_menu/v2/${locationId}`;
  let script;
  try {
    const { html } = await fetchViaProxy(widgetUrl);
    script = html;
  } catch {
    return null;
  }
  if (!script || script.length < 100) return null;

  // The widget embeds all data in one large JSON object. We scan the entire
  // script for every { … } block, try JSON.parse on each, and keep the one
  // that yields the most beers. Largest valid JSON block wins.
  let bestBeers = [];
  let pos = 0;

  while (pos < script.length) {
    const nextBrace = script.indexOf('{', pos);
    if (nextBrace === -1) break;

    const candidate = extractBalancedObject(script, nextBrace);
    if (!candidate) { pos = nextBrace + 1; continue; }

    pos = nextBrace + 1; // advance before we potentially skip on parse failure

    // Skip tiny objects — not data
    if (candidate.length < 80) continue;

    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      // Try common fixups: single-quoted strings, trailing commas
      try {
        const fixed = candidate
          .replace(/'/g, '"')
          .replace(/,(\s*[}\]])/g, '$1');
        parsed = JSON.parse(fixed);
      } catch { continue; }
    }

    const beers = extractBeersFromObj(parsed);
    if (beers.length > bestBeers.length) bestBeers = beers;

    // If we've found a solid list don't keep scanning (saves time)
    if (bestBeers.length >= 5) break;
  }

  return bestBeers.length > 0 ? bestBeers : null;
}

// ─── Main Scrape Entry Point ──────────────────────────────────────────────────

/**
 * Scrapes a brewery website and returns extracted data.
 * @param {string} websiteUrl
 * @returns {Promise<{hours, tapList, events, specials, foodMenu, foodTruck, error}>}
 */
window.scrapeBrewery = async function(websiteUrl) {
  const result = {
    hours: null, tapList: null, events: null, specials: null,
    foodMenu: null, foodTruck: null,
    closure: null,
    error: null,
  };

  try {
    const { html, httpStatus } = await fetchViaProxy(websiteUrl);

    const doc    = parseHtml(html || '');
    const schema = allSchemaItems(extractJsonLd(doc));

    // ── Closure detection (runs before content extraction) ──────────────────
    const closureCheck = detectClosure(html, httpStatus, schema);

    // If closure is only medium-confidence, run Wayback Machine to boost/confirm
    if (closureCheck.possible && !closureCheck.confirmed) {
      const wayback = await checkWayback(websiteUrl);
      if (wayback && !wayback.hasRecentSnapshot) {
        closureCheck.score += 4;
        if (wayback.everArchived) {
          closureCheck.reasons.push('No Wayback Machine snapshot in the past 12 months (was previously archived)');
        } else {
          closureCheck.reasons.push('No Wayback Machine snapshot found for this domain at all');
        }
        closureCheck.confirmed = closureCheck.score >= 8;
        closureCheck.possible  = closureCheck.score >= 4 && !closureCheck.confirmed;
      }
    }

    result.closure = closureCheck;

    // If high-confidence closure, skip full content extraction (save time)
    if (closureCheck.confirmed) return result;

    if (!html || html.length < 200) {
      result.error = 'Empty or blocked response';
      return result;
    }

    result.hours   = extractHours(doc, schema, html);
    result.tapList = extractTapList(doc, html);

    // If we found an Untappd widget ID, try to parse the actual beer data from
    // the widget script rather than just linking to it.
    if (result.tapList?.type === 'untappd-widget') {
      const beers = await fetchAndParseUntappdWidget(result.tapList.id);
      if (beers && beers.length > 0) {
        result.tapList = { type: 'untappd-parsed', id: result.tapList.id, beers };
      }
    }

    result.events    = extractEvents(doc, schema, html);
    result.specials  = extractSpecials(doc, html);
    result.foodMenu  = extractFoodMenu(doc, schema, html);
    result.foodTruck = extractFoodTruck(doc, html);

    if (result.foodMenu?.href && !result.foodMenu.href.startsWith('http')) {
      result.foodMenu.href = resolveUrl(result.foodMenu.href, websiteUrl);
    }

  } catch (err) {
    result.error = err.message || 'Failed to fetch';
  }

  return result;
};
