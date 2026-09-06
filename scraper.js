// scraper.js
//
// Scrapes today's menu + nutrition facts from the Suwannee Room page.
// Uses Puppeteer because Seminole Dining renders the menu with JavaScript.

const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const MENU_URL =
  "https://seminoledining.mydininghub.com/en/location/suwannee-room";

const SCRAPER_DATA_DIR =
  process.env.DATA_DIR || path.join(__dirname, "data");

const NUTRITION_CACHE_FILE = path.join(
  SCRAPER_DATA_DIR,
  "nutrition-cache.json"
);

// ---------------------------------------------------------------------------
// CACHE
// ---------------------------------------------------------------------------

function loadNutritionCache() {
  try {
    if (!fs.existsSync(NUTRITION_CACHE_FILE)) return {};
    const raw = fs.readFileSync(NUTRITION_CACHE_FILE, "utf-8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn(
      "Could not read nutrition cache, starting fresh:",
      err.message
    );
    return {};
  }
}

function saveNutritionCache(cache) {
  if (!fs.existsSync(SCRAPER_DATA_DIR)) {
    fs.mkdirSync(SCRAPER_DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(
    NUTRITION_CACHE_FILE,
    JSON.stringify(cache, null, 2),
    "utf-8"
  );
}

// ---------------------------------------------------------------------------
// GENERAL HELPERS
// ---------------------------------------------------------------------------

const KNOWN_STATIONS = new Set([
  "chef's table",
  "homestyle",
  "true balance",
  "vegan",
  "deli",
  "grill",
  "pasta",
  "pizza",
  "soup & salad",
  "global solutions",
  "bakery",
  "soft serve ice cream",
  "worry free zone",
  "wfz",
]);

const EXCLUDE_NAME_PATTERNS = [
  /^sign in$/i,
  /^sign out$/i,
  /^log in$/i,
  /^log out$/i,
  /^retry$/i,
  /^loading/i,
  /^add$/i,
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
  /^\s*$/i,
  /^view menu$/i,
  /^add to favorites$/i,
  /^meal:/i,
  /^view:/i,
  /^\d+\s*items?\d*\s*cal/i,
  /^print$/i,
  /^my menu preferences$/i,
  /^view more$/i,
  /^view less$/i,
  /^join$/i,
];

function cleanFoodName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/^[-•·]+\s*/, "")
    .trim();
}

function isBadName(name) {
  const n = cleanFoodName(name).toLowerCase();

  if (!n || n.length < 2 || n.length > 120) return true;
  if (KNOWN_STATIONS.has(n)) return true;

  return EXCLUDE_NAME_PATTERNS.some((re) => re.test(n));
}

// ---------------------------------------------------------------------------
// NUTRITION
// ---------------------------------------------------------------------------

const NUTRIENT_PATTERNS = {
  calories: /calories?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  protein: /protein\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalCarbs:
    /total carbohydrate[s]?\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  totalFat: /total fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  saturatedFat:
    /saturated fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  transFat: /trans fat\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  cholesterol:
    /cholesterol\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  sugars:
    /(?:total sugars|sugars)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  addedSugars:
    /added sugars\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  fiber:
    /(?:dietary fiber|fiber)\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g/i,
  sodium:
    /sodium\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*mg/i,
  servingSize:
    /serving size\s*[:\-]?\s*([^\n]+)/i,
};

function parseNutritionText(text) {
  const result = {};

  for (const [key, regex] of Object.entries(NUTRIENT_PATTERNS)) {
    const match = String(text || "").match(regex);

    result[key] = match
      ? key === "servingSize"
        ? match[1].trim()
        : Number(match[1])
      : null;
  }

  return result;
}

// ---------------------------------------------------------------------------
// WAITING FOR THE MENU
// ---------------------------------------------------------------------------
//
// The old scraper waited for 10 seconds and then immediately scraped.
// The problem is that the menu can still be rendering.
//
// This version checks quickly first. If the menu isn't ready, it waits longer.
// Normal fast loads therefore stay fast.
// ---------------------------------------------------------------------------

