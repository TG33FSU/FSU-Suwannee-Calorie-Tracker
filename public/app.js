// app.js — all client-side logic for the tracker. No build step, no framework:
// plain fetch() calls to the Express API in server.js.

const state = {
  date: todayStr(),
  settings: { calorieGoal: 0, proteinGoal: 0, carbGoal: 0, fatGoal: 0 },
  day: { breakfast: [], lunch: [], dinner: [], snacks: [] },
  menu: { stations: [] },
  customFoods: [],
  ratings: {},
  pendingMeal: null, // which meal the "add food" dialog is currently targeting
  pendingFood: null, // the food selected in the serving-picker step
};

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

// ---------------- API helpers ----------------

// Public deployment note: menu data is shared by everyone, but diary/goals/
// custom foods/ratings are stored in this browser. That keeps users isolated
// without forcing everyone to create an account just to use the tracker.
const LOCAL_KEYS = {
  diary: "suwanneeTracker.diary.v1",
  settings: "suwanneeTracker.settings.v1",
  customFoods: "suwanneeTracker.customFoods.v1",
  ratings: "suwanneeTracker.ratings.v1",
};

function localRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function localWrite(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function localDay(date) {
  const diary = localRead(LOCAL_KEYS.diary, {});
  return diary[date] || { breakfast: [], lunch: [], dinner: [], snacks: [] };
}
function localApi(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : null;
  const parts = path.split("?")[0].split("/").filter(Boolean);
  const resource = parts[1]; // api/<resource>/...

  if (resource === "diary") {
    const date = parts[2];
    if (method === "GET" && parts.length === 3) return localDay(date);
    if (method === "POST" && parts.length === 4) {
      const meal = parts[3];
      const day = localDay(date);
      const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: body.name,
        servings: Number(body.servings) || 1,
        servingSize: body.servingSize || "1 serving",
        calories: Number(body.calories) || 0,
        protein: Number(body.protein) || 0,
        totalCarbs: Number(body.totalCarbs) || 0,
        totalFat: Number(body.totalFat) || 0,
        saturatedFat: Number(body.saturatedFat) || 0,
        transFat: Number(body.transFat) || 0,
        cholesterol: Number(body.cholesterol) || 0,
        sugars: Number(body.sugars) || 0,
        addedSugars: Number(body.addedSugars) || 0,
        fiber: Number(body.fiber) || 0,
        sodium: Number(body.sodium) || 0,
        source: body.source || "manual",
        loggedAt: new Date().toISOString(),
      };
      day[meal] = day[meal] || [];
      day[meal].push(entry);
      const diary = localRead(LOCAL_KEYS.diary, {});
      diary[date] = day;
      localWrite(LOCAL_KEYS.diary, diary);
      return entry;
    }
    if (method === "DELETE" && parts.length === 5) {
      const meal = parts[3], entryId = parts[4];
      const day = localDay(date);
      day[meal] = (day[meal] || []).filter((e) => e.id !== entryId);
      const diary = localRead(LOCAL_KEYS.diary, {});
      diary[date] = day;
      localWrite(LOCAL_KEYS.diary, diary);
      return { ok: true };
    }
  }

  if (resource === "settings") {
    const fallback = { calorieGoal: 0, proteinGoal: 0, carbGoal: 0, fatGoal: 0 };
    if (method === "GET") return localRead(LOCAL_KEYS.settings, fallback);
    if (method === "POST") {
      const updated = { ...fallback, ...localRead(LOCAL_KEYS.settings, fallback), ...(body || {}) };
      localWrite(LOCAL_KEYS.settings, updated);
      return updated;
    }
  }

  if (resource === "custom-foods") {
    if (method === "GET") return localRead(LOCAL_KEYS.customFoods, []);
    if (method === "POST") {
      const foods = localRead(LOCAL_KEYS.customFoods, []);
      const food = {
        id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: body.name,
        calories: Number(body.calories) || 0,
        protein: Number(body.protein) || 0,
        totalCarbs: Number(body.totalCarbs) || 0,
        totalFat: Number(body.totalFat) || 0,
        servingSize: body.servingSize || "1 serving",
      };
      foods.push(food);
      localWrite(LOCAL_KEYS.customFoods, foods);
      return food;
    }
    if (method === "DELETE" && parts.length === 3) {
      const id = parts[2];
      localWrite(LOCAL_KEYS.customFoods, localRead(LOCAL_KEYS.customFoods, []).filter((f) => f.id !== id));
      return { ok: true };
    }
  }

  if (resource === "ratings") {
    if (method === "GET") return localRead(LOCAL_KEYS.ratings, {});
    if (method === "POST") {
      const ratings = localRead(LOCAL_KEYS.ratings, {});
      const name = String(body.name || "").trim();
      const key = name.toLowerCase();
      const stars = Number(body.stars);
      const existing = ratings[key] || {
        name,
        avgStars: 0,
        ratingCount: 0,
        tags: { wouldEatAgain: 0, greatProtein: 0, worthGetting: 0, skipIt: 0 },
        lastNutrition: {},
      };
      const count = existing.ratingCount + 1;
      existing.avgStars = (existing.avgStars * existing.ratingCount + stars) / count;
      existing.ratingCount = count;
      for (const tag of ["wouldEatAgain", "greatProtein", "worthGetting", "skipIt"]) {
        if (body.tags?.[tag]) existing.tags[tag] = (existing.tags[tag] || 0) + 1;
      }
      existing.lastNutrition = {
        calories: Number(body.calories) || 0,
        protein: Number(body.protein) || 0,
        totalCarbs: Number(body.totalCarbs) || 0,
        totalFat: Number(body.totalFat) || 0,
        servingSize: body.servingSize || "1 serving",
      };
      ratings[key] = existing;
      localWrite(LOCAL_KEYS.ratings, ratings);
      return existing;
    }
  }

  return null;
}

