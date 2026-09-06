// scraper.js
//
// Scrapes today's menu + nutrition facts from the Suwannee Room page on
// Seminole Dining's site (a JS-rendered site, so we drive a real headless
// browser rather than fetching raw HTML).
//
// IMPORTANT / READ ME:
// I built this against the page's public structure, but I could not run a
// live browser against seminoledining.mydininghub.com from my own sandbox to
// verify exact CSS class names (my dev environment's network is locked down
// to package registries only). So this scraper is written defensively: it
// tries several common selector patterns and falls back gracefully, and it
// dumps debug info to help you fix things quickly if the site's markup
// doesn't match what it expects.
//
// HOW TO FIX IT IF SCRAPING RETURNS 0 ITEMS OR BAD NUTRITION DATA:
//   1. Run:  node scraper.js --debug
//      This opens a *visible* (non-headless) browser window and prints
//      candidate selectors + counts to the console, and saves
//      data/debug-page.html (the fully rendered HTML) for inspection.
//   2. Open data/debug-page.html in a normal browser, or use Chrome DevTools
//      on the live site (right-click a menu item -> Inspect) to find the
//      real class names / structure.
//   3. Update the SELECTORS object below to match what you find.
//
// The rest of the app (manual "Add Custom Food") works completely
// independently of this scraper, so you can always log meals by hand even
// if the site changes and this needs a tune-up.

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const MENU_URL = "https://seminoledining.mydininghub.com/en/location/suwannee-room";

// ---------------------------------------------------------------------------
// PERSISTENT NUTRITION CACHE
//
// This is the single biggest speed lever available: dining hall menus repeat
// the same dishes constantly (across meal periods and across days — e.g.
// "Scrambled Eggs" or "Grilled Chicken" show up again and again). Once we've
// captured a dish's nutrition facts once, there's no reason to re-run the
// slow Add -> open calculator -> read -> Clear all cycle for it again.
//
// Keyed by normalized (lowercased, trimmed) food name. Saved to
// data/nutrition-cache.json and reused across every future sync, so the
// FIRST sync after this update will still take a while (everything is new),
// but every sync after that gets faster as more dishes become cached.
// ---------------------------------------------------------------------------
const SCRAPER_DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const NUTRITION_CACHE_FILE = path.join(SCRAPER_DATA_DIR, "nutrition-cache.json");

