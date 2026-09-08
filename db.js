// db.js
//
// Two storage backends behind one identical async API, so server.js never
// needs to know or care which one is active:
//
//   - Local JSON files (default). Zero setup — this is what runs when you
//     `npm start` on your own laptop. Nothing persists beyond your machine.
//   - MongoDB Atlas (when a MONGODB_URI environment variable is set). This
//     is what you want on a host like Render, whose filesystem is wiped on
//     every redeploy/restart — a real database elsewhere keeps your diary,
//     ratings, and goals intact regardless of what happens to the container.
//
// Every exported function returns a Promise either way, so calling code
// always does `await db.getSettings()` etc., whether or not Mongo is
// actually involved.

const fs = require("fs");
const path = require("path");

const USE_MONGO = !!process.env.MONGODB_URI;

const DEFAULT_SETTINGS = { calorieGoal: 0, proteinGoal: 0, carbGoal: 0, fatGoal: 0 };
const DEFAULT_MENU = { scrapedAt: null, stations: [] };
const TAG_KEYS = ["wouldEatAgain", "greatProtein", "worthGetting", "skipIt"];

function emptyDay() {
  return { breakfast: [], lunch: [], dinner: [], snacks: [] };
}

// ---------------------------------------------------------------------------
// Backend 1: local JSON files
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, "data");
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

const fileBackend = {
  async getSettings() {
    return readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  },
  async saveSettings(settings) {
    writeJson(SETTINGS_FILE, settings);
  },
  async getMenuCache() {
    return readJson(MENU_FILE, DEFAULT_MENU);
  },
  async saveMenuCache(menu) {
    writeJson(MENU_FILE, menu);
  },
  async getCustomFoods() {
    return readJson(CUSTOM_FOODS_FILE, []);
  },
  async saveCustomFoods(foods) {
    writeJson(CUSTOM_FOODS_FILE, foods);
  },
  async getRatings() {
    return readJson(RATINGS_FILE, {});
  },
  async saveRatings(ratings) {
    writeJson(RATINGS_FILE, ratings);
  },
  async getDiary() {
    return readJson(DIARY_FILE, {});
  },
  async saveDiary(diary) {
    writeJson(DIARY_FILE, diary);
  },
};

// ---------------------------------------------------------------------------
// Backend 2: MongoDB Atlas
// ---------------------------------------------------------------------------

let mongoDbPromise = null;
function getMongoDb() {
  if (!mongoDbPromise) {
    const { MongoClient } = require("mongodb");
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
    mongoDbPromise = client
      .connect()
      .then((c) => {
        console.log("Connected to MongoDB Atlas.");
        return c.db("dininghall_tracker");
      })
      .catch((err) => {
        console.error("MongoDB connection failed:", err.message);
        mongoDbPromise = null; // allow a retry on the next call instead of caching a dead connection
        throw err;
      });
  }
  return mongoDbPromise;
}

// Settings and menu cache are each a single document with a fixed _id, since
// there's only ever one of each (one user, one cached menu).
const mongoBackend = {
  async getSettings() {
    const db = await getMongoDb();
    const doc = await db.collection("settings").findOne({ _id: "singleton" });
    return doc ? { ...DEFAULT_SETTINGS, ...doc, _id: undefined } : DEFAULT_SETTINGS;
  },
  async saveSettings(settings) {
    const db = await getMongoDb();
    await db.collection("settings").replaceOne({ _id: "singleton" }, { _id: "singleton", ...settings }, { upsert: true });
  },
  async getMenuCache() {
    const db = await getMongoDb();
    const doc = await db.collection("menu_cache").findOne({ _id: "singleton" });
    return doc ? { ...doc, _id: undefined } : DEFAULT_MENU;
  },
  async saveMenuCache(menu) {
    const db = await getMongoDb();
    await db.collection("menu_cache").replaceOne({ _id: "singleton" }, { _id: "singleton", ...menu }, { upsert: true });
  },
  async getCustomFoods() {
    const db = await getMongoDb();
    const docs = await db.collection("custom_foods").find({}).toArray();
    return docs.map((d) => ({ ...d, _id: undefined }));
  },
  async saveCustomFoods(foods) {
    const db = await getMongoDb();
    const col = db.collection("custom_foods");
    await col.deleteMany({});
    if (foods.length > 0) await col.insertMany(foods.map((f) => ({ ...f })));
  },
  async getRatings() {
    const db = await getMongoDb();
    const docs = await db.collection("ratings").find({}).toArray();
    const ratings = {};
    docs.forEach((d) => {
      ratings[d._id] = { ...d, _id: undefined };
    });
    return ratings;
  },
  async saveRatings(ratings) {
    const db = await getMongoDb();
    const col = db.collection("ratings");
    await col.deleteMany({});
    const docs = Object.entries(ratings).map(([key, value]) => ({ _id: key, ...value }));
    if (docs.length > 0) await col.insertMany(docs);
  },
  async getDiary() {
    const db = await getMongoDb();
    const docs = await db.collection("diary").find({}).toArray();
    const diary = {};
    docs.forEach((d) => {
      diary[d._id] = { ...d, _id: undefined };
    });
    return diary;
  },
  async saveDiary(diary) {
    const db = await getMongoDb();
    const col = db.collection("diary");
    await col.deleteMany({});
    const docs = Object.entries(diary).map(([date, dayData]) => ({ _id: date, ...dayData }));
    if (docs.length > 0) await col.insertMany(docs);
  },
};

const backend = USE_MONGO ? mongoBackend : fileBackend;
if (USE_MONGO) {
  console.log("Storage backend: MongoDB Atlas (MONGODB_URI is set).");
} else {
  console.log("Storage backend: local JSON files in data/ (no MONGODB_URI set).");
}

// ---------------------------------------------------------------------------
// Public API — identical regardless of backend
// ---------------------------------------------------------------------------

async function getSettings() {
  return backend.getSettings();
}
async function saveSettings(settings) {
  return backend.saveSettings(settings);
}

async function getMenuCache() {
  return backend.getMenuCache();
}
async function saveMenuCache(menu) {
  return backend.saveMenuCache(menu);
}

async function getCustomFoods() {
  return backend.getCustomFoods();
}
async function saveCustomFoods(foods) {
  return backend.saveCustomFoods(foods);
}

async function getRatings() {
  return backend.getRatings();
}
async function saveRatings(ratings) {
  return backend.saveRatings(ratings);
}

async function upsertRating(name, stars, tags, nutritionSnapshot) {
  const ratings = await getRatings();
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

  await saveRatings(ratings);
  return ratings[key];
}

async function getDiary() {
  return backend.getDiary();
}
async function saveDiary(diary) {
  return backend.saveDiary(diary);
}
async function getDayEntry(date) {
  const diary = await getDiary();
  return diary[date] || emptyDay();
}
async function saveDayEntry(date, dayData) {
  const diary = await getDiary();
  diary[date] = dayData;
  await saveDiary(diary);
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