async function api(path, opts = {}) {
  if (/^\/api\/(diary|settings|custom-foods|ratings)(\/|$)/.test(path)) {
    const localResult = localApi(path, opts);
    if (localResult !== null) return localResult;
  }

  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    throw new Error(result.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function renderFavorites() {
  const panel = document.getElementById("favoritesPanel");
  const list = document.getElementById("favoritesList");
  const ranked = Object.values(state.ratings)
    .filter((r) => r.ratingCount > 0)
    .sort((a, b) => b.avgStars - a.avgStars || b.ratingCount - a.ratingCount)
    .slice(0, 6);

  if (ranked.length === 0) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const medals = ["🥇", "🥈", "🥉"];
  list.innerHTML = ranked
    .map((r, i) => {
      const n = r.lastNutrition || {};
      const stars = "★".repeat(Math.round(r.avgStars)) + "☆".repeat(5 - Math.round(r.avgStars));
      const tagBits = [];
      if (r.tags?.wouldEatAgain) tagBits.push(`🔥 ${r.tags.wouldEatAgain}`);
      if (r.tags?.greatProtein) tagBits.push(`💪 ${r.tags.greatProtein}`);
      if (r.tags?.worthGetting) tagBits.push(`💰 ${r.tags.worthGetting}`);
      if (r.tags?.skipIt) tagBits.push(`👎 ${r.tags.skipIt}`);
      return `
        <div class="favorite-card">
          <div class="fav-rank">${medals[i] || "⭐"}</div>
          <p class="fav-name">${escapeHtml(r.name)}</p>
          <div><span class="fav-stars">${stars}</span><span class="fav-count">${r.ratingCount} rating${r.ratingCount === 1 ? "" : "s"}</span></div>
          <div class="fav-macros">${n.calories ?? "?"} cal · ${n.protein ?? "?"}g protein${tagBits.length ? " · " + tagBits.join(" ") : ""}</div>
          <div class="fav-add-row">
            <select class="fav-meal-select" data-fav="${escapeHtml(r.name)}">
              <option value="breakfast">Breakfast</option>
              <option value="lunch">Lunch</option>
              <option value="dinner">Dinner</option>
              <option value="snacks" selected>Snacks</option>
            </select>
            <button class="fav-add-btn" data-fav-add="${escapeHtml(r.name)}">Add</button>
          </div>
        </div>`;
    })
    .join("");

  list.querySelectorAll(".fav-add-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.favAdd;
      const rating = ranked.find((r) => r.name === name);
      const select = list.querySelector(`.fav-meal-select[data-fav="${CSS.escape(name)}"]`);
      const meal = select.value;
      const n = rating.lastNutrition || {};
      await api(`/api/diary/${state.date}/${meal}`, {
        method: "POST",
        body: JSON.stringify({ ...n, name, servings: 1, source: "favorite" }),
      });
      state.day = await api(`/api/diary/${state.date}`);
      renderDiary();
      renderSummary();
      btn.textContent = "Added!";
      setTimeout(() => (btn.textContent = "Add"), 1200);
    });
  });
}