function loadNutritionCache() {
  try {
    if (!fs.existsSync(NUTRITION_CACHE_FILE)) return {};
    const raw = fs.readFileSync(NUTRITION_CACHE_FILE, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn("Could not read nutrition cache, starting fresh:", err.message);
    return {};
  }
}

function saveNutritionCache(cache) {
  const dataDir = SCRAPER_DATA_DIR;
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(NUTRITION_CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// SELECTORS: the most likely thing you'll need to edit if the site changes
// its markup. Each is a list of candidates tried in order; first match wins.
// ---------------------------------------------------------------------------
const SELECTORS = {
  stationHeading: ['h1', 'h2', 'h3', 'h4', '[class*="station" i]', '[class*="category" i]'],
  // The live site does not expose a stable menu-item class. Food cards are
  // identified structurally below by their visible "Add" control + calorie text.
  menuItem: [],
  nutritionModal: ['[role="dialog"]', '[class*="modal" i]', '[class*="drawer" i]'],
  modalClose: ['[aria-label="Close"]', '[aria-label="close"]', 'button[class*="close" i]'],
};

// Regex patterns used to pull numbers out of the "Summary Nutritional
// Information" text block, matched against the exact field labels confirmed
// on the live Suwannee Room "Meal Calculator" panel.
const NUTRIENT_PATTERNS = {
  calories: /calories?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  protein: /protein\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalCarbs: /total carbohydrate[s]?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalFat: /total fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  saturatedFat: /saturated fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  transFat: /trans fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  cholesterol: /cholesterol\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  sugars: /(?:total sugars|sugars)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  addedSugars: /added sugars\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  fiber: /(?:dietary fiber|fiber)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  sodium: /sodium\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  servingSize: /serving size\s*[:\-]?\s*([^\n]+)/i,
};

// The item selector is intentionally broad (any button with "item" in its
// class name), which can also catch site-chrome buttons like "Sign Out" or
// "Retry" that happen to share that class naming convention. Filter those
// out by name before we waste time trying to click into them.
const EXCLUDE_NAME_PATTERNS = [
  /^sign in$/i,
  /^sign out$/i,
  /^log in$/i,
  /^log out$/i,
  /^retry$/i,
  /^loading/i,
  /^add to cart$/i,
  /^view cart$/i,
  /^checkout$/i,
  /^search$/i,
  /^filters?$/i,
  /^clear( all)?$/i,
  /^apply$/i,
  /^close$/i,
  /^submit$/i,
  /^continue$/i,
  /^next$/i,
  /^previous$/i,
  /^back$/i,
  /^home$/i,
  /^locations?$/i,
  /^favorites?$/i,
  /^menu$/i,
  /^cart$/i,
  /^my account$/i,
  /^\s*$/,
  // Patterns confirmed from real Suwannee Room page output:
  /^add$/i, // the "Add to cart" button rendered next to each item's name
  /^view menu$/i,
  /^add to favorites$/i,
  /^meal:/i, // e.g. "Meal:Dinner" (meal-period toggle)
  /^view:/i, // e.g. "View:Daily" (view toggle)
  /^\d+\s*items?\d*\s*cal/i, // e.g. "0 items0 Cal" (cart summary pill)
  /^print$/i,
  /^my menu preferences$/i,
  /^view more$/i,
  /^join$/i, // "Join our email list" style footer/promo button
];

function isLikelyFoodItem(name) {
  if (!name || name.length < 2 || name.length > 120) return false;
  return !EXCLUDE_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

function parseNutritionText(text) {
  const result = {};
  for (const [key, regex] of Object.entries(NUTRIENT_PATTERNS)) {
    const match = text.match(regex);
    result[key] = match ? (key === "servingSize" ? match[1].trim() : Number(match[1])) : null;
  }
  return result;
}

async function findFirstMatch(page, selectorList) {
  for (const sel of selectorList) {
    const count = await page.$$eval(sel, (els) => els.length).catch(() => 0);
    if (count > 0) return { selector: sel, count };
  }
  return null;
}

// Clicks the first button/link/role=button element whose visible text
// matches exactly (case-insensitive). Used for "Clear all" in the Meal
// Calculator panel, which we don't have (and don't need) a stable CSS
// selector for.
async function clickButtonByText(page, text) {
  return page.evaluate((targetText) => {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    const match = candidates.find(
      (el) => el.textContent && el.textContent.trim().toLowerCase() === targetText.toLowerCase()
    );
    if (match) {
      match.click();
      return true;
    }
    return false;
  }, text);
}

// Clicking an item's "Add" button only adds it to the calculator silently —
// it does NOT open the nutrition popup by itself. To actually see nutrition,
// you have to separately click the small "N items / N Cal" summary pill
// elsewhere on the page, which opens the "Meal Calculator" modal. This finds
// and clicks that pill.
async function clickCalculatorPill(page) {
  return page.evaluate(() => {
    const regex = /^\d+\s*items?\s*\d*\s*cal/i;
    const all = Array.from(document.querySelectorAll("body *"));
    // Prefer the most specific (leaf-most) element whose own text matches,
    // to avoid grabbing some huge wrapping container.
    const leafMatches = all.filter(
      (el) => el.children.length === 0 && el.textContent && regex.test(el.textContent.trim())
    );
    const candidate =
      leafMatches[0] || all.find((el) => el.textContent && regex.test(el.textContent.trim()));
    if (!candidate) return false;

    // Walk up a few levels to find an actually-clickable ancestor, since the
    // matching text node is often inside a plain <span> or <div>.
    let target = candidate;
    let el = candidate;
    for (let i = 0; i < 4 && el; i++) {
      if (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button") {
        target = el;
        break;
      }
      el = el.parentElement;
    }
    target.click();
    return true;
  });
}

// After reading nutrition, close whatever dialog/modal is open so the next
// item starts from a clean state.
async function closeAnyDialog(page) {
  const closed = await page.evaluate(() => {
    const selectors = ['[aria-label="Close"]', '[aria-label="close"]', 'button[class*="close" i]'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!closed) {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

// The meal-period selector on the live site is a dropdown button labeled
// "Meal: <current period>" (e.g. "Meal: Brunch" on weekends, or
// "Meal: Breakfast" / "Meal: Lunch" / "Meal: Dinner" on weekdays — the
// dining hall rotates a weekend brunch menu vs. a weekday 3-meal menu).
// Rather than hardcode period names (which would silently miss "Brunch" on
// weekends), we open the dropdown and read whatever options it actually
// offers each time we scrape, then loop over all of them.

// Finds the "Meal: X" dropdown trigger button and clicks it to open the
// options list. Returns true if found and opened.
async function openMealDropdown(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const trigger = candidates.find(
      (el) => el.textContent && /^meal\s*:/i.test(el.textContent.trim())
    );
    if (trigger) {
      trigger.click();
      return true;
    }
    return false;
  });
}

// After opening the dropdown, reads the visible option labels
// (e.g. ["Breakfast", "Lunch", "Dinner"] or ["Brunch"]).
async function getMealDropdownOptions(page) {
  return page.evaluate(() => {
    // Common patterns for an opened dropdown's option list.
    const optionSelectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="listbox"] button',
      'ul[class*="dropdown"] li',
      'ul[class*="menu"] li',
      '[class*="dropdown"] [class*="option"]',
      '[class*="dropdown"] [class*="item"]',
    ];
    for (const sel of optionSelectors) {
      const els = Array.from(document.querySelectorAll(sel)).filter(
        (el) => el.offsetParent !== null // visible only
      );
      const texts = els
        .map((el) => el.textContent.trim())
        .filter((t) => t && t.length < 40 && !/^meal\s*:/i.test(t));
      if (texts.length > 0) return [...new Set(texts)];
    }
    return [];
  });
}

// Clicks a dropdown option by exact visible text (case-insensitive).
async function selectMealDropdownOption(page, optionText) {
  return page.evaluate((text) => {
    const optionSelectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="listbox"] button',
      'ul[class*="dropdown"] li',
      'ul[class*="menu"] li',
      '[class*="dropdown"] [class*="option"]',
      '[class*="dropdown"] [class*="item"]',
    ];
    for (const sel of optionSelectors) {
      const els = Array.from(document.querySelectorAll(sel));
      const match = els.find(
        (el) => el.textContent && el.textContent.trim().toLowerCase() === text.toLowerCase()
      );
      if (match) {
        match.click();
        return true;
      }
    }
    return false;
  }, optionText);
}

// Discovers which meal periods are offered right now (varies by day —
// e.g. "Brunch" on weekends vs. "Breakfast"/"Lunch"/"Dinner" on weekdays).
// Falls back to the weekday defaults if the dropdown can't be read, so a
// site-markup change degrades gracefully instead of scraping nothing.
async function discoverMealPeriods(page, debug) {
  const opened = await openMealDropdown(page);
  if (!opened) {
    if (debug) console.warn("[meal dropdown] Could not find the 'Meal: X' dropdown trigger. Falling back to default period names.");
    return ["Breakfast", "Lunch", "Dinner"];
  }
  await new Promise((r) => setTimeout(r, 120));
  const options = await getMealDropdownOptions(page);
  // Close the dropdown again (Escape) without changing selection, since we
  // haven't started scraping yet.
  await page.keyboard.press("Escape").catch(() => {});
  await new Promise((r) => setTimeout(r, 80));

  if (options.length === 0) {
    if (debug) console.warn("[meal dropdown] Dropdown opened but no options were readable. Falling back to default period names.");
    return ["Breakfast", "Lunch", "Dinner"];
  }
  if (debug) console.log(`[meal dropdown] Discovered periods for today: ${options.join(", ")}`);
  return options;
}

// Switches to a given meal period via the dropdown. Returns true on success.
async function clickMealPeriod(page, periodName) {
  const opened = await openMealDropdown(page);
  if (!opened) return false;
  await new Promise((r) => setTimeout(r, 120));
  const selected = await selectMealDropdownOption(page, periodName);
  if (!selected) {
    // Close the dropdown so we don't leave it hanging open.
    await page.keyboard.press("Escape").catch(() => {});
  }
  return selected;
}

// Stations show a limited number of items with a "View more" link/button
// beneath them (seen under Grill, Pizza, etc. on the live site). Click every
// visible "View more" until none remain, so scraping sees the full item
// list instead of just the first page of each station.
async function expandAllStations(page, maxRounds = 8) {
  for (let round = 0; round < maxRounds; round++) {
    const clicked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const viewMoreButtons = candidates.filter(
        (el) =>
          el.offsetParent !== null &&
          el.textContent &&
          /^view more$/i.test(el.textContent.trim())
      );
      viewMoreButtons.forEach((el) => el.click());
      return viewMoreButtons.length;
    });
    if (clicked === 0) break;
    // Let newly-revealed items render before checking for more "View more"
    // links (expanding one section can reveal another below it).
    await new Promise((r) => setTimeout(r, 150));
  }
}


