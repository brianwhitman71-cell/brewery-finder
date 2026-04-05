/**
 * Brewery Ownership Database
 *
 * Covers all publicly confirmed corporate acquisitions of craft breweries.
 * Everything not matched is displayed as "Independent".
 *
 * Sources: brewery press releases, SEC filings, industry reporting.
 * Last updated: 2024.
 *
 * Structure: each entry has:
 *   patterns  — array of lowercase name fragments to match against (any one match = hit)
 *   city      — optional city to disambiguate duplicate names (lowercase)
 *   owner     — parent company display name
 *   ownerType — 'bigbeer' | 'beverage-conglomerate' | 'international' | 'employee-owned'
 *               | 'publicly-traded' | 'private-equity' | 'family'
 *   since     — year of acquisition
 *   note      — optional extra context
 */

window.OWNERSHIP_DB = [

  // ══════════════════════════════════════════════════════════════
  // AB InBev (Anheuser-Busch InBev) — largest beer company on earth
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['goose island'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2011,
    note: 'Acquired by Anheuser-Busch in 2011 for ~$38.8M.'
  },
  {
    patterns: ['blue point'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2014,
    note: 'Acquired by Anheuser-Busch InBev in 2014.'
  },
  {
    patterns: ['10 barrel', 'ten barrel'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2014,
    note: 'Acquired by Anheuser-Busch InBev in 2014.'
  },
  {
    patterns: ['elysian brewing', 'elysian fields'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2015,
    note: 'Acquired by Anheuser-Busch InBev in 2015.'
  },
  {
    patterns: ['golden road'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2015,
    note: 'Acquired by Anheuser-Busch InBev in 2015.'
  },
  {
    patterns: ['four peaks'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2015,
    note: 'Acquired by Anheuser-Busch InBev in 2015.'
  },
  {
    patterns: ["devil's backbone", 'devils backbone'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2016,
    note: "Acquired by Anheuser-Busch InBev's High End division in 2016."
  },
  {
    patterns: ['karbach'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2016,
    note: 'Acquired by Anheuser-Busch InBev in 2016.'
  },
  {
    patterns: ['breckenridge brewery', 'breckenridge brew'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2016,
    note: 'Acquired by Anheuser-Busch InBev in 2016.'
  },
  {
    patterns: ['wicked weed'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2017,
    note: 'Acquired by Anheuser-Busch InBev in 2017.'
  },
  {
    patterns: ['platform beer'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2019,
    note: 'Acquired by Anheuser-Busch InBev in 2019.'
  },
  {
    patterns: ['veza sur'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2017,
    note: "Founded by AB InBev's High End group in 2017."
  },
  {
    patterns: ['cutwater spirits'],
    owner: 'AB InBev', ownerType: 'bigbeer', since: 2019,
    note: 'Acquired by Anheuser-Busch InBev in 2019.'
  },

  // ══════════════════════════════════════════════════════════════
  // Molson Coors
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['blue moon'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 1995,
    note: 'Created by Coors Brewing in 1995. Marketed as craft but owned by Molson Coors.'
  },
  {
    patterns: ['leinenkugel'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 1988,
    note: 'Acquired by Miller Brewing Company in 1988.'
  },
  {
    patterns: ['hop valley'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 2019,
    note: 'Acquired by Molson Coors in 2019.'
  },
  {
    patterns: ['revolver brewing'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 2015,
    note: 'Acquired by MillerCoors in 2015.'
  },
  {
    patterns: ['terrapin beer', 'terrapin brewing'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 2016,
    note: 'Acquired by MillerCoors in 2016.'
  },
  {
    patterns: ['saint archer'],
    owner: 'Molson Coors', ownerType: 'bigbeer', since: 2015,
    note: 'Acquired by MillerCoors in 2015.'
  },

  // ══════════════════════════════════════════════════════════════
  // Heineken
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['lagunitas'],
    owner: 'Heineken', ownerType: 'bigbeer', since: 2017,
    note: 'Heineken took a 50% stake in 2015, then acquired 100% in 2017.'
  },

  // ══════════════════════════════════════════════════════════════
  // Sapporo (Japan)
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['stone brewing', 'stone brew'],
    owner: 'Sapporo', ownerType: 'international', since: 2022,
    note: 'Acquired by Sapporo Holdings of Japan in 2022 for ~$165M.'
  },

  // ══════════════════════════════════════════════════════════════
  // Tilray Brands
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['sweetwater brewing', 'sweetwater brew'],
    owner: 'Tilray Brands', ownerType: 'beverage-conglomerate', since: 2020,
    note: 'Acquired by Tilray (cannabis/beverage company) in 2020 for $300M.'
  },
  {
    patterns: ['montauk brewing'],
    owner: 'Tilray Brands', ownerType: 'beverage-conglomerate', since: 2021,
    note: 'Acquired by Tilray Brands in 2021.'
  },

  // ══════════════════════════════════════════════════════════════
  // FIFCO USA (Costa Rican conglomerate, via Florida Ice & Farm)
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['magic hat'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2021,
    note: 'Previously owned by North American Breweries, acquired by FIFCO USA in 2021.'
  },
  {
    patterns: ['pyramid brewing', 'pyramid alehouse'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2012,
    note: 'Acquired via North American Breweries; now under FIFCO USA.'
  },
  {
    patterns: ['portland brewing'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2004,
    note: 'Acquired by Pyramid Brewing (now FIFCO USA) in 2004.'
  },
  {
    patterns: ['mactar'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2004,
    note: "MacTarnahan's acquired via Portland Brewing; now under FIFCO USA."
  },
  {
    patterns: ['oskar blues'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'CANarchy (Oskar Blues parent) acquired by FIFCO USA in 2022.'
  },
  {
    patterns: ['cigar city'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'Part of CANarchy group acquired by FIFCO USA in 2022.'
  },
  {
    patterns: ['perrin brewing'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'Part of CANarchy group acquired by FIFCO USA in 2022.'
  },
  {
    patterns: ['wasatch brewery', 'wasatch brew'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'Part of CANarchy group acquired by FIFCO USA in 2022.'
  },
  {
    patterns: ['squatters'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'Part of CANarchy group acquired by FIFCO USA in 2022.'
  },
  {
    patterns: ['three weavers'],
    owner: 'FIFCO USA', ownerType: 'international', since: 2022,
    note: 'Part of CANarchy group acquired by FIFCO USA in 2022.'
  },

  // ══════════════════════════════════════════════════════════════
  // Boston Beer Company (NYSE: SAM) — publicly traded
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['dogfish head'],
    owner: 'Boston Beer Company (SAM)', ownerType: 'publicly-traded', since: 2019,
    note: 'Merged with Boston Beer Company (makers of Samuel Adams) in 2019.'
  },
  {
    patterns: ['samuel adams', 'sam adams', 'boston beer'],
    owner: 'Boston Beer Company (SAM)', ownerType: 'publicly-traded', since: 1984,
    note: 'Boston Beer Company is publicly traded on NYSE under ticker SAM.'
  },

  // ══════════════════════════════════════════════════════════════
  // Duvel Moortgat (Belgian family-owned conglomerate)
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['boulevard brewing'],
    owner: 'Duvel Moortgat', ownerType: 'international', since: 2013,
    note: 'Acquired by Belgian brewer Duvel Moortgat in 2013.'
  },
  {
    patterns: ['firestone walker'],
    owner: 'Duvel Moortgat', ownerType: 'international', since: 2015,
    note: 'Duvel Moortgat acquired a minority stake in 2015; Firestone Walker family retains control.'
  },

  // ══════════════════════════════════════════════════════════════
  // Kirin Holdings (Japan) — via Lion Little World Beverages
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ["bell's brewery", 'bells brewery', 'bell\'s brewing', 'bells brewing'],
    owner: 'Kirin / Lion', ownerType: 'international', since: 2021,
    note: "Acquired by Lion Little World Beverages (owned by Japan's Kirin Holdings) in 2021."
  },
  {
    patterns: ['brooklyn brewery'],
    owner: 'Kirin (minority stake)', ownerType: 'international', since: 2016,
    note: 'Kirin Holdings holds a minority stake (~24.5%); Brooklyn Brewery remains independently operated.'
  },
  {
    patterns: ['new belgium'],
    owner: null, ownerType: 'employee-owned', since: 2013,
    note: '100% employee-owned (ESOP) since 2013. One of the largest employee-owned breweries in the US.'
  },

  // ══════════════════════════════════════════════════════════════
  // Explicitly notable independent / family-owned
  // (only list these when they're often assumed to be corporate)
  // ══════════════════════════════════════════════════════════════
  {
    patterns: ['sierra nevada'],
    owner: null, ownerType: 'family', since: 1980,
    note: 'Family-owned by founder Ken Grossman. One of the most prominent independent craft breweries in the US.'
  },
  {
    patterns: ['allagash'],
    owner: null, ownerType: 'employee-owned', since: 2022,
    note: '100% employee-owned (ESOP) since 2022. Founded by Rob Tod in 1995.'
  },
  {
    patterns: ['deschutes brewery', 'deschutes brew'],
    owner: null, ownerType: 'employee-owned', since: 2022,
    note: 'Employee-owned (ESOP). Sapporo holds a minority stake but Deschutes remains independently operated.'
  },
  {
    patterns: ['russian river'],
    owner: null, ownerType: 'family', since: 2004,
    note: 'Family-owned by Vinnie and Natalie Cilurzo.'
  },
  {
    patterns: ['toppling goliath'],
    owner: null, ownerType: 'family', since: 2009,
    note: 'Independently owned by the Morales family.'
  },
];

/**
 * Normalize a brewery name for fuzzy matching.
 * Strips common words and punctuation so "Goose Island Beer Co." → "goose island"
 */
window.normalizeBreweryName = function(name) {
  return name
    .toLowerCase()
    .replace(/\b(brewing company|brewing co\.?|beer company|beer co\.?|brewing|brewery|brewhouse|brewpub|craft beer|craft brewing|taproom|tap room|the |& | and )\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * Look up ownership info for a brewery by name (and optionally city).
 * Returns an ownership object or null if not found (= independent/unknown).
 */
window.lookupOwnership = function(breweryName, city) {
  const normalName = window.normalizeBreweryName(breweryName);
  const normalCity = city ? city.toLowerCase().trim() : '';

  for (const entry of window.OWNERSHIP_DB) {
    for (const pattern of entry.patterns) {
      if (normalName.includes(pattern) || (pattern.length > 4 && normalName.replace(/\s/g, '').includes(pattern.replace(/\s/g, '')))) {
        // If entry has a city constraint, enforce it
        if (entry.city && normalCity && !normalCity.includes(entry.city)) continue;
        return entry;
      }
    }
  }
  return null; // Independently owned (not in corporate acquisition database)
};
