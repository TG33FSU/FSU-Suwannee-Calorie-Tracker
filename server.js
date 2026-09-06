// server.js — public Suwannee Tracker service
const express = require("express");
const path = require("path");
const os = require("os");
const db = require("./db");
const { scrapeMenu } = require("./scraper");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const AUTO_SYNC_MS = Number(process.env.AUTO_SYNC_MS) || 4 * 60 * 60 * 1000;
const MANUAL_SYNC_COOLDOWN_MS = Number(process.env.MANUAL_SYNC_COOLDOWN_MS) || 10 * 60 * 1000;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));

app.get("/api/health", (req, res) => {
  const menu = db.getMenuCache();
  res.json({ ok: true, scrapedAt: menu.scrapedAt || null, syncing: scrapeInProgress });
});

let scrapeInProgress = false;
let lastManualSync = 0;

async function runSync(reason = "manual") {
  if (scrapeInProgress) return { skipped: true, reason: "already running" };
  scrapeInProgress = true;
  console.log(`[sync] Starting ${reason} menu sync...`);
  try {
    const menu = await scrapeMenu({ debug: false });
    const totalItems = Object.values(menu.mealPeriods || {}).reduce((n, items) => n + (Array.isArray(items) ? items.length : 0), 0);
    if (totalItems === 0) {
      throw new Error("Scraper returned zero menu items; keeping the last good cache.");
    }
    db.saveMenuCache(menu);
    console.log(`[sync] Finished ${reason} sync with ${totalItems} items.`);
    return menu;
  } finally {
    scrapeInProgress = false;
  }
}

app.get("/api/menu", (req, res) => res.json(db.getMenuCache()));

app.get("/api/menu/periods", (req, res) => {
  const cache = db.getMenuCache();
  res.json({ scrapedAt: cache.scrapedAt, mealPeriods: cache.mealPeriods || {} });
});

app.post("/api/menu/refresh", async (req, res) => {
  const now = Date.now();
  if (scrapeInProgress) return res.status(409).json({ error: "A menu sync is already running." });
  if (now - lastManualSync < MANUAL_SYNC_COOLDOWN_MS) {
    return res.json(db.getMenuCache());
  }
  lastManualSync = now;
  try {
    res.json(await runSync("manual"));
  } catch (err) {
    console.error("[sync] failed:", err);
    res.status(500).json({ error: "Menu sync failed. The last good menu remains available." });
  }
});

// The web app owns user-specific diary/settings/ratings in browser storage.
// These legacy endpoints remain available for backwards compatibility with
// older local versions, but production clients don't use them.
app.use("/api", (req, res, next) => {
  if (["/diary", "/settings", "/custom-foods", "/ratings"].some((p) => req.path.startsWith(p))) {
    return res.status(410).json({ error: "User data is stored privately in your browser in this public build." });
  }
  next();
});

function getLanUrls(port) {
  const nets = os.networkInterfaces();
  const urls = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nSuwannee Tracker listening on port ${PORT}`);
  const lanUrls = getLanUrls(PORT);
  if (lanUrls.length) lanUrls.forEach((u) => console.log(`Local network: ${u}`));

  // Warm the menu in the background after the server is reachable.
  const menu = db.getMenuCache();
  const stale = !menu.scrapedAt || (Date.now() - new Date(menu.scrapedAt).getTime() > AUTO_SYNC_MS);
  if (stale) runSync("startup").catch((err) => console.error("[sync] startup failed:", err));

  setInterval(() => {
    const current = db.getMenuCache();
    const isStale = !current.scrapedAt || (Date.now() - new Date(current.scrapedAt).getTime() > AUTO_SYNC_MS);
    if (isStale && !scrapeInProgress) runSync("scheduled").catch((err) => console.error("[sync] scheduled failed:", err));
  }, 15 * 60 * 1000).unref();
});