async function waitForMenu(page, maxWait = 12000) {
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const state = await page
      .evaluate(() => {
        const body = document.body?.innerText || "";

        const hasMeal = /Meal\s*:/i.test(body);
        const hasCalories = /\b\d+(?:\.\d+)?\s*Calories\b/i.test(body);

        const addCount = Array.from(
          document.querySelectorAll("button, a, [role='button']")
        ).filter((el) => {
          const style = window.getComputedStyle(el);
          const rect = el.getBoundingClientRect();

          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            /^add$/i.test((el.textContent || "").trim())
          );
        }).length;

        const stillLoading =
          /(^|\n)\s*Loading\.{0,3}\s*($|\n)/i.test(body);

        return {
          hasMeal,
          hasCalories,
          addCount,
          stillLoading,
        };
      })
      .catch(() => ({
        hasMeal: false,
        hasCalories: false,
        addCount: 0,
        stillLoading: true,
      }));

    if (
      state.hasCalories ||
      state.addCount > 0 ||
      (state.hasMeal && !state.stillLoading)
    ) {
      return true;
    }

    // Fast polling at first.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

async function waitForMenuChange(page, oldText = "") {
  const start = Date.now();
  const maxWait = 8000;

  while (Date.now() - start < maxWait) {
    const state = await page
      .evaluate((previousText) => {
        const body = document.body?.innerText || "";

        const hasCalories = /\b\d+(?:\.\d+)?\s*Calories\b/i.test(body);

        const hasAdd = Array.from(
          document.querySelectorAll("button, a, [role='button']")
        ).some(
          (el) =>
            el.offsetParent !== null &&
            /^add$/i.test((el.textContent || "").trim())
        );

        const changed =
          previousText &&
          body.slice(0, 5000) !== previousText.slice(0, 5000);

        return {
          ready: hasCalories || hasAdd,
          changed,
        };
      }, oldText)
      .catch(() => ({ ready: false, changed: false }));

    if (state.ready || state.changed) return true;

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

// ---------------------------------------------------------------------------
// MEAL DROPDOWN
// ---------------------------------------------------------------------------

async function openMealDropdown(page) {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll("button, [role='button']")
    );

    const trigger = candidates.find(
      (el) =>
        el.textContent &&
        /^meal\s*:/i.test(el.textContent.trim()) &&
        el.offsetParent !== null
    );

    if (!trigger) return false;

    trigger.click();
    return true;
  });
}

async function getMealDropdownOptions(page) {
  return page.evaluate(() => {
    const selectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="listbox"] button',
      'ul[class*="dropdown"] li',
      'ul[class*="menu"] li',
      '[class*="dropdown"] [class*="option"]',
      '[class*="dropdown"] [class*="item"]',
    ];

    for (const selector of selectors) {
      const elements = Array.from(
        document.querySelectorAll(selector)
      ).filter((el) => el.offsetParent !== null);

      const texts = elements
        .map((el) => (el.textContent || "").trim())
        .filter(
          (text) =>
            text &&
            text.length < 40 &&
            !/^meal\s*:/i.test(text)
        );

      if (texts.length) {
        return [...new Set(texts)];
      }
    }

    return [];
  });
}

async function discoverMealPeriods(page, debug) {
  const opened = await openMealDropdown(page);

  if (!opened) {
    if (debug) {
      console.log(
        "[meal dropdown] Not found. Using visible menu instead."
      );
    }

    return [];
  }

  await new Promise((resolve) => setTimeout(resolve, 150));

  const options = await getMealDropdownOptions(page);

  await page.keyboard.press("Escape").catch(() => {});

  if (debug) {
    console.log(
      "[meal dropdown] Options:",
      options.length ? options.join(", ") : "NONE"
    );
  }

  return options;
}

