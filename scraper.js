// scraper.js
//
// Suwannee Room menu scraper
// Finds food items from the rendered menu without requiring an "Add" button.

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

// ------------------------------------------------------------
// NUTRITION CACHE
// ------------------------------------------------------------

function loadNutritionCache() {
  try {
    if (!fs.existsSync(NUTRITION_CACHE_FILE)) return {};

    const raw = fs.readFileSync(NUTRITION_CACHE_FILE, "utf8");

    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.warn(
      "Could not read nutrition cache:",
      err.message
    );

    return {};
  }
}

function saveNutritionCache(cache) {
  if (!fs.existsSync(SCRAPER_DATA_DIR)) {
    fs.mkdirSync(SCRAPER_DATA_DIR, {
      recursive: true,
    });
  }

  fs.writeFileSync(
    NUTRITION_CACHE_FILE,
    JSON.stringify(cache, null, 2),
    "utf8"
  );
}

// ------------------------------------------------------------
// STATIONS / UI TEXT
// ------------------------------------------------------------

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

const EXCLUDE_PATTERNS = [
  /^add$/i,
  /^sign in$/i,
  /^sign out$/i,
  /^log in$/i,
  /^log out$/i,
  /^loading/i,
  /^view more$/i,
  /^view less$/i,
  /^view menu$/i,
  /^add to favorites$/i,
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
  /^print$/i,
  /^meal\s*:/i,
  /^view\s*:/i,
  /^join$/i,
  /^\d+\s*items?.*cal/i,
];

function cleanFoodName(name) {
  return String(name || "")
    .replace(/\s+/g, " ")
    .replace(/^[-•·]+\s*/, "")
    .trim();
}

function isBadName(name) {
  const n = cleanFoodName(name).toLowerCase();

  if (!n) return true;
  if (n.length < 2) return true;
  if (n.length > 120) return true;

  if (KNOWN_STATIONS.has(n)) return true;

  return EXCLUDE_PATTERNS.some((re) =>
    re.test(cleanFoodName(name))
  );
}

// ------------------------------------------------------------
// MEAL PERIODS
// ------------------------------------------------------------

async function openMealDropdown(page) {
  return page.evaluate(() => {
    const elements = Array.from(
      document.querySelectorAll(
        "button, [role='button'], a"
      )
    );

    const button = elements.find((el) => {
      const text = (el.textContent || "").trim();

      return (
        el.offsetParent !== null &&
        /^meal\s*:/i.test(text)
      );
    });

    if (!button) return false;

    button.click();

    return true;
  });
}

async function getMealDropdownOptions(page) {
  return page.evaluate(() => {
    const selectors = [
      "[role='option']",
      "[role='menuitem']",
      "[role='listbox'] li",
      "[role='listbox'] button",
      "ul[class*='dropdown'] li",
      "ul[class*='menu'] li",
      "[class*='dropdown'] [class*='option']",
      "[class*='dropdown'] [class*='item']",
    ];

    for (const selector of selectors) {
      const elements = Array.from(
        document.querySelectorAll(selector)
      ).filter((el) => el.offsetParent !== null);

      const values = elements
        .map((el) => (el.textContent || "").trim())
        .filter(
          (text) =>
            text &&
            text.length < 50 &&
            !/^meal\s*:/i.test(text)
        );

      if (values.length) {
        return [...new Set(values)];
      }
    }

    return [];
  });
}

async function discoverMealPeriods(page) {
  const opened = await openMealDropdown(page);

  if (!opened) {
    console.log(
      "[Meal] Could not find meal dropdown."
    );

    return [];
  }

  await new Promise((resolve) =>
    setTimeout(resolve, 300)
  );

  const options =
    await getMealDropdownOptions(page);

  await page.keyboard
    .press("Escape")
    .catch(() => {});

  await new Promise((resolve) =>
    setTimeout(resolve, 200)
  );

  console.log(
    `[Meal] Found periods: ${
      options.length
        ? options.join(", ")
        : "NONE"
    }`
  );

  return options;
}

