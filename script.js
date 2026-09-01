/* =========================================================
   CONFIG — paste your Google Apps Script Web App URL below.
   The app tries this first; if it fails (not deployed yet, CORS,
   offline, etc.) it silently falls back to the embedded dataset
   in data.js so the site always works.
   ========================================================= */
const CONFIG = {
  // Example: "https://script.google.com/macros/s/AKfycb.../exec"
  API_URL:
    "https://script.google.com/macros/s/AKfycbzXkOlXyjeUxXFnywvPDtiwf5EPudN1axXOQxsn4wWc3vkcXRb8ANqct8b1AS3Hh4yZ/exec",
  FETCH_TIMEOUT_MS: 8000,
  CACHE_KEY: "routine_data_cache_v1",
  DEFAULT_KEY: "routine_default_v1",
  TIMEZONE: "Asia/Dhaka",
};

// Fixed daily slot template — used to render gaps + the lunch break
// even for slots that have no class in the sheet.
const SLOT_TEMPLATE = [
  { slot: 1, start: "09:00 AM", end: "10:05 AM" },
  { slot: 2, start: "10:05 AM", end: "11:10 AM" },
  { slot: 3, start: "11:10 AM", end: "12:15 PM" },
  { slot: 4, start: "12:15 PM", end: "01:15 PM" },
  { break: true, start: "01:15 PM", end: "01:50 PM", label: "Break" },
  { slot: 5, start: "01:50 PM", end: "02:55 PM" },
  { slot: 6, start: "02:55 PM", end: "04:00 PM" },
];

// Bangladesh academic week order (Saturday first, Friday off).
const WEEK_ORDER = [
  "Saturday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
];
const DAY_SHORT = {
  Saturday: "Sat",
  Sunday: "Sun",
  Monday: "Mon",
  Tuesday: "Tue",
  Wednesday: "Wed",
  Thursday: "Thu",
  Friday: "Fri",
};
const DAY_COLOR = {
  Saturday: "var(--sat)",
  Sunday: "var(--sun)",
  Monday: "var(--mon)",
  Tuesday: "var(--tue)",
  Wednesday: "var(--wed)",
  Thursday: "var(--thu)",
  Friday: "var(--fri)",
};

let ALL_CLASSES = [];
let state = { semester: null, section: null, day: null };

/* ---------------- utilities ---------------- */

function parseTimeToMinutes(t) {
  if (!t) return null;
  const m = String(t)
    .trim()
    .match(/(\d{1,2}):(\d{2})\s*([AP])M/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "P" && h !== 12) h += 12;
  if (ap === "A" && h === 12) h = 0;
  return h * 60 + min;
}

function nowInDhaka() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CONFIG.TIMEZONE,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const minutes = parseInt(map.hour, 10) * 60 + parseInt(map.minute, 10);
  return { weekday: map.weekday, minutes };
}

function formatStatusTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

function semesterSortKey(s) {
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0], 10) : 99;
}

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("is-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

/* ---------------- data normalization ---------------- */

// Accepts rows either shaped like the raw sheet (Semester, Section, Day,
// Time, "Course Code", "Course Title", Teacher, Room) or already-normalized
// (semester, section, day, slot, start, end, code, title, teacher, room).
function normalizeRow(row) {
  if ("slot" in row && "start" in row && "end" in row) {
    return {
      semester: String(row.semester).trim(),
      section: String(row.section).trim(),
      day: String(row.day).trim(),
      slot: parseInt(row.slot, 10),
      start: row.start,
      end: row.end,
      code: row.code,
      title: row.title,
      teacher: row.teacher,
      room: row.room,
    };
  }
  const get = (obj, key) =>
    obj[key] ?? obj[key.toLowerCase()] ?? obj[key.replace(/\s+/g, "")];
  const semester = get(row, "Semester");
  const section = get(row, "Section");
  const day = get(row, "Day");
  const time = get(row, "Time");
  const code = get(row, "Course Code");
  const title = get(row, "Course Title");
  const teacher = get(row, "Teacher");
  const room = get(row, "Room");
  if (!semester || !time) return null;
  const m = String(time).match(
    /Slot\s*(\d+)\s+(\d{1,2}:\d{2}\s*[AP]M)\s*-\s*(\d{1,2}:\d{2}\s*[AP]M)/i,
  );
  if (!m) return null;
  return {
    semester: String(semester).trim(),
    section: String(section).trim(),
    day: String(day).trim(),
    slot: parseInt(m[1], 10),
    start: m[2].trim(),
    end: m[3].trim(),
    code: String(code || "").trim(),
    title: String(title || "").trim(),
    teacher: String(teacher || "").trim(),
    room: String(room || "").trim(),
  };
}

function normalizeDataset(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeRow).filter(Boolean);
}