const KNOWN_STATIONS = new Set([
  "chef's table", "homestyle", "true balance", "vegan", "deli", "grill",
  "pasta", "pizza", "soup & salad", "global solutions", "bakery",
  "soft serve ice cream", "worry free zone", "wfz"
]);

function cleanFoodName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/^[-•·]+\s*/, "")
    .trim();
}

function isBadExtractedName(name) {
  const n = cleanFoodName(name).toLowerCase();
  if (!n || n.length < 2 || n.length > 120) return true;
  if (KNOWN_STATIONS.has(n)) return true;
  return EXCLUDE_NAME_PATTERNS.some((re) => re.test(name.trim()));
}

// The menu app currently renders food cards without a stable, useful CSS class.
// Instead of guessing selectors, find visible "Add" controls and walk upward to
// the smallest ancestor that contains exactly one Add button and a calorie label.
// This survives CSS/class-name changes much better than [class*=menu-item].
async function extractVisibleFoodCards(page, debug) {
  return page.evaluate((knownStations, excludePatterns) => {
    const stationSet = new Set(knownStations);
    const excludes = excludePatterns.map(([source, flags]) => new RegExp(source, flags));
    const normalize = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" &&
        r.width > 0 && r.height > 0;
    };
    const isBadName = (name) => {
      const n = normalize(name).toLowerCase();
      if (!n || n.length < 2 || n.length > 120 || stationSet.has(n)) return true;
      return excludes.some((re) => re.test(normalize(name)));
    };

    // Strip UI chrome out of card text before looking for the actual food name.
    // The live site can render "220 Calories Add" on one line, so exact-line
    // filtering alone is not sufficient.
    const cleanLine = (line) => normalize(line)
      .replace(/\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/ig, "")
      .replace(/\bview\s+(?:more|less)\b/ig, "")
      .replace(/\badd\b/ig, "")
      .replace(/\bmeal\s*:\s*[^|]+/ig, "")
      .replace(/\bview\s*:\s*[^|]+/ig, "")
      .replace(/^[-•·]+\s*/, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    const addButtons = Array.from(document.querySelectorAll("button, a, [role=button]"))
      .filter((el) => visible(el) && /^add$/i.test(normalize(el.textContent)));

    const out = [];
    const seen = new Set();

    for (const add of addButtons) {
      // Look across several ancestors and score each one. We deliberately do
      // NOT stop at the first ancestor with one Add button: on this site that
      // wrapper may contain only "220 Calories Add" while the actual dish name
      // lives one or two parents higher.
      const candidates = [];
      let node = add.parentElement;
      for (let depth = 0; node && depth < 14; depth++, node = node.parentElement) {
        if (!visible(node)) continue;
        const controls = Array.from(node.querySelectorAll("button, a, [role=button]"))
          .filter((el) => visible(el));
        const addCount = controls.filter((el) => /^add$/i.test(normalize(el.textContent))).length;
        if (addCount !== 1) continue;

        const text = normalize(node.innerText);
        const calMatches = text.match(/\b(\d+(?:\.\d+)?)\s*(?:calories|cals?)\b/ig) || [];
        if (!calMatches.length || text.length < 10 || text.length > 1600) continue;

        const titleEls = Array.from(node.querySelectorAll(
          'h1,h2,h3,h4,h5,h6,[role="heading"],a[href],strong,b,[class*="name" i],[class*="title" i]'
        ))
          .filter(visible)
          .map((el) => cleanLine(el.textContent))
          .filter((v) => v && !isBadName(v) && v.length <= 100);

        const rawLines = String(node.innerText || "")
          .split(/\n+/)
          .map(cleanLine)
          .filter(Boolean);

        const meaningfulLines = [...new Set([...titleEls, ...rawLines])]
          .filter((line) => !isBadName(line))
          .filter((line) => !/^\d+(?:\.\d+)?$/.test(line));

        // Prefer a short heading-like string. If the card only exposes text
        // nodes, prefer the first concise line before a description.
        let name = titleEls.find((v) => v.length >= 2) ||
          meaningfulLines.find((v) => v.length >= 2 && v.length <= 90) || "";

        // Last-resort fallback: inspect direct children in document order and
        // keep the first concise text chunk that is not UI chrome.
        if (!name) {
          const direct = Array.from(node.children)
            .map((el) => cleanLine(el.innerText || el.textContent || ""))
            .filter((v) => v && v.length <= 100 && !isBadName(v));
          name = direct[0] || "";
        }

        if (!name || isBadName(name)) continue;

        const depthScore = depth;
        const titleScore = titleEls.includes(name) ? 40 : 0;
        const lengthPenalty = Math.max(0, name.length - 70) * 0.25;
        const score = titleScore - depthScore * 2 - lengthPenalty;
        candidates.push({ node, name, text, score });
      }

      if (!candidates.length) continue;
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];

      const calMatch = best.text.match(/\b(\d+(?:\.\d+)?)\s*(?:calories|cals?)\b/i);
      const calories = calMatch ? Number(calMatch[1]) : null;
      if (calories == null) continue;

      const key = best.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: best.name, calories });
    }

    return out;
  }, Array.from(KNOWN_STATIONS), EXCLUDE_NAME_PATTERNS.map((re) => [re.source, re.flags]));
}