// ---------------- Load & render ----------------

async function loadAll() {
  const [day, settings, menu, customFoods, ratings] = await Promise.all([
    api(`/api/diary/${state.date}`),
    api("/api/settings"),
    api("/api/menu"),
    api("/api/custom-foods"),
    api("/api/ratings"),
  ]);
  state.day = day;
  state.settings = settings;
  state.menu = menu;
  state.customFoods = customFoods;
  state.ratings = ratings;
  render();
}

function render() {
  document.getElementById("datePicker").value = state.date;
  renderDiary();
  renderSummary();
  renderSyncStatus();
  renderFavorites();
}

function renderDiary() {
  ["breakfast", "lunch", "dinner", "snacks"].forEach((meal) => {
    const list = document.querySelector(`[data-list="${meal}"]`);
    const entries = state.day[meal] || [];
    list.innerHTML = "";

    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "empty-meal";
      li.textContent = "No food logged yet.";
      list.appendChild(li);
    } else {
      entries.forEach((e) => list.appendChild(renderEntry(meal, e)));
    }

    const total = entries.reduce((sum, e) => sum + e.calories * e.servings, 0);
    document.querySelector(`[data-total="${meal}"]`).textContent = `${Math.round(total)} cal`;
  });
}

function renderEntry(meal, entry) {
  const li = document.createElement("li");
  li.className = "entry-item";
  const cals = Math.round(entry.calories * entry.servings);
  const s = entry.servings;
  li.innerHTML = `
    <div class="entry-row">
      <button class="entry-expand" title="Nutrition facts">▸</button>
      <span class="entry-name">${escapeHtml(entry.name)}</span>
      <span class="entry-meta">${entry.servings}× ${escapeHtml(entry.servingSize || "")}</span>
      <span class="entry-cal">${cals} cal</span>
      <button class="remove-entry" title="Remove">&times;</button>
    </div>
    <div class="nutrition-facts hidden">
      ${nutritionFactsRows(entry, s)}
      ${ratingWidgetHtml(entry)}
    </div>
  `;

  li.querySelector(".entry-expand").addEventListener("click", (e) => {
    const panel = li.querySelector(".nutrition-facts");
    const collapsed = panel.classList.toggle("hidden");
    e.target.textContent = collapsed ? "▸" : "▾";
  });

  li.querySelector(".remove-entry").addEventListener("click", async () => {
    await api(`/api/diary/${state.date}/${meal}/${entry.id}`, { method: "DELETE" });
    state.day[meal] = state.day[meal].filter((e) => e.id !== entry.id);
    renderDiary();
    renderSummary();
  });

  wireRatingWidget(li, entry);
  return li;
}