async function selectMealDropdownOption(page, optionText) {
  return page.evaluate((text) => {
    const selectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="listbox"] li',
      '[role="listbox"] button',
      'ul[class*="dropdown"] li',
      'ul[class*="menu"] li',
      '[class*="dropdown"] [class*="option"]',
      '[class*="dropdown"] [class*="item"]',
    ];

    for (const selector of selectors) {
      const elements = Array.from(
        document.querySelectorAll(selector)
      );

      const match = elements.find(
        (el) =>
          el.offsetParent !== null &&
          (el.textContent || "").trim().toLowerCase() ===
            text.toLowerCase()
      );

      if (match) {
        match.click();
        return true;
      }
    }

    return false;
  }, optionText);
}

async function clickMealPeriod(page, periodName) {
  const before = await page.evaluate(
    () => (document.body?.innerText || "").slice(0, 5000)
  );

  const opened = await openMealDropdown(page);

  if (!opened) return false;

  await new Promise((resolve) => setTimeout(resolve, 120));

  const selected = await selectMealDropdownOption(
    page,
    periodName
  );

  if (!selected) {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }

  // Give React time to update, but don't blindly sleep for a long time.
  await waitForMenuChange(page, before);

  return true;
}

// ---------------------------------------------------------------------------
// EXPAND STATIONS
// ---------------------------------------------------------------------------

async function expandAllStations(page) {
  for (let round = 0; round < 5; round++) {
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button']"
        )
      ).filter(
        (el) =>
          el.offsetParent !== null &&
          /^view more$/i.test(
            (el.textContent || "").trim()
          )
      );

      buttons.forEach((button) => button.click());

      return buttons.length;
    });

    if (!clicked) break;

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

// ---------------------------------------------------------------------------
// FOOD EXTRACTION
// ---------------------------------------------------------------------------
//
// Two-pass system:
//
// 1. Preferred: find "Add" controls and their food cards.
// 2. Fallback: if the site changed its Add button structure, look for
//    visible calorie labels and work upward to find the food name.
//
// This is important because the previous scraper depended entirely on
// exact "Add" buttons.
//