async function selectMealPeriod(page, period) {
  const opened = await openMealDropdown(page);

  if (!opened) return false;

  await new Promise((resolve) =>
    setTimeout(resolve, 300)
  );

  const selected = await page.evaluate(
    (wanted) => {
      const selectors = [
        "[role='option']",
        "[role='menuitem']",
        "[role='listbox'] li",
        "[role='listbox'] button",
        "ul[class*='dropdown'] li",
        "ul[class*='menu'] li",
        "[class*='dropdown'] [class*='option']",
        "[class*='dropdown'] [class*='item']",
      ];

      for (const selector of selectors) {
        const elements = Array.from(
          document.querySelectorAll(selector)
        );

        const match = elements.find(
          (el) =>
            (el.textContent || "")
              .trim()
              .toLowerCase() ===
            wanted.toLowerCase()
        );

        if (match) {
          match.click();
          return true;
        }
      }

      return false;
    },
    period
  );

  if (!selected) {
    await page.keyboard
      .press("Escape")
      .catch(() => {});
  }

  return selected;
}

// ------------------------------------------------------------
// WAITING / MENU RENDERING
// ------------------------------------------------------------

async function waitForMenu(page, timeout = 15000) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const state = await page.evaluate(() => {
      const body = document.body?.innerText || "";

      const hasCalories =
        /\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/i.test(
          body
        );

      const hasMeal =
        /meal\s*:/i.test(body);

      const hasFoodLikeHeading =
        Array.from(
          document.querySelectorAll(
            "h1,h2,h3,h4,h5,h6"
          )
        ).some((el) => {
          const text = (el.textContent || "").trim();

          return (
            el.offsetParent !== null &&
            text.length > 2 &&
            text.length < 100
          );
        });

      return {
        hasCalories,
        hasMeal,
        hasFoodLikeHeading,
      };
    });

    if (
      state.hasCalories &&
      (state.hasMeal ||
        state.hasFoodLikeHeading)
    ) {
      return true;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 300)
    );
  }

  return false;
}

async function waitForMenuAfterSwitch(
  page,
  previousText,
  timeout = 10000
) {
  const started = Date.now();

  while (Date.now() - started < timeout) {
    const currentText = await page.evaluate(
      () => document.body?.innerText || ""
    );

    const hasCalories =
      /\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/i.test(
        currentText
      );

    if (
      hasCalories &&
      currentText !== previousText
    ) {
      return true;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 300)
    );
  }

  return false;
}

// ------------------------------------------------------------
// EXPAND STATIONS
// ------------------------------------------------------------

async function expandAllStations(page) {
  for (let round = 0; round < 10; round++) {
    const clicked = await page.evaluate(() => {
      const elements = Array.from(
        document.querySelectorAll(
          "button, a, [role='button']"
        )
      );

      const buttons = elements.filter((el) => {
        return (
          el.offsetParent !== null &&
          /^view\s+more$/i.test(
            (el.textContent || "").trim()
          )
        );
      });

      buttons.forEach((button) => {
        button.click();
      });

      return buttons.length;
    });

    if (!clicked) break;

    await new Promise((resolve) =>
      setTimeout(resolve, 500)
    );
  }
}

// ------------------------------------------------------------
// FOOD EXTRACTION
// ------------------------------------------------------------
//
// IMPORTANT:
//
// This does NOT require an "Add" button.
//
// Instead, it searches the rendered page for calorie values,
// then walks upward to find the closest reasonable food-card
// container and extracts a nearby name.
//