/* ---------------- data loading ---------------- */

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Bad response: " + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadData(forceRefresh = false) {
  const statusLine = document.getElementById("statusLine");
  const canTryLive = CONFIG.API_URL && !CONFIG.API_URL.startsWith("PASTE_");

  if (canTryLive) {
    try {
      const raw = await fetchWithTimeout(
        CONFIG.API_URL,
        CONFIG.FETCH_TIMEOUT_MS,
      );
      const normalized = normalizeDataset(raw);
      if (normalized.length) {
        ALL_CLASSES = normalized;
        localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(normalized));
        renderStatus(true);
        if (forceRefresh) showToast("Routine updated from your Google Sheet");
        return;
      }
    } catch (err) {
      // fall through to cache / fallback
    }
  }

  const cached = localStorage.getItem(CONFIG.CACHE_KEY);
  if (cached) {
    try {
      ALL_CLASSES = JSON.parse(cached);
      renderStatus(false);
      if (forceRefresh)
        showToast(
          canTryLive
            ? "Couldn't reach your sheet — showing last saved data"
            : "Showing saved data",
        );
      return;
    } catch (e) {
      /* ignore, fall through */
    }
  }

  ALL_CLASSES = normalizeDataset(
    typeof FALLBACK_CLASSES !== "undefined" ? FALLBACK_CLASSES : [],
  );
  renderStatus(false);
  if (forceRefresh)
    showToast(
      canTryLive
        ? "Couldn't reach your sheet — showing sample data"
        : "Showing sample data",
    );
}

function renderStatus(isLive) {
  const statusLine = document.getElementById("statusLine");
  const count = ALL_CLASSES.length;
  statusLine.innerHTML =
    `Loaded ${count} classes<span class="dot">·</span>${formatStatusTime()} (Bangladesh time)` +
    (isLive ? "" : `<span class="dot">·</span>cached`);
}

/* ---------------- semester / section pickers ---------------- */

function populateSemesterSelect() {
  const sel = document.getElementById("semesterSelect");
  const semesters = [...new Set(ALL_CLASSES.map((c) => c.semester))].sort(
    (a, b) => semesterSortKey(a) - semesterSortKey(b),
  );
  sel.innerHTML = semesters
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
}

function populateSectionSelect(semester) {
  const sel = document.getElementById("sectionSelect");
  const sections = [
    ...new Set(
      ALL_CLASSES.filter((c) => c.semester === semester).map((c) => c.section),
    ),
  ].sort();
  sel.innerHTML = sections
    .map((s) => `<option value="${s}">Section ${s}</option>`)
    .join("");
}

function applyDefaultsOrFirst() {
  const saved = JSON.parse(localStorage.getItem(CONFIG.DEFAULT_KEY) || "null");
  const semesterSel = document.getElementById("semesterSelect");
  const sectionSel = document.getElementById("sectionSelect");

  let semester = semesterSel.options[0]?.value;
  if (
    saved &&
    [...semesterSel.options].some((o) => o.value === saved.semester)
  ) {
    semester = saved.semester;
  }
  semesterSel.value = semester;
  populateSectionSelect(semester);

  let section = sectionSel.options[0]?.value;
  if (
    saved &&
    saved.semester === semester &&
    [...sectionSel.options].some((o) => o.value === saved.section)
  ) {
    section = saved.section;
  }
  sectionSel.value = section;

  state.semester = semester;
  state.section = section;
}

