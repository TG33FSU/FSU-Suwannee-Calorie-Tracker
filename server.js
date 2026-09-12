// server.js
const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const db = require("./db");

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

// Trigger a fresh scrape. A full sync (breakfast/lunch/dinner, ~80-200+
// items) can take a few minutes, which is far longer than a normal HTTP
// request is allowed to stay open — Render's proxy (and most hosts) will
// kill it with a 502 well before Puppeteer finishes, even though the scrape
// itself is still running fine in the background. So instead of holding one
// request open for the whole scrape, this kicks off the job and returns
// immediately; the frontend polls /api/menu/refresh/status for progress.
let scrapeState = { inProgress: false, error: null, startedAt: null, finishedAt: null };

app.post("/api/menu/refresh", asyncHandler(async (req, res) => {
  if (scrapeState.inProgress) {
    return res.status(409).json({ error: "A scrape is already in progress.", ...scrapeState });
  }
  scrapeState = { inProgress: true, error: null, startedAt: new Date().toISOString(), finishedAt: null };
  res.status(202).json({ status: "started" });

  // Runs scraper.js as a completely separate OS process instead of calling
  // it in-process. Headless Chrome is heavy on both CPU and memory, and on
  // a constrained free-tier instance that was apparently starving this
  // same Node process of the CPU time it needed to answer other requests
  // (like the status poll below) — even though nothing had technically
  // crashed, requests could still time out at the proxy. Isolating it in
  // its own process means the server answering HTTP requests never shares
  // an event loop with the scrape, so it stays responsive regardless of how
  // much resource Chrome eats. It also means if the scraper process gets
  // OOM-killed, only it dies — this server keeps running and just reports
  // the failure cleanly instead of taking the whole app down with it.
  const child = spawn("node", ["scraper.js"], { cwd: __dirname });

  child.stdout.on("data", (d) => process.stdout.write(`[scraper] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[scraper] ${d}`));

  child.on("error", (err) => {
    console.error("Failed to start scraper process:", err);
    scrapeState = {
      inProgress: false,
      error: `Couldn't start the scraper process: ${err.message}`,
      startedAt: scrapeState.startedAt,
      finishedAt: new Date().toISOString(),
    };
  });

  child.on("close", async (code) => {
    if (code !== 0) {
      console.error(`Scraper process exited with code ${code}`);
      scrapeState = {
        inProgress: false,
        error: "Scrape process failed or ran out of resources. You can still add custom foods manually.",
        startedAt: scrapeState.startedAt,
        finishedAt: new Date().toISOString(),
      };
      return;
    }
    try {
      const menuPath = path.join(__dirname, "data", "menu-cache.json");
      const menu = JSON.parse(fs.readFileSync(menuPath, "utf-8"));
      await db.saveMenuCache(menu);
      scrapeState = { inProgress: false, error: null, startedAt: scrapeState.startedAt, finishedAt: new Date().toISOString() };
    } catch (err) {
      console.error("Scrape finished but its result couldn't be read/saved:", err);
      scrapeState = {
        inProgress: false,
        error: `Scrape finished but the result couldn't be saved: ${err.message}`,
        startedAt: scrapeState.startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
  });
}));

app.get("/api/menu/refresh/status", (req, res) => {
  res.json(scrapeState);
});

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
