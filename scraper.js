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

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

async function fetchViaProxy(url) {
  let lastErr;
  for (const makeUrl of PROXIES) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(makeUrl(url), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      // allorigins wraps in JSON; corsproxy returns raw HTML
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.status && json.status.http_code >= 400)
          throw new Error(`Origin returned ${json.status.http_code}`);
        return json.contents || '';
      } catch {
        return text; // corsproxy-style raw response
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

// ─── Main Scrape Entry Point ──────────────────────────────────────────────────

/**
 * Scrapes a brewery website and returns extracted data.
 * @param {string} websiteUrl
 * @returns {Promise<{hours, tapList, events, specials, foodMenu, foodTruck, error}>}
 */
window.scrapeBrewery = async function(websiteUrl) {
  const result = { hours: null, tapList: null, events: null, specials: null, foodMenu: null, foodTruck: null, error: null };

  try {
    const html = await fetchViaProxy(websiteUrl);
    if (!html || html.length < 200) {
      result.error = 'Empty or blocked response';
      return result;
    }

    const doc    = parseHtml(html);
    const schema = allSchemaItems(extractJsonLd(doc));

    result.hours    = extractHours(doc, schema, html);
    result.tapList  = extractTapList(doc, html);
    result.events   = extractEvents(doc, schema, html);
    result.specials = extractSpecials(doc, html);
    result.foodMenu = extractFoodMenu(doc, schema, html);
    result.foodTruck = extractFoodTruck(doc, html);

    // Resolve relative menu URLs
    if (result.foodMenu && result.foodMenu.href && !result.foodMenu.href.startsWith('http')) {
      result.foodMenu.href = resolveUrl(result.foodMenu.href, websiteUrl);
    }

  } catch (err) {
    result.error = err.message || 'Failed to fetch';
  }

  return result;
};
