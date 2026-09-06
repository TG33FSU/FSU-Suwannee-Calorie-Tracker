// db.js
// Tiny zero-dependency JSON-file "database". No SQLite/native modules required,
// which keeps the app trivially installable on any machine (important for a
// dorm-room laptop that may not have build tools for native npm packages).

const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MENU_FILE = path.join(DATA_DIR, "menu-cache.json");
const DIARY_FILE = path.join(DATA_DIR, "diary.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CUSTOM_FOODS_FILE = path.join(DATA_DIR, "custom-foods.json");
const RATINGS_FILE = path.join(DATA_DIR, "ratings.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDataDir();
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to read ${file}, using fallback.`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---- Menu cache (scraped items) ----
function getMenuCache() {
  return readJson(MENU_FILE, { scrapedAt: null, stations: [] });
}
function saveMenuCache(menu) {
  writeJson(MENU_FILE, menu);
}

// ---- Ratings: personal taste ratings, keyed by normalized food name.
// { "grilled chicken": { name, avgStars, ratingCount, tags: {...}, lastNutrition: {...} } }
function getRatings() {
  return readJson(RATINGS_FILE, {});
}
function saveRatings(ratings) {
  writeJson(RATINGS_FILE, ratings);
}

const TAG_KEYS = ["wouldEatAgain", "greatProtein", "worthGetting", "skipIt"];

function upsertRating(name, stars, tags, nutritionSnapshot) {
  const ratings = getRatings();
  const key = name.trim().toLowerCase();
  const existing = ratings[key] || {
    name: name.trim(),
    avgStars: 0,
    ratingCount: 0,
    tags: { wouldEatAgain: 0, greatProtein: 0, worthGetting: 0, skipIt: 0 },
    lastNutrition: {},
  };

  const newCount = existing.ratingCount + 1;
  const newAvg = (existing.avgStars * existing.ratingCount + stars) / newCount;

  const updatedTags = { ...existing.tags };
  TAG_KEYS.forEach((t) => {
    if (tags && tags[t]) updatedTags[t] = (updatedTags[t] || 0) + 1;
  });

  ratings[key] = {
    name: name.trim(),
    avgStars: newAvg,
    ratingCount: newCount,
    tags: updatedTags,
    lastNutrition: nutritionSnapshot || existing.lastNutrition,
  };

  saveRatings(ratings);
  return ratings[key];
}

// ---- Custom foods (user-entered, reusable) ----
function getCustomFoods() {
  return readJson(CUSTOM_FOODS_FILE, []);
}
function saveCustomFoods(foods) {
  writeJson(CUSTOM_FOODS_FILE, foods);
}

// ---- Diary: { "2026-09-04": { breakfast: [entry,...], lunch: [...], dinner: [...], snacks: [...] } }
function getDiary() {
  return readJson(DIARY_FILE, {});
}
function saveDiary(diary) {
  writeJson(DIARY_FILE, diary);
}
function getDayEntry(date) {
  const diary = getDiary();
  return diary[date] || { breakfast: [], lunch: [], dinner: [], snacks: [] };
}
function saveDayEntry(date, dayData) {
  const diary = getDiary();
  diary[date] = dayData;
  saveDiary(diary);
}

// ---- Settings (daily goals) ----
function getSettings() {
  return readJson(SETTINGS_FILE, {
    calorieGoal: 0,
    proteinGoal: 0,
    carbGoal: 0,
    fatGoal: 0,
  });
}
function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings);
}

module.exports = {
  getMenuCache,
  saveMenuCache,
  getCustomFoods,
  saveCustomFoods,
  getRatings,
  saveRatings,
  upsertRating,
  getDiary,
  saveDiary,
  getDayEntry,
  saveDayEntry,
  getSettings,
  saveSettings,
};