function ratingWidgetHtml(entry) {
  return `
    <div class="rate-widget">
      <p class="rate-label">How was it?</p>
      <div class="star-picker" data-stars="0">
        ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn" data-star="${n}">★</button>`).join("")}
      </div>
      <div class="tag-chips">
        <button type="button" class="tag-chip" data-tag="wouldEatAgain">🔥 Would eat again</button>
        <button type="button" class="tag-chip" data-tag="greatProtein">💪 Great for protein</button>
        <button type="button" class="tag-chip" data-tag="worthGetting">💰 Worth getting</button>
        <button type="button" class="tag-chip" data-tag="skipIt">👎 Skip it</button>
      </div>
      <button type="button" class="save-rating-btn">Save rating</button>
    </div>
  `;
}

function wireRatingWidget(li, entry) {
  const picker = li.querySelector(".star-picker");
  const stars = Array.from(li.querySelectorAll(".star-btn"));
  const tagChips = Array.from(li.querySelectorAll(".tag-chip"));
  const saveBtn = li.querySelector(".save-rating-btn");

  stars.forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = Number(btn.dataset.star);
      picker.dataset.stars = val;
      stars.forEach((s) => s.classList.toggle("filled", Number(s.dataset.star) <= val));
    });
  });

  tagChips.forEach((chip) => {
    chip.addEventListener("click", () => chip.classList.toggle("active"));
  });

  saveBtn.addEventListener("click", async () => {
    const starsVal = Number(picker.dataset.stars);
    if (!starsVal) {
      saveBtn.textContent = "Pick stars first";
      setTimeout(() => (saveBtn.textContent = "Save rating"), 1500);
      return;
    }
    const tags = {};
    tagChips.forEach((chip) => {
      if (chip.classList.contains("active")) tags[chip.dataset.tag] = true;
    });

    await api("/api/ratings", {
      method: "POST",
      body: JSON.stringify({
        name: entry.name,
        stars: starsVal,
        tags,
        calories: entry.calories,
        protein: entry.protein,
        totalCarbs: entry.totalCarbs,
        totalFat: entry.totalFat,
        servingSize: entry.servingSize,
      }),
    });

    state.ratings = await api("/api/ratings");
    renderFavorites();
    saveBtn.textContent = "Saved!";
    setTimeout(() => (saveBtn.textContent = "Save rating"), 1500);
  });
}

function nutritionFactsRows(entry, s) {
  const row = (label, value, unit, indent) => `
    <div class="fact-row ${indent ? "fact-indent" : ""}">
      <span>${label}</span><span>${Math.round((value || 0) * s * 10) / 10}${unit}</span>
    </div>`;
  return [
    row("Total Fat", entry.totalFat, "g", false),
    row("Saturated Fat", entry.saturatedFat, "g", true),
    row("Trans Fat", entry.transFat, "g", true),
    row("Cholesterol", entry.cholesterol, "mg", false),
    row("Sodium", entry.sodium, "mg", false),
    row("Total Carbohydrates", entry.totalCarbs, "g", false),
    row("Dietary Fiber", entry.fiber, "g", true),
    row("Total Sugars", entry.sugars, "g", true),
    row("Added Sugars", entry.addedSugars, "g", true),
    row("Protein", entry.protein, "g", false),
  ].join("");
}

function renderSummary() {
  const all = [...state.day.breakfast, ...state.day.lunch, ...state.day.dinner, ...state.day.snacks];
  const totals = all.reduce(
    (acc, e) => {
      acc.calories += e.calories * e.servings;
      acc.protein += e.protein * e.servings;
      acc.carbs += e.totalCarbs * e.servings;
      acc.fat += e.totalFat * e.servings;
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );

  const goal = state.settings;
  const ring = document.getElementById("calorieRing");
  const circumference = 2 * Math.PI * 60; // r=60
  const valueEl = document.getElementById("caloriesRemaining");
  const labelEl = document.getElementById("ringLabel");

  if (goal.calorieGoal > 0) {
    const remaining = Math.round(goal.calorieGoal - totals.calories);
    valueEl.textContent = remaining;
    labelEl.textContent = "left today";
    const pct = Math.max(0, Math.min(1, totals.calories / goal.calorieGoal));
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = circumference * (1 - pct);
    ring.style.stroke = totals.calories > goal.calorieGoal ? "var(--warn)" : "var(--garnet-bright)";
  } else {
    // No goal set yet — show what's been logged instead of a meaningless
    // "remaining" number, and leave the ring empty rather than full/wrong.
    valueEl.textContent = Math.round(totals.calories);
    labelEl.textContent = "logged today";
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = circumference;
    ring.style.stroke = "var(--garnet-bright)";
  }

  setMacro("protein", totals.protein, goal.proteinGoal);
  setMacro("carbs", totals.carbs, goal.carbGoal);
  setMacro("fat", totals.fat, goal.fatGoal);
}

function setMacro(key, value, goal) {
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : 0;
  document.getElementById(`${key}Fill`).style.width = `${pct}%`;
  document.getElementById(`${key}Value`).textContent = `${Math.round(value)} / ${Math.round(goal)}g`;
}

function renderSyncStatus() {
  const el = document.getElementById("syncStatus");
  if (!state.menu.scrapedAt) {
    el.textContent = "Menu not synced yet — click \"Sync Suwannee Room menu\" to pull today's items.";
    return;
  }
  const itemCount = state.menu.stations.reduce((n, s) => n + s.items.length, 0);
  const when = new Date(state.menu.scrapedAt).toLocaleString();
  el.textContent = `Last synced ${when} · ${itemCount} items` + (state.menu.warning ? ` · ${state.menu.warning}` : "");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------- Date navigation ----------------

document.getElementById("datePicker").addEventListener("change", (e) => {
  state.date = e.target.value;
  loadAll();
});
document.getElementById("prevDay").addEventListener("click", () => shiftDate(-1));
document.getElementById("nextDay").addEventListener("click", () => shiftDate(1));
function shiftDate(delta) {
  const d = new Date(state.date + "T00:00:00");
  d.setDate(d.getDate() + delta);
  state.date = d.toISOString().slice(0, 10);
  loadAll();
}

// ---------------- Sync menu ----------------

document.getElementById("syncMenu").addEventListener("click", async () => {
  const btn = document.getElementById("syncMenu");
  const label = document.getElementById("syncLabel");
  btn.disabled = true;
  label.textContent = "Syncing… this can take up to 30s";
  try {
    state.menu = await api("/api/menu/refresh", { method: "POST" });
    lastMenuTimestamp = state.menu.scrapedAt || lastMenuTimestamp;
    renderSyncStatus();
    renderMenuResults(document.getElementById("menuSearch")?.value || "");
  } catch (err) {
    document.getElementById("syncStatus").textContent = `Sync failed: ${err.message}`;
  } finally {
    btn.disabled = false;
    label.textContent = "Sync Suwannee Room menu";
  }
});

// ---------------- Add food dialog ----------------

const addFoodDialog = document.getElementById("addFoodDialog");

document.querySelectorAll("[data-meal-add]").forEach((btn) => {
  btn.addEventListener("click", () => openAddFood(btn.dataset.mealAdd));
});

function openAddFood(meal) {
  state.pendingMeal = meal;
  document.getElementById("dialogMealName").textContent = meal;
  document.getElementById("manualHint").textContent = "";
  document.getElementById("manualForm").reset();
  showDialogError("");
  switchTab("menu");
  menuPeriodFilter = "all";
  renderMenuResults("");
  renderCustomResults();
  addFoodDialog.showModal();
}

document.getElementById("closeDialog").addEventListener("click", () => addFoodDialog.close());

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
}

// --- Menu search tab ---

document.getElementById("menuSearch").addEventListener("input", (e) => renderMenuResults(e.target.value));

function allMenuItems() {
  const periods = state.menu.mealPeriods || {};
  const seen = new Map();
  Object.entries(periods).forEach(([period, foods]) => {
    (foods || []).forEach((item) => {
      const key = item.name.trim().toLowerCase();
      const existing = seen.get(key);
      if (existing) {
        existing.periods = Array.from(new Set([...(existing.periods || []), period]));
      } else {
        seen.set(key, { ...item, station: period, periods: [period] });
      }
    });
  });
  if (seen.size === 0) {
    return state.menu.stations.flatMap((s) => s.items.map((i) => ({ ...i, station: s.name, periods: [] })));
  }
  return Array.from(seen.values());
}

let menuPeriodFilter = "all";

function availableMenuPeriods() {
  return Object.keys(state.menu.mealPeriods || {}).filter((p) =>
    Array.isArray(state.menu.mealPeriods[p]) && state.menu.mealPeriods[p].length
  );
}

function ensureMenuPeriodFilter() {
  const periodBar = document.getElementById("menuPeriodFilters");
  if (!periodBar) return;
  const periods = ["all", ...availableMenuPeriods()];
  if (!periods.includes(menuPeriodFilter)) menuPeriodFilter = "all";
  periodBar.innerHTML = periods.map((p) => {
    const label = p === "all" ? "All meals" : p;
    return `<button type="button" class="period-filter ${menuPeriodFilter === p ? "active" : ""}" data-period="${escapeHtml(p)}">${escapeHtml(label)}</button>`;
  }).join("");
  periodBar.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      menuPeriodFilter = btn.dataset.period;
      renderMenuResults(document.getElementById("menuSearch").value);
    });
  });
}

function renderMenuResults(query) {
  const list = document.getElementById("menuResults");
  list.innerHTML = "";
  ensureMenuPeriodFilter();
  const q = query.trim().toLowerCase();
  const items = allMenuItems().filter((i) =>
    (menuPeriodFilter === "all" || (i.periods || []).includes(menuPeriodFilter)) &&
    (!q || i.name.toLowerCase().includes(q))
  );

  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.style.cursor = "default";
    li.textContent = state.menu.stations.length === 0
      ? "No menu synced yet. Click \"Sync Suwannee Room menu\" or use Quick add."
      : "No matches. Try Quick add to log it manually.";
    list.appendChild(li);
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");
    const cal = item.calories != null ? `${item.calories} cal` : "Nutrition unavailable";
    const periodLabel = item.periods?.length ? item.periods.join(" · ") : item.station;
    li.innerHTML = `
      <div class="food-result-main">
        <span class="fname">${escapeHtml(item.name)}</span>
        <span class="fmeta">${escapeHtml(periodLabel || "Menu")}</span>
      </div>
      <div class="food-result-action">${escapeHtml(cal)} <span aria-hidden="true">›</span></div>`;
    li.title = "Tap to see nutrition and choose servings";
    li.addEventListener("click", () => openServingPicker(item, "menu"));
    list.appendChild(li);
  });
}

// --- My foods tab ---

function renderCustomResults() {
  const list = document.getElementById("customResults");
  list.innerHTML = "";
  if (state.customFoods.length === 0) {
    const li = document.createElement("li");
    li.className = "hint";
    li.style.cursor = "default";
    li.textContent = "Nothing saved yet. Foods you quick-add will show up here.";
    list.appendChild(li);
    return;
  }
  state.customFoods.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fname">${escapeHtml(item.name)}</span><span class="fmeta">${item.calories} cal</span>`;
    li.addEventListener("click", () => openServingPicker(item, "custom"));
    list.appendChild(li);
  });
}

