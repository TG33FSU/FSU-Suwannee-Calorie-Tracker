// server.js
const express = require("express");
const path = require("path");
const db = require("./db");
const { scrapeMenu } = require("./scraper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Express 4 doesn't automatically catch rejected Promises thrown inside
// async route handlers — an uncaught one becomes an unhandled rejection,
// and Node's default behavior since v15 is to crash the whole process on
// those. That's especially risky now that routes talk to MongoDB, which can
// fail for reasons outside our control (bad connection string, a momentary
// network blip, IP not allowlisted in Atlas). This wrapper ensures any
// rejection becomes a normal 500 response instead of taking the entire app
// down for every other user's request too.
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// ---------- Menu ----------

// Get the cached menu (whatever was last scraped)
app.get("/api/menu", asyncHandler(async (req, res) => {
  res.json(await db.getMenuCache());
}));

// Trigger a fresh scrape. This can take ~15-30s since it drives a real
// headless browser against the live site.
let scrapeInProgress = false;
app.post("/api/menu/refresh", asyncHandler(async (req, res) => {
  if (scrapeInProgress) {
    return res.status(409).json({ error: "A scrape is already in progress." });
  }
  scrapeInProgress = true;
  try {
    const menu = await scrapeMenu({ debug: false });
    await db.saveMenuCache(menu);
    res.json(menu);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Scrape failed. Check server logs. You can still add custom foods manually." });
  } finally {
    scrapeInProgress = false;
  }
}));

// ---------- Ratings ("Your Favorites") ----------

app.get("/api/ratings", asyncHandler(async (req, res) => {
  res.json(await db.getRatings());
}));

app.post("/api/ratings", asyncHandler(async (req, res) => {
  const { name, stars, tags, calories, protein, totalCarbs, totalFat, servingSize } = req.body;
  const s = Number(stars);
  if (!name || !Number.isFinite(s) || s < 1 || s > 5) {
    return res.status(400).json({ error: "name and stars (1-5) are required" });
  }
  const nutritionSnapshot = {
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    servingSize: servingSize || "1 serving",
  };
  const updated = await db.upsertRating(name, s, tags || {}, nutritionSnapshot);
  res.status(201).json(updated);
}));

// ---------- Custom foods (user-created, reusable across days) ----------

app.get("/api/custom-foods", asyncHandler(async (req, res) => {
  res.json(await db.getCustomFoods());
}));

app.post("/api/custom-foods", asyncHandler(async (req, res) => {
  const { name, calories, protein, totalCarbs, totalFat, servingSize } = req.body;
  if (!name || calories == null) {
    return res.status(400).json({ error: "name and calories are required" });
  }
  const foods = await db.getCustomFoods();
  const food = {
    id: `custom_${Date.now()}`,
    name,
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    servingSize: servingSize || "1 serving",
  };
  foods.push(food);
  await db.saveCustomFoods(foods);
  res.status(201).json(food);
}));

app.delete("/api/custom-foods/:id", asyncHandler(async (req, res) => {
  const foods = (await db.getCustomFoods()).filter((f) => f.id !== req.params.id);
  await db.saveCustomFoods(foods);
  res.json({ ok: true });
}));

// ---------- Diary ----------

// date format: YYYY-MM-DD
app.get("/api/diary/:date", asyncHandler(async (req, res) => {
  res.json(await db.getDayEntry(req.params.date));
}));

app.post("/api/diary/:date/:meal", asyncHandler(async (req, res) => {
  const { date, meal } = req.params;
  const validMeals = ["breakfast", "lunch", "dinner", "snacks"];
  if (!validMeals.includes(meal)) {
    return res.status(400).json({ error: `meal must be one of ${validMeals.join(", ")}` });
  }
  const {
    name,
    calories,
    protein,
    totalCarbs,
    totalFat,
    saturatedFat,
    transFat,
    cholesterol,
    sugars,
    addedSugars,
    fiber,
    sodium,
    servings,
    servingSize,
    source,
  } = req.body;
  if (!name || calories == null) {
    return res.status(400).json({ error: "name and calories are required" });
  }

  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    servings: Number(servings) || 1,
    servingSize: servingSize || "1 serving",
    calories: Number(calories) || 0,
    protein: Number(protein) || 0,
    totalCarbs: Number(totalCarbs) || 0,
    totalFat: Number(totalFat) || 0,
    saturatedFat: Number(saturatedFat) || 0,
    transFat: Number(transFat) || 0,
    cholesterol: Number(cholesterol) || 0,
    sugars: Number(sugars) || 0,
    addedSugars: Number(addedSugars) || 0,
    fiber: Number(fiber) || 0,
    sodium: Number(sodium) || 0,
    source: source || "manual", // "menu" | "custom" | "manual"
    loggedAt: new Date().toISOString(),
  };

  const day = await db.getDayEntry(date);
  day[meal].push(entry);
  await db.saveDayEntry(date, day);
  res.status(201).json(entry);
}));

app.delete("/api/diary/:date/:meal/:entryId", asyncHandler(async (req, res) => {
  const { date, meal, entryId } = req.params;
  const day = await db.getDayEntry(date);
  if (!day[meal]) return res.status(400).json({ error: "invalid meal" });
  day[meal] = day[meal].filter((e) => e.id !== entryId);
  await db.saveDayEntry(date, day);
  res.json({ ok: true });
}));

// ---------- Settings (daily goals) ----------

app.get("/api/settings", asyncHandler(async (req, res) => {
  res.json(await db.getSettings());
}));

app.post("/api/settings", asyncHandler(async (req, res) => {
  const current = await db.getSettings();
  const updated = { ...current, ...req.body };
  await db.saveSettings(updated);
  res.json(updated);
}));

const os = require("os");

function getLanUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        urls.push(`http://${net.address}:${port}`);
      }
    }
  }
  return urls;
}

// Catches errors passed via next(err) — including anything asyncHandler
// forwards from a rejected route — and returns clean JSON instead of
// Express's default HTML error page, without crashing the process.
app.use((err, req, res, next) => {
  console.error("Request error:", err);
  res.status(500).json({ error: "Something went wrong on the server. Check the server logs for details." });
});

app.listen(PORT, () => {
  console.log(`\nDining Hall Calorie Tracker running at http://localhost:${PORT}`);
  const lanUrls = getLanUrls(PORT);
  if (lanUrls.length > 0) {
    console.log(`\nOn your phone (same WiFi as this computer), open:`);
    lanUrls.forEach((u) => console.log(`  ${u}`));
    console.log("");
  }
});
