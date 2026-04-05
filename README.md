# Brewery Finder — The Taproom Atlas

Find craft breweries and brewpubs near you. Uses your location (or any city you search) to discover nearby breweries within a configurable radius.

**Live site:** `https://YOUR-USERNAME.github.io/brewery-finder`

## Features

- **Location detection** — auto-detects your location on load
- **Location search** — search any city, address, or zip code
- **Adjustable radius** — 10 / 25 / 50 (default) / 100 / 200 miles
- **Per-brewery info** — name, type badge, distance, address, phone, website
- **Mini maps** — lazy-loaded dark map for each brewery (Leaflet + CartoDB)
- **Brewery sections** — hours, tap list, events, specials, food menu, food truck (links to brewery's own site where live data isn't in the public API)

## Data Sources

| Data | Source |
|------|--------|
| Brewery name, type, address, phone, website | [Open Brewery DB](https://www.openbrewerydb.org) — free, no API key |
| Maps | [Leaflet](https://leafletjs.com) + [CartoDB Dark Matter](https://carto.com) tiles |
| Geocoding (location search) | [Nominatim](https://nominatim.openstreetmap.org) (OpenStreetMap) |

**Note on tap lists, hours, events, food menus, and food truck info:** These aren't available in any free public API covering all breweries. Each brewery card links directly to the brewery's website for this live information.

## Hosting on GitHub Pages

1. **Create a new GitHub repository**
   ```
   gh repo create brewery-finder --public
   ```
   Or create it at github.com/new

2. **Push the files**
   ```bash
   cd brewery-finder
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR-USERNAME/brewery-finder.git
   git push -u origin main
   ```

3. **Enable GitHub Pages**
   - Go to your repo on GitHub
   - Settings → Pages
   - Source: **Deploy from a branch**
   - Branch: `main` / `/ (root)`
   - Save

4. Your site will be live at `https://YOUR-USERNAME.github.io/brewery-finder` within ~2 minutes.

## Local Development

No build step needed — just open `index.html` in a browser.

```bash
# Optional: serve locally with Python
python3 -m http.server 8080
# Then visit http://localhost:8080
```

> **Note:** Geolocation requires HTTPS or localhost. GitHub Pages serves over HTTPS automatically.