/* ---------------- day pills ---------------- */

function renderDayPills() {
  const wrap = document.getElementById("dayPills");
  const today = nowInDhaka().weekday;
  wrap.innerHTML = WEEK_ORDER.map((day) => {
    const isActive = day === state.day;
    const isToday = day === today;
    return `<button class="day-pill${isActive ? " is-active" : ""}${isToday ? " is-today" : ""}"
              style="--dc:${DAY_COLOR[day]}" data-day="${day}">${DAY_SHORT[day]}</button>`;
  }).join("");

  wrap.querySelectorAll(".day-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.day = btn.dataset.day;
      renderDayPills();
      renderDayClasses();
    });
  });
}

/* ---------------- routine rendering ---------------- */

function classesFor(semester, section, day) {
  return ALL_CLASSES.filter(
    (c) => c.semester === semester && c.section === section && c.day === day,
  ).sort((a, b) => a.slot - b.slot);
}

function buildTimeline(semester, section, day) {
  const classes = classesFor(semester, section, day);
  const bySlot = {};
  classes.forEach((c) => (bySlot[c.slot] = c));

  return SLOT_TEMPLATE.map((slotDef) => {
    if (slotDef.break) return { type: "break", ...slotDef };
    const cls = bySlot[slotDef.slot];
    if (cls) return { type: "class", ...cls };
    return {
      type: "gap",
      slot: slotDef.slot,
      start: slotDef.start,
      end: slotDef.end,
    };
  });
}

function classStatus(item, day) {
  const { weekday, minutes } = nowInDhaka();
  if (day !== weekday) return "";
  const start = parseTimeToMinutes(item.start);
  const end = parseTimeToMinutes(item.end);
  if (minutes >= end) return "is-done";
  if (minutes >= start && minutes < end) return "is-now";
  return "";
}