async function extractVisibleFoodCards(page, debug) {
  const result = await page.evaluate(
    ({ knownStations, excludePatterns }) => {
      const stationSet = new Set(knownStations);

      const excludes = excludePatterns.map(
        ([source, flags]) =>
          new RegExp(source, flags)
      );

      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const visible = (el) => {
        if (!el) return false;

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const badName = (name) => {
        const normalized = normalize(name).toLowerCase();

        if (
          !normalized ||
          normalized.length < 2 ||
          normalized.length > 120
        ) {
          return true;
        }

        if (stationSet.has(normalized)) return true;

        return excludes.some((regex) =>
          regex.test(normalized)
        );
      };

      const cleanLine = (line) =>
        normalize(line)
          .replace(
            /\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/gi,
            ""
          )
          .replace(
            /\bview\s+(?:more|less)\b/gi,
            ""
          )
          .replace(/\badd\b/gi, "")
          .replace(
            /\bmeal\s*:\s*[^|]+/gi,
            ""
          )
          .replace(
            /\bview\s*:\s*[^|]+/gi,
            ""
          )
          .replace(/^[-•·]+\s*/, "")
          .replace(/\s{2,}/g, " ")
          .trim();

      const getNameFromCard = (node) => {
        const headingCandidates = Array.from(
          node.querySelectorAll(
            [
              "h1",
              "h2",
              "h3",
              "h4",
              "h5",
              "h6",
              '[role="heading"]',
              "strong",
              "b",
              '[class*="name" i]',
              '[class*="title" i]',
            ].join(",")
          )
        )
          .filter(visible)
          .map((el) => cleanLine(el.textContent))
          .filter(
            (name) =>
              name &&
              !badName(name) &&
              name.length <= 100
          );

        if (headingCandidates.length) {
          return headingCandidates.sort(
            (a, b) => a.length - b.length
          )[0];
        }

        const lines = String(
          node.innerText || ""
        )
          .split(/\n+/)
          .map(cleanLine)
          .filter(Boolean)
          .filter((line) => !badName(line))
          .filter(
            (line) =>
              !/^\d+(?:\.\d+)?$/.test(line)
          );

        return (
          lines.find(
            (line) =>
              line.length >= 2 &&
              line.length <= 90
          ) || ""
        );
      };

      const output = [];
      const seen = new Set();

      // ---------------------------------------------------------------
      // PASS 1: Add buttons
      // ---------------------------------------------------------------

      const addButtons = Array.from(
        document.querySelectorAll(
          "button, a, [role='button']"
        )
      ).filter(
        (el) =>
          visible(el) &&
          /^add$/i.test(
            normalize(el.textContent)
          )
      );

      for (const add of addButtons) {
        let node = add.parentElement;

        for (let depth = 0; node && depth < 12; depth++) {
          if (visible(node)) {
            const text = normalize(
              node.innerText
            );

            const calorieMatch = text.match(
              /\b(\d+(?:\.\d+)?)\s*(?:calories|cals?)\b/i
            );

            if (
              calorieMatch &&
              text.length >= 10 &&
              text.length <= 1600
            ) {
              const name = getNameFromCard(node);

              if (!badName(name)) {
                const key =
                  name.toLowerCase();

                if (!seen.has(key)) {
                  seen.add(key);

                  output.push({
                    name,
                    calories: Number(
                      calorieMatch[1]
                    ),
                  });
                }

                break;
              }
            }
          }

          node = node.parentElement;
        }
      }

      // ---------------------------------------------------------------
      // PASS 2: Calorie-label fallback
      // ---------------------------------------------------------------

      if (output.length === 0) {
        const calorieElements = Array.from(
          document.querySelectorAll(
            "body *"
          )
        ).filter((el) => {
          if (!visible(el)) return false;

          const text = normalize(
            el.textContent
          );

          return (
            text.length < 300 &&
            /\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/i.test(
              text
            )
          );
        });

        for (const calorieEl of calorieElements) {
          const text = normalize(
            calorieEl.innerText ||
              calorieEl.textContent
          );

          const match = text.match(
            /\b(\d+(?:\.\d+)?)\s*(?:calories|cals?)\b/i
          );

          if (!match) continue;

          let node = calorieEl;

          for (
            let depth = 0;
            node && depth < 10;
            depth++
          ) {
            if (!visible(node)) {
              node = node.parentElement;
              continue;
            }

            const name = getNameFromCard(node);

            if (
              !badName(name) &&
              name.length >= 2 &&
              name.length <= 100
            ) {
              const key =
                name.toLowerCase();

              if (!seen.has(key)) {
                seen.add(key);

                output.push({
                  name,
                  calories: Number(
                    match[1]
                  ),
                });
              }

              break;
            }

            node = node.parentElement;
          }
        }
      }

      return output;
    },
    {
      knownStations: Array.from(
        KNOWN_STATIONS
      ),
      excludePatterns:
        EXCLUDE_NAME_PATTERNS.map(
          (regex) => [
            regex.source,
            regex.flags,
          ]
        ),
    }
  );

  if (debug) {
    console.log(
      `[extractor] Found ${result.length} food cards.`
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// SCRAPE ONE PERIOD
// ---------------------------------------------------------------------------

async function scrapeOnePeriod(
  page,
  periodName,
  debug,
  nutritionCache
) {
  await expandAllStations(page);

  const extracted =
    await extractVisibleFoodCards(
      page,
      debug
    );

  console.log(
    `[${periodName}] Found ${extracted.length} food items.`
  );

  // Diagnostic information if extraction fails.
  if (extracted.length === 0) {
    const diagnostics =
      await page.evaluate(() => {
        const body =
          document.body?.innerText || "";

        const buttons = Array.from(
          document.querySelectorAll(
            "button, a, [role='button']"
          )
        )
          .filter(
            (el) => el.offsetParent !== null
          )
          .map((el) =>
            (el.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
          )
          .filter(Boolean)
          .slice(0, 80);

        return {
          bodyPreview: body
            .replace(/\s+/g, " ")
            .slice(0, 1500),

          buttonTexts: buttons,
        };
      });

    console.log(
      `[${periodName}] ZERO ITEMS DIAGNOSTIC:`
    );

    console.log(
      `[${periodName}] Body:`,
      diagnostics.bodyPreview
    );

    console.log(
      `[${periodName}] Visible controls:`,
      diagnostics.buttonTexts.join(" | ")
    );
  }

  const items = [];

  let cacheHits = 0;
  let fresh = 0;

  for (const food of extracted) {
    const name = food.name;

    const cacheKey =
      name.trim().toLowerCase();

    const cached =
      nutritionCache[cacheKey];

    const baseNutrition = {
      calories:
        food.calories ?? null,
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
      items.push({
        name,
        ...baseNutrition,
        ...cached,
        calories:
          cached.calories ??
          food.calories ??
          null,
      });

      cacheHits++;
    } else {
      items.push({
        name,
        ...baseNutrition,
      });

      nutritionCache[cacheKey] =
        baseNutrition;

      fresh++;
    }
  }

  const withCalories =
    items.filter(
      (item) =>
        item.calories != null
    ).length;

  console.log(
    `[${periodName}] Captured ${withCalories} / ${items.length} items (${cacheHits} cached, ${fresh} new).`
  );

  return items;
}

// ---------------------------------------------------------------------------
// MAIN SCRAPER
// ---------------------------------------------------------------------------

async function scrapeMenu({ debug = false } = {}) {
  const browser =
    await puppeteer.launch({
      headless: !debug,

      executablePath:
        process.env
          .PUPPETEER_EXECUTABLE_PATH ||
        undefined,

      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

  try {
    const page =
      await browser.newPage();

    await page.setViewport({
      width: 1400,
      height: 1000,
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36"
    );

    console.log(
      `Navigating to ${MENU_URL} ...`
    );

    await page.goto(MENU_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Fast normal path + slower fallback if the menu is delayed.
    const menuReady =
      await waitForMenu(
        page,
        12000
      );

    console.log(
      menuReady
        ? "Menu appears to be loaded."
        : "Menu did not fully load within the normal wait window; attempting extraction anyway."
    );

    if (debug) {
      const html =
        await page.content();

      if (
        !fs.existsSync(
          SCRAPER_DATA_DIR
        )
      ) {
        fs.mkdirSync(
          SCRAPER_DATA_DIR,
          {
            recursive: true,
          }
        );
      }

      fs.writeFileSync(
        path.join(
          SCRAPER_DATA_DIR,
          "debug-page.html"
        ),
        html,
        "utf-8"
      );

      console.log(
        "Saved rendered HTML to data/debug-page.html"
      );
    }

    const nutritionCache =
      loadNutritionCache();

    // ---------------------------------------------------------------
    // Discover today's meal periods
    // ---------------------------------------------------------------

    const discoveredPeriods =
      await discoverMealPeriods(
        page,
        debug
      );

    // If dropdown discovery works, use those periods.
    // If not, scrape the currently visible menu.
    let periodsToday =
      discoveredPeriods;

    if (!periodsToday.length) {
      periodsToday = [];
    }

    const mealPeriods = {};
    let allItems = [];

    // ---------------------------------------------------------------
    // If meal dropdown exists, scrape every period.
    // ---------------------------------------------------------------

    if (periodsToday.length) {
      for (const period of periodsToday) {
        console.log(
          `\n--- Switching to ${period} ---`
        );

        const clicked =
          await clickMealPeriod(
            page,
            period
          );

        if (!clicked) {
          console.log(
            `[${period}] Could not switch to this period.`
          );
          continue;
        }

        const items =
          await scrapeOnePeriod(
            page,
            period,
            debug,
            nutritionCache
          );

        if (items.length) {
          mealPeriods[period] =
            items;

          allItems =
            allItems.concat(items);
        }

        // Save cache after each period.
        saveNutritionCache(
          nutritionCache
        );
      }
    }

    // ---------------------------------------------------------------
    // Fallback: scrape whatever is currently visible.
    // ---------------------------------------------------------------

    if (
      Object.keys(mealPeriods)
        .length === 0
    ) {
      console.log(
        "\nNo usable meal periods found. Scraping visible menu."
      );

      const items =
        await scrapeOnePeriod(
          page,
          "Menu",
          debug,
          nutritionCache
        );

      if (items.length) {
        mealPeriods.Menu =
          items;

        allItems = items;
      }

      saveNutritionCache(
        nutritionCache
      );
    }

    // ---------------------------------------------------------------
    // Preserve today's successful periods if a later period fails.
    // ---------------------------------------------------------------

    const localDate =
      new Intl.DateTimeFormat(
        "en-CA",
        {
          timeZone:
            "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }
      ).format(new Date());

    let previous = null;

    try {
      const cachePath =
        path.join(
          SCRAPER_DATA_DIR,
          "menu-cache.json"
        );

      if (
        fs.existsSync(cachePath)
      ) {
        previous = JSON.parse(
          fs.readFileSync(
            cachePath,
            "utf-8"
          )
        );
      }
    } catch (_) {}

    if (
      previous?.menuDate ===
        localDate &&
      previous?.mealPeriods
    ) {
      for (const [
        period,
        oldItems,
      ] of Object.entries(
        previous.mealPeriods
      )) {
        if (
          !mealPeriods[period]
            ?.length &&
          Array.isArray(oldItems) &&
          oldItems.length
        ) {
          mealPeriods[period] =
            oldItems;
        }
      }
    }

    allItems =
      Object.values(
        mealPeriods
      ).flat();

    // ---------------------------------------------------------------
    // Deduplicate
    // ---------------------------------------------------------------

    const deduped =
      new Map();

    for (const item of allItems) {
      const key =
        item.name
          .trim()
          .toLowerCase();

      if (!deduped.has(key)) {
        deduped.set(
          key,
          item
        );
      }
    }

    const result = {
      scrapedAt:
        new Date().toISOString(),

      menuDate:
        localDate,

      mealPeriods,

      stations: [
        {
          name: "All Items",
          items:
            Array.from(
              deduped.values()
            ),
        },
      ],
    };

    console.log(
      `\nDone. Total items across all periods: ${allItems.length}`
    );

    return result;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// DIRECT EXECUTION
// ---------------------------------------------------------------------------

if (require.main === module) {
  const debug =
    process.argv.includes(
      "--debug"
    );

  scrapeMenu({ debug })
    .then((result) => {
      if (
        !fs.existsSync(
          SCRAPER_DATA_DIR
        )
      ) {
        fs.mkdirSync(
          SCRAPER_DATA_DIR,
          {
            recursive: true,
          }
        );
      }

      fs.writeFileSync(
        path.join(
          SCRAPER_DATA_DIR,
          "menu-cache.json"
        ),
        JSON.stringify(
          result,
          null,
          2
        )
      );

      console.log(
        `Done. Scraped ${result.stations.reduce(
          (total, station) =>
            total +
            station.items.length,
          0
        )} items.`
      );

      console.log(
        "Saved to data/menu-cache.json"
      );
    })
    .catch((err) => {
      console.error(
        "Scrape failed:",
        err
      );

      process.exit(1);
    });
}

module.exports = {
  scrapeMenu,
  MENU_URL,
};