// --- Quick add (manual) tab ---

document.getElementById("manualForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  showDialogError("");
  const fd = new FormData(e.target);
  const food = {
    name: fd.get("name"),
    calories: Number(fd.get("calories")) || 0,
    protein: Number(fd.get("protein")) || 0,
    totalCarbs: Number(fd.get("totalCarbs")) || 0,
    totalFat: Number(fd.get("totalFat")) || 0,
    servingSize: fd.get("servingSize") || "1 serving",
  };

  try {
    if (fd.get("save")) {
      const saved = await api("/api/custom-foods", { method: "POST", body: JSON.stringify(food) });
      state.customFoods.push(saved);
    }
  } catch (err) {
    showDialogError(`Couldn't save to My foods (adding to diary anyway): ${err.message}`);
  }

  const ok = await logEntry({ ...food, servings: 1, source: "manual" });
  if (ok) {
    e.target.reset();
    document.getElementById("manualHint").textContent = "";
    addFoodDialog.close();
  }
});

// --- Serving picker step ---

function openServingPicker(item, source) {
  // If we couldn't parse nutrition data for this item (the sync's nutrition
  // panel step failed for it), don't let the user add a fake "0 calorie"
  // entry — send them to Quick add instead, pre-filled with the name, so
  // they can type in the real numbers (e.g. from the label at the station).
  if (item.calories == null) {
    switchTab("manual");
    const form = document.getElementById("manualForm");
    form.name.value = item.name;
    form.servingSize.value = item.servingSize || "";
    document.getElementById("manualHint").textContent =
      `We synced "${item.name}" but couldn't read its nutrition facts. Enter them here (check the label at the station, or the item on the dining site).`;
    return;
  }

  state.pendingFood = { ...item, source };
  document.getElementById("servingFoodName").textContent = item.name;
  document.getElementById("servingBase").textContent =
    `${item.calories ?? "?"} cal per ${item.servingSize || "serving"}` + (item.station ? ` · ${item.station}` : "");
  document.getElementById("servingCount").value = 1;
  updateServingPreview();
  switchTab("serving");
}