async function scrapeOnePeriod(page, periodName, itemSelector, debug, nutritionCache) {
  await expandAllStations(page, 4);

  const extracted = await extractVisibleFoodCards(page, debug);
  if (debug) console.log(`[${periodName}] Extracted ${extracted.length} visible food cards.`);
  else console.log(`[${periodName}] Found ${extracted.length} food items.`);

  const items = [];
  let cacheHits = 0;
  let fresh = 0;

  for (const food of extracted) {
    const name = food.name;
    const cacheKey = name.trim().toLowerCase();
    const cached = nutritionCache[cacheKey];
    const baseNutrition = {
      calories: food.calories ?? null,
      protein: null,
      totalCarbs: null,
      totalFat: null,
      saturatedFat: null,
      transFat: null,
      cholesterol: null,
      sugars: null,
      addedSugars: null,
      fiber: null,
      sodium: null,
      servingSize: null,
    };

    if (cached) {
      items.push({ name, ...baseNutrition, ...cached, calories: cached.calories ?? food.calories ?? null });
      cacheHits++;
    } else {
      items.push({ name, ...baseNutrition });
      nutritionCache[cacheKey] = baseNutrition;
      fresh++;
    }
  }

  const withCalories = items.filter((it) => it.calories != null).length;
  console.log(`[${periodName}] Captured ${withCalories} / ${items.length} items (${cacheHits} cached, ${fresh} new).`);
  return items;
}