function renderDayClasses() {
  const wrap = document.getElementById("dayClasses");
  const countEl = document.getElementById("classCount");
  if (!state.semester || !state.section || !state.day) return;

  const timeline = buildTimeline(state.semester, state.section, state.day);
  const classCount = timeline.filter((i) => i.type === "class").length;
  countEl.textContent = `${classCount} class${classCount === 1 ? "" : "es"} on ${state.day}`;

  if (classCount === 0) {
    wrap.innerHTML = `<div class="empty-state">No classes scheduled for ${state.day}. Enjoy the day off 🎉</div>`;
    return;
  }

  wrap.innerHTML = timeline
    .map((item, i) => {
      if (item.type === "break") {
        return `<div class="gap-card is-break" style="animation-delay:${i * 30}ms">
          <span class="class-slot">Break</span>
          <span>${item.start} – ${item.end} · Lunch break</span>
        </div>`;
      }
      if (item.type === "gap") {
        return `<div class="gap-card" style="animation-delay:${i * 30}ms">
          <span class="class-slot">Slot ${item.slot}</span>
          <span>${item.start} – ${item.end} · Free slot</span>
        </div>`;
      }
      const status = classStatus(item, state.day);
      const dc = DAY_COLOR[state.day];
      const done = status === "is-done";
      return `<div class="class-card ${status}" style="--dc:${dc}; animation-delay:${i * 30}ms">
        <div class="class-card-top">
          <span class="class-slot">Slot ${item.slot} · ${item.start} - ${item.end}</span>
          <span class="class-code">${item.code}</span>
        </div>
        <p class="class-title">
          ${done ? `<span class="done-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>` : ""}
          ${item.title}
        </p>
        <div class="class-meta">
          <div><span>TEACHER</span><span>${item.teacher || "—"}</span></div>
          <div><span>ROOM</span><span>${item.room || "—"}</span></div>
        </div>
      </div>`;
    })
    .join("");
}

/* ---------------- up next ---------------- */

function renderUpNext() {
  const card = document.getElementById("upNextCard");
  if (!state.semester || !state.section) {
    card.hidden = true;
    return;
  }

  const { weekday, minutes } = nowInDhaka();
  const todayIdx = WEEK_ORDER.indexOf(weekday);

  for (let offset = 0; offset < 7; offset++) {
    const day = WEEK_ORDER[(todayIdx + offset) % 7];
    const timeline = buildTimeline(state.semester, state.section, day).filter(
      (i) => i.type === "class",
    );
    const upcoming = timeline.find((c) => {
      if (offset > 0) return true;
      return parseTimeToMinutes(c.end) > minutes;
    });
    if (upcoming) {
      const label = offset === 0 ? "UP NEXT" : `NEXT — ${day.toUpperCase()}`;
      document.getElementById("upNextLabel").textContent = label;
      document.getElementById("upNextSlot").textContent =
        `Slot ${upcoming.slot}`;
      document.getElementById("upNextTime").textContent =
        `${upcoming.start} - ${upcoming.end}`;
      document.getElementById("upNextCourse").textContent =
        `${upcoming.code} · ${upcoming.title}`;
      document.getElementById("upNextSub").textContent =
        `${upcoming.teacher} · Room ${upcoming.room}`;
      card.hidden = false;
      return;
    }
  }
  card.hidden = true;
}

/* ---------------- room / teacher finders ---------------- */

function groupByDayOrdered(rows) {
  const groups = {};
  WEEK_ORDER.forEach((d) => (groups[d] = []));
  rows.forEach((r) => {
    if (groups[r.day]) groups[r.day].push(r);
  });
  WEEK_ORDER.forEach((d) => groups[d].sort((a, b) => a.slot - b.slot));
  return groups;
}

function renderFinderResults(container, groups, mode) {
  const dayEntries = WEEK_ORDER.filter((d) => groups[d].length);
  if (!dayEntries.length) {
    container.innerHTML = `<div class="empty-state">Start typing to search across the whole week.</div>`;
    return;
  }
  container.innerHTML = dayEntries
    .map((day) => {
      const cards = groups[day]
        .map(
          (
            r,
            i,
          ) => `<div class="finder-card" style="--dc:${DAY_COLOR[day]}; animation-delay:${i * 25}ms">
            <div class="finder-card-top"><span>Slot ${r.slot} · ${r.start} - ${r.end}</span><span>${r.semester} · Sec ${r.section}</span></div>
            <div class="finder-card-title">${r.code} · ${r.title}</div>
            <div class="finder-card-sub">${mode === "room" ? `${r.teacher} · Room ${r.room}` : `Room ${r.room}`}</div>
          </div>`,
        )
        .join("");
      return `<div class="finder-day-group">
        <div class="finder-day-label" style="--dc:${DAY_COLOR[day]}">${day.toUpperCase()}</div>
        ${cards}
      </div>`;
    })
    .join("");
}

function setupRoomFinder() {
  const input = document.getElementById("roomInput");
  const list = document.getElementById("roomList");
  const results = document.getElementById("roomResults");

  const rooms = [
    ...new Set(ALL_CLASSES.map((c) => c.room).filter(Boolean)),
  ].sort();
  list.innerHTML = rooms.map((r) => `<option value="${r}"></option>`).join("");

  let debounceT;
  input.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        results.innerHTML = `<div class="empty-state">Start typing to search across the whole week.</div>`;
        return;
      }
      const matches = ALL_CLASSES.filter((c) =>
        c.room.toLowerCase().includes(q),
      );
      renderFinderResults(results, groupByDayOrdered(matches), "room");
    }, 120);
  });
}

function setupTeacherFinder() {
  const input = document.getElementById("teacherInput");
  const list = document.getElementById("teacherList");
  const results = document.getElementById("teacherResults");

  const teachers = [
    ...new Set(ALL_CLASSES.map((c) => c.teacher).filter(Boolean)),
  ].sort();
  list.innerHTML = teachers
    .map((t) => `<option value="${t}"></option>`)
    .join("");

  let debounceT;
  input.addEventListener("input", () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        results.innerHTML = `<div class="empty-state">Start typing to search across the whole week.</div>`;
        return;
      }
      const matches = ALL_CLASSES.filter((c) =>
        c.teacher.toLowerCase().includes(q),
      );
      renderFinderResults(results, groupByDayOrdered(matches), "teacher");
    }, 120);
  });
}

/* ---------------- view tabs ---------------- */

function setupViewTabs() {
  const tabs = document.querySelectorAll(".view-tab");
  const panels = {
    routine: "view-routine",
    room: "view-room",
    teacher: "view-teacher",
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.remove("is-active");
        t.setAttribute("aria-selected", "false");
      });
      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");
      Object.values(panels).forEach((id) => {
        const panel = document.getElementById(id);
        panel.hidden = true;
        panel.classList.remove("is-active");
      });
      const target = document.getElementById(panels[tab.dataset.view]);
      target.hidden = false;
      // restart entrance animation
      target.classList.remove("view-panel");
      void target.offsetWidth;
      target.classList.add("view-panel", "is-active");
    });
  });
}

/* ---------------- wiring ---------------- */

function setupPickers() {
  const semesterSel = document.getElementById("semesterSelect");
  const sectionSel = document.getElementById("sectionSelect");

  semesterSel.addEventListener("change", () => {
    state.semester = semesterSel.value;
    populateSectionSelect(state.semester);
    sectionSel.value = sectionSel.options[0]?.value;
    state.section = sectionSel.value;
    afterSelectionChange();
  });

  sectionSel.addEventListener("change", () => {
    state.section = sectionSel.value;
    afterSelectionChange();
  });
}

function afterSelectionChange() {
  const today = nowInDhaka().weekday;
  state.day =
    WEEK_ORDER.includes(today) && today !== "Friday" ? today : "Saturday";
  renderDayPills();
  renderDayClasses();
  renderUpNext();
}

function setupSaveDefault() {
  const btn = document.getElementById("saveDefaultBtn");
  btn.addEventListener("click", () => {
    localStorage.setItem(
      CONFIG.DEFAULT_KEY,
      JSON.stringify({ semester: state.semester, section: state.section }),
    );
    btn.classList.add("is-saved");
    showToast(
      `Saved ${state.semester} · Section ${state.section} as your default`,
    );
    setTimeout(() => btn.classList.remove("is-saved"), 1400);
  });
}

function setupRefresh() {
  const btn = document.getElementById("refreshBtn");
  btn.addEventListener("click", async () => {
    btn.classList.add("is-spinning");
    await loadData(true);
    populateSemesterSelect();
    populateSectionSelect(state.semester);
    document.getElementById("semesterSelect").value = state.semester;
    document.getElementById("sectionSelect").value = state.section;
    renderDayPills();
    renderDayClasses();
    renderUpNext();
    setupRoomFinder();
    setupTeacherFinder();
    setTimeout(() => btn.classList.remove("is-spinning"), 700);
  });
}

async function init() {
  await loadData(false);
  populateSemesterSelect();
  applyDefaultsOrFirst();

  const today = nowInDhaka().weekday;
  state.day =
    WEEK_ORDER.includes(today) && today !== "Friday" ? today : "Saturday";

  renderDayPills();
  renderDayClasses();
  renderUpNext();
  setupPickers();
  setupSaveDefault();
  setupRefresh();
  setupViewTabs();
  setupRoomFinder();
  setupTeacherFinder();
}

document.addEventListener("DOMContentLoaded", init);