async function extractVisibleFoodCards(
  page,
  debug = false
) {
  const foods = await page.evaluate(
    ({ stations, excludeSources }) => {
      const stationSet = new Set(stations);

      const excludes = excludeSources.map(
        ([source, flags]) =>
          new RegExp(source, flags)
      );

      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      const visible = (el) => {
        if (!el) return false;

        const style =
          window.getComputedStyle(el);

        const rect =
          el.getBoundingClientRect();

        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      };

      const badName = (name) => {
        const normalized =
          normalize(name).toLowerCase();

        if (!normalized) return true;
        if (normalized.length < 2) return true;
        if (normalized.length > 120) return true;

        if (stationSet.has(normalized)) {
          return true;
        }

        return excludes.some((re) =>
          re.test(normalize(name))
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
          .replace(/\s{2,}/g, " ")
          .trim();

      const calorieElements = Array.from(
        document.querySelectorAll("body *")
      ).filter((el) => {
        if (!visible(el)) return false;

        const text = normalize(
          el.innerText || el.textContent
        );

        if (!text) return false;

        if (
          text.length > 1000 &&
          el.children.length > 10
        ) {
          return false;
        }

        return /\b\d+(?:\.\d+)?\s*(?:calories|cals?)\b/i.test(
          text
        );
      });

      const output = [];
      const seen = new Set();

      for (const calorieElement of calorieElements) {
        let node = calorieElement;

        let best = null;

        for (
          let depth = 0;
          node && depth < 10;
          depth++,
          node = node.parentElement
        ) {
          if (!visible(node)) continue;

          const text = normalize(
            node.innerText || node.textContent
          );

          if (
            text.length < 8 ||
            text.length > 700
          ) {
            continue;
          }

          const calorieMatch =
            text.match(
              /\b(\d+(?:\.\d+)?)\s*(?:calories|cals?)\b/i
            );

          if (!calorieMatch) continue;

          const lines = [
            ...new Set(
              String(node.innerText || "")
                .split(/\n+/)
                .map(cleanLine)
                .filter(Boolean)
            ),
          ];

          const headingNames = Array.from(
            node.querySelectorAll(
              "h1,h2,h3,h4,h5,h6,[role='heading'],strong,b,a"
            )
          )
            .filter(visible)
            .map((el) =>
              cleanLine(el.textContent)
            )
            .filter(
              (name) =>
                name &&
                name.length <= 100 &&
                !badName(name)
            );

          const candidates = [
            ...new Set([
              ...headingNames,
              ...lines,
            ]),
          ]
            .filter((name) => !badName(name))
            .filter(
              (name) =>
                !/^\d+(?:\.\d+)?$/.test(name)
            )
            .filter(
              (name) =>
                !/^(calories?|nutrition|add|view more|view less)$/i.test(
                  name
                )
            )
            .filter((name) => name.length <= 100);

          if (!candidates.length) {
            continue;
          }

          let name =
            candidates.find(
              (candidate) =>
                headingNames.includes(candidate) &&
                candidate.length >= 2
            ) ||
            candidates.find(
              (candidate) =>
                candidate.length >= 2 &&
                candidate.length <= 80
            );

          if (!name) continue;

          const score =
            (headingNames.includes(name)
              ? 50
              : 0) -
            depth * 8 -
            Math.max(
              0,
              text.length - 250
            ) *
              0.05;

          if (!best || score > best.score) {
            best = {
              name,
              calories: Number(
                calorieMatch[1]
              ),
              score,
            };
          }
        }

        if (!best) continue;
        if (badName(best.name)) continue;

        const key =
          best.name.toLowerCase();

        if (seen.has(key)) continue;

        seen.add(key);

        output.push({
          name: best.name,
          calories: best.calories,
        });
      }

      return output;
    },
    {
      stations: Array.from(KNOWN_STATIONS),
      excludeSources:
        EXCLUDE_PATTERNS.map((re) => [
          re.source,
          re.flags,
        ]),
    }
  );

  if (debug) {
    console.log(
      `[Extractor] Found ${foods.length} foods`
    );
  }

  return foods;
}

// ------------------------------------------------------------
// SCRAPE ONE PERIOD
// ------------------------------------------------------------

async function scrapeOnePeriod(
  page,
  period,
  nutritionCache,
  debug
) {
  await expandAllStations(page);

  const extracted =
    await extractVisibleFoodCards(
      page,
      debug
    );

  console.log(
    `[${period}] Found ${extracted.length} food items.`
  );

  const items = [];

  let cacheHits = 0;
  let fresh = 0;

  for (const food of extracted) {
    const name = food.name;

    const key =
      name.trim().toLowerCase();

    const cached =
      nutritionCache[key];

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

      nutritionCache[key] =
        baseNutrition;

      fresh++;
    }
  }

  console.log(
    `[${period}] Captured ${
      items.filter(
        (item) =>
          item.calories != null
      ).length
    } / ${items.length} items ` +
      `(${cacheHits} cached, ${fresh} new).`
  );

  return items;
}

// ------------------------------------------------------------
// MAIN SCRAPER
// ------------------------------------------------------------

async function scrapeMenu({
  debug = false,
} = {}) {
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
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Safari/537.36"
    );

    console.log(
      `Navigating to ${MENU_URL} ...`
    );

    await page.goto(MENU_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const menuReady =
      await waitForMenu(
        page,
        15000
      );

    console.log(
      `[Menu] Initial menu ready: ${menuReady}`
    );

    if (!menuReady) {
      console.warn(
        "[Menu] Menu did not become ready within 15 seconds."
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 1000)
    );

    // --------------------------------------------------------
    // DEBUG
    // --------------------------------------------------------

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
        "utf8"
      );

      console.log(
        "Saved rendered HTML to data/debug-page.html"
      );
    }

    // --------------------------------------------------------
    // CACHE
    // --------------------------------------------------------

    const nutritionCache =
      loadNutritionCache();

    // --------------------------------------------------------
    // MEAL PERIODS
    // --------------------------------------------------------

    let periods =
      await discoverMealPeriods(
        page
      );

    // If dropdown detection fails, try common periods.
    if (!periods.length) {
      periods = [
        "Breakfast",
        "Brunch",
        "Lunch",
        "Dinner",
      ];

      console.log(
        "[Meal] Falling back to common meal periods."
      );
    }

    const mealPeriods = {};

    // --------------------------------------------------------
    // SCRAPE PERIODS
    // --------------------------------------------------------

    for (const period of periods) {
      console.log(
        `\n--- Switching to ${period} ---`
      );

      const beforeText =
        await page.evaluate(
          () =>
            document.body?.innerText ||
            ""
        );

      const switched =
        await selectMealPeriod(
          page,
          period
        );

      if (!switched) {
        console.log(
          `[${period}] Could not select this period — skipping.`
        );

        continue;
      }

      await waitForMenuAfterSwitch(
        page,
        beforeText,
        10000
      );

      // Give React/Vue time to finish replacing
      // the old meal's DOM.
      await new Promise((resolve) =>
        setTimeout(resolve, 1000)
      );

      const items =
        await scrapeOnePeriod(
          page,
          period,
          nutritionCache,
          debug
        );

      if (items.length > 0) {
        mealPeriods[period] =
          items;
      }

      saveNutritionCache(
        nutritionCache
      );
    }

    // --------------------------------------------------------
    // FALLBACK: WHATEVER IS CURRENTLY VISIBLE
    // --------------------------------------------------------

    if (
      Object.keys(mealPeriods)
        .length === 0
    ) {
      console.log(
        "\nNo meal periods produced items. " +
          "Trying the currently visible menu."
      );

      const items =
        await scrapeOnePeriod(
          page,
          "Menu",
          nutritionCache,
          debug
        );

      if (items.length > 0) {
        mealPeriods.Menu =
          items;
      }

      saveNutritionCache(
        nutritionCache
      );
    }

    // --------------------------------------------------------
    // DIAGNOSTICS IF STILL ZERO
    // --------------------------------------------------------

    if (
      Object.keys(mealPeriods)
        .length === 0
    ) {
      const diagnostic =
        await page.evaluate(() => {
          const body =
            document.body?.innerText ||
            "";

          const controls =
            Array.from(
              document.querySelectorAll(
                "button,a,[role='button']"
              )
            )
              .filter(
                (el) =>
                  el.offsetParent !== null
              )
              .map((el) =>
                (el.textContent || "")
                  .trim()
              )
              .filter(Boolean)
              .slice(0, 100);

          return {
            bodyPreview:
              body.slice(0, 5000),
            controls,
          };
        });

      console.warn(
        "\n========== ZERO ITEMS DIAGNOSTIC =========="
      );

      console.warn(
        diagnostic.bodyPreview
      );

      console.warn(
        "Visible controls:",
        diagnostic.controls
      );

      console.warn(
        "===========================================\n"
      );
    }

    // --------------------------------------------------------
    // DATE
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // PRESERVE SAME-DAY GOOD CACHE
    // --------------------------------------------------------

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
            "utf8"
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

    // --------------------------------------------------------
    // FLAT LIST FOR OLD APP CODE
    // --------------------------------------------------------

    const allItems =
      Object.values(
        mealPeriods
      ).flat();

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

// ------------------------------------------------------------
// DIRECT EXECUTION
// ------------------------------------------------------------

if (
  require.main === module
) {
  const debug =
    process.argv.includes(
      "--debug"
    );

  scrapeMenu({
    debug,
  })
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
        ),
        "utf8"
      );

      const count =
        result.stations.reduce(
          (total, station) =>
            total +
            station.items.length,
          0
        );

      console.log(
        `Done. Scraped ${count} items.`
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