async function scrapeMenu({ debug = false } = {}) {
  const browser = await puppeteer.launch({
    headless: !debug,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    console.log(`Navigating to ${MENU_URL} ...`);
    // Do not wait for networkidle2: this site keeps background requests open,
    // which can turn a simple navigation into a 30-60s wait. DOMContentLoaded
    // plus a short readiness poll gets us to the rendered menu much faster.
    await page.goto(MENU_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForFunction(
      () => /Meal\s*:/i.test(document.body.innerText) ||
            /\bCalories\b/i.test(document.body.innerText) ||
            Array.from(document.querySelectorAll("button, a, [role=button]")).some((el) =>
              el.offsetParent !== null && /^add$/i.test((el.textContent || "").trim())
            ),
      { timeout: 10000, polling: 100 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 250));

    if (debug) {
      const html = await page.content();
      const dataDir = SCRAPER_DATA_DIR;
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "debug-page.html"), html, "utf-8");
      console.log("Saved rendered HTML to data/debug-page.html for inspection.");
      for (const [label, list] of Object.entries(SELECTORS)) {
        if (label === "menuItem") {
          const cards = await extractVisibleFoodCards(page, true);
          console.log(`[menuItem] structural extractor found ${cards.length} visible food cards`);
          continue;
        }
        const match = await findFirstMatch(page, list);
        console.log(
          match
            ? `[${label}] matched "${match.selector}" (${match.count} elements)`
            : `[${label}] NO MATCH from candidates: ${list.join(", ")}`
        );
      }
    }

    // Load the persistent nutrition cache once per sync. Every scrapeOnePeriod
    // call below shares this same object so a dish scraped during Breakfast
    // is already cached by the time Lunch/Dinner scrape the same dish name.
    const nutritionCache = loadNutritionCache();

    // Find out which meal periods are actually offered today — this varies:
    // weekends show a single "Brunch" period, weekdays show "Breakfast",
    // "Lunch", and "Dinner" separately. Scraping a hardcoded list would
    // silently return nothing on days that don't match it.
    const periodsToday = await discoverMealPeriods(page, debug);

    // mealPeriods is the primary structure: { Breakfast: [...], Lunch: [...], Dinner: [...] }
    // (or { Brunch: [...] } on weekends). stations is kept for backwards
    // compatibility with anything that reads the old flat format.
    const mealPeriods = {};
    let allItems = [];

    for (const period of periodsToday) {
      console.log(`\n--- Switching to ${period} ---`);
      const clicked = await clickMealPeriod(page, period);
      if (!clicked) {
        console.log(`[${period}] Toggle button not found — skipping (may not be offered today).`);
        continue;
      }

      // Wait for the menu to re-render after switching periods.
      // 800ms is enough for most React/Vue menu widgets to settle.
      await new Promise((r) => setTimeout(r, 250));

      const items = await scrapeOnePeriod(page, period, null, debug, nutritionCache);
      if (items.length > 0) {
        mealPeriods[period] = items;
        allItems = allItems.concat(items);
      }

      // Save the cache after each period (not just at the very end) so a
      // crash or timeout partway through a sync doesn't lose nutrition data
      // already captured for earlier periods.
      saveNutritionCache(nutritionCache);
    }

    // If none of the period toggles were found (site layout without tabs,
    // or all periods failed), fall back to scraping whatever is visible.
    if (Object.keys(mealPeriods).length === 0) {
      console.log("\nNo meal period toggles found — scraping visible items as a single list.");
      const items = await scrapeOnePeriod(page, "Menu", null, debug, nutritionCache);
      mealPeriods["Menu"] = items;
      allItems = items;
      saveNutritionCache(nutritionCache);
    }

    // Preserve any meal period we already captured earlier today if a later
    // scrape partially fails. Never carry yesterday's menu into a new day.
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    let previous = null;
    try {
      const cachePath = path.join(SCRAPER_DATA_DIR, "menu-cache.json");
      if (fs.existsSync(cachePath)) previous = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    } catch (_) {}

    if (previous?.menuDate === localDate && previous?.mealPeriods) {
      for (const [period, oldItems] of Object.entries(previous.mealPeriods)) {
        if (!mealPeriods[period]?.length && Array.isArray(oldItems) && oldItems.length) {
          mealPeriods[period] = oldItems;
        }
      }
    }

    allItems = Object.values(mealPeriods).flat();
    const deduped = new Map();
    allItems.forEach((item) => {
      const key = item.name.trim().toLowerCase();
      if (!deduped.has(key)) deduped.set(key, item);
    });

    const result = {
      scrapedAt: new Date().toISOString(),
      menuDate: localDate,
      mealPeriods,
      // Legacy field: flat list of all items across all meal periods.
      stations: [{ name: "All Items", items: Array.from(deduped.values()) }],
    };

    console.log(`\nDone. Total items across all periods: ${allItems.length}`);
    return result;
  } finally {
    await browser.close();
  }
}

// Allow running directly: `node scraper.js` or `node scraper.js --debug`
if (require.main === module) {
  const debug = process.argv.includes("--debug");
  scrapeMenu({ debug })
    .then((result) => {
      const dataDir = SCRAPER_DATA_DIR;
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "menu-cache.json"), JSON.stringify(result, null, 2));
      console.log(`Done. Scraped ${result.stations.reduce((n, s) => n + s.items.length, 0)} items.`);
      console.log("Saved to data/menu-cache.json");
    })
    .catch((err) => {
      console.error("Scrape failed:", err);
      process.exit(1);
    });
}

module.exports = { scrapeMenu, MENU_URL };