document.getElementById("servingCount").addEventListener("input", updateServingPreview);

function updateServingPreview() {
  const servings = Number(document.getElementById("servingCount").value) || 0;
  const food = state.pendingFood;
  const preview = document.getElementById("servingPreview");
  if (!food) return;
  const n = (v) => Math.round((v || 0) * servings * 10) / 10;
  preview.innerHTML = `
    <div class="preview-headline"><span>${n(food.calories)} cal</span><span>${n(food.protein)}g protein</span><span>${n(food.totalCarbs)}g carbs</span><span>${n(food.totalFat)}g fat</span></div>
    <div class="preview-detail">
      <span>Sat fat ${n(food.saturatedFat)}g</span>
      <span>Trans fat ${n(food.transFat)}g</span>
      <span>Cholesterol ${n(food.cholesterol)}mg</span>
      <span>Sodium ${n(food.sodium)}mg</span>
      <span>Fiber ${n(food.fiber)}g</span>
      <span>Sugars ${n(food.sugars)}g</span>
      <span>Added sugars ${n(food.addedSugars)}g</span>
    </div>
  `;
}

document.getElementById("confirmAdd").addEventListener("click", async () => {
  const servings = Number(document.getElementById("servingCount").value) || 1;
  const food = state.pendingFood;
  const ok = await logEntry({ ...food, servings, source: food.source });
  if (ok) addFoodDialog.close();
});

function showDialogError(message) {
  const el = document.getElementById("dialogError");
  el.textContent = message;
  el.classList.toggle("hidden", !message);
}

async function logEntry(food) {
  showDialogError("");
  try {
    const entry = await api(`/api/diary/${state.date}/${state.pendingMeal}`, {
      method: "POST",
      body: JSON.stringify(food),
    });
    state.day[state.pendingMeal].push(entry);
    renderDiary();
    renderSummary();
    return true;
  } catch (err) {
    showDialogError(`Couldn't add that food: ${err.message}`);
    return false;
  }
}

// ---------------- Goals dialog ----------------

const goalsDialog = document.getElementById("goalsDialog");

document.getElementById("editGoals").addEventListener("click", () => {
  const form = document.getElementById("goalsForm");
  form.calorieGoal.value = state.settings.calorieGoal;
  form.proteinGoal.value = state.settings.proteinGoal;
  form.carbGoal.value = state.settings.carbGoal;
  form.fatGoal.value = state.settings.fatGoal;
  goalsDialog.showModal();
});
document.getElementById("closeGoals").addEventListener("click", () => goalsDialog.close());

document.getElementById("goalsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const updated = {
    calorieGoal: Number(fd.get("calorieGoal")),
    proteinGoal: Number(fd.get("proteinGoal")),
    carbGoal: Number(fd.get("carbGoal")),
    fatGoal: Number(fd.get("fatGoal")),
  };
  state.settings = await api("/api/settings", { method: "POST", body: JSON.stringify(updated) });
  renderSummary();
  goalsDialog.close();
});

// ---------------- Init ----------------

loadAll().catch((err) => {
  console.error(err);
  document.getElementById("syncStatus").textContent = `Failed to load app data: ${err.message}`;
});

// Public deployment: the server may refresh the shared menu in the background.
// Poll lightly so a phone that was already open picks up the new menu automatically.
let lastMenuTimestamp = state.menu.scrapedAt || null;
setInterval(async () => {
  try {
    const health = await fetch("/api/health", { cache: "no-store" }).then((r) => r.json());
    if (health.scrapedAt && health.scrapedAt !== lastMenuTimestamp) {
      state.menu = await api("/api/menu");
      lastMenuTimestamp = state.menu.scrapedAt;
      renderSyncStatus();
      renderMenuResults(document.getElementById("menuSearch")?.value || "");
    } else if (health.syncing) {
      document.getElementById("syncStatus").textContent = "Updating today's Suwannee Room menu…";
    }
  } catch (_) {
    // A transient network failure should not disrupt the diary UI.
  }
}, 20000);
