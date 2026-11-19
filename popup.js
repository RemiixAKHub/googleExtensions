/**
 * popup.js — Acqueon Media Pauser v1.5 + v1.3 UX features
 *
 * v1.3 additions (UI / display only — zero logic/detection changes):
 *  Feature 1 — Audio Being Managed: icon + service name + Managed badge
 *  Feature 2 — Protected Tabs panel: detected call-control apps
 *  Feature 3 — About section: version, status, theme
 *  Feature 4 — Export Diagnostics: plain-text download
 *  Feature 5 — Toast notifications: auto-hide after 3 s
 *  Feature 6 — Statistics: derived from existing diag.events array
 *
 * No changes to: fetchDiag, message handling, background.js, detector.js,
 * pause/resume logic, timing, state machines, or service worker.
 */
"use strict";

const $ = (id) => document.getElementById(id);

// ── Utility ───────────────────────────────────────────────────────────────

function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function stateClass(s) {
  if (s === "active") return "s-active";
  if (s === "wrap")   return "s-wrap";
  return "s-idle";
}

function actionClass(a) {
  if (!a || a === "None") return "v-none";
  if (a.toLowerCase().includes("pause"))  return "v-pause";
  if (a.toLowerCase().includes("resume")) return "v-resume";
  return "v-none";
}

function detClass(m) {
  if (!m || m === "—") return "";
  if (m === "cssSelector")      return "v-mo";
  if (m === "mutationObserver") return "v-mo";
  if (m === "testButton")       return "v-method";
  return "v-fb";
}

function detLabel(m) {
  const map = {
    cssSelector:      "CSS Selector",
    mutationObserver: "MutationObserver",
    fallbackCheck:    "Fallback Check",
    textFallback:     "Text Fallback",
    testButton:       "Test Button",
    unknown:          "Unknown",
  };
  return map[m] || m || "—";
}

// ── Human-readable translation layer (unchanged from v1.5) ────────────────

function humanReadable(msg) {
  if (!msg) return msg;
  if (/amplifyapp\.com/i.test(msg))  return "Acqueon Workspace Protected";
  if (/acqueon\.com/i.test(msg) && /no media/i.test(msg)) return "Acqueon Workspace Protected";
  if (/no media found/i.test(msg))             return "No active audio detected";
  if (/pause button not found/i.test(msg))     return "Unable to locate pause controls";
  if (/play button not found/i.test(msg))      return "Unable to locate playback controls";
  if (/button not found/i.test(msg))           return "Unable to locate playback controls";
  if (/no video or button found/i.test(msg))   return "No active audio detected";
  if (/inject failed.*tab \d+/i.test(msg))     return "Cannot access browser tab (restricted page)";
  if (/inject failed/i.test(msg))              return "Unable to control media on that tab";
  if (/resume failed.*tab \d+/i.test(msg))     return "Unable to resume audio on that tab";
  const tabHostMatch = msg.match(/Tab \d+\s*\(([^)]+)\):\s*(.*)/i);
  if (tabHostMatch) {
    const host   = friendlyHost(tabHostMatch[1].trim());
    const detail = humanReadable(tabHostMatch[2].trim());
    return `${host}: ${detail}`;
  }
  const bareTabMatch = msg.match(/Tab \d+:\s*(.*)/i);
  if (bareTabMatch) return humanReadable(bareTabMatch[1].trim());
  if (/PAUSE METHOD:\s*(.+)/i.test(msg)) {
    const m = msg.match(/PAUSE METHOD:\s*(.+)/i)[1];
    return `Audio paused via ${friendlyMethod(m)}`;
  }
  if (/RESUME METHOD:\s*(.+)/i.test(msg)) {
    const m = msg.match(/RESUME METHOD:\s*(.+)/i)[1];
    return `Audio resumed via ${friendlyMethod(m)}`;
  }
  const pausedMatch = msg.match(/Paused (\d+) tab\(s\) via:\s*(.+)/i);
  if (pausedMatch) {
    const n = pausedMatch[1];
    const method = friendlyMethod(pausedMatch[2]);
    return `${n} ${n === "1" ? "tab" : "tabs"} paused — ${method}`;
  }
  const resumedMatch = msg.match(/Resumed (\d+) element\(s\) via:\s*(.+)/i);
  if (resumedMatch) {
    const n = resumedMatch[1];
    const method = friendlyMethod(resumedMatch[2]);
    if (n === "0") return "Nothing to resume";
    return `${n} ${n === "1" ? "source" : "sources"} resumed — ${method}`;
  }
  if (/wrap resume pending.*token/i.test(msg))      return "Waiting briefly before resuming…";
  if (/wrap resume cancelled.*new call/i.test(msg)) return "Resume cancelled — new call started";
  if (/wrap resume cancelled.*active/i.test(msg))   return "Resume cancelled — call still active";
  if (msg === "CALL ACTIVE")  return "Call started";
  if (msg === "CALL WRAP")    return "Call ended — wrapping up";
  if (/CALL IDLE/i.test(msg)) return "Call finished";
  if (/no audible tabs.*scanning all tabs/i.test(msg)) return "Scanning all open tabs for audio";
  if (/extension DISABLED/i.test(msg)) return "Extension disabled — tracking cleared";
  if (/extension ENABLED/i.test(msg))  return "Extension enabled";
  if (/TEST: manual pause/i.test(msg))  return "Manual test — pause triggered";
  if (/TEST: manual resume/i.test(msg)) return "Manual test — resume triggered";
  return msg;
}

function friendlyHost(host) {
  if (!host) return "Unknown tab";
  const h = host.toLowerCase();
  if (h.includes("spotify.com"))     return "Spotify";
  if (h.includes("soundcloud.com"))  return "SoundCloud";
  if (h.includes("youtube.com"))     return "YouTube";
  if (h.includes("youtu.be"))        return "YouTube";
  if (h.includes("music.apple.com")) return "Apple Music";
  if (h.includes("tidal.com"))       return "Tidal";
  if (h.includes("deezer.com"))      return "Deezer";
  if (h.includes("pandora.com"))     return "Pandora";
  if (h.includes("amazon"))          return "Amazon Music";
  if (h.includes("amplifyapp.com"))  return "Acqueon Workspace";
  if (h.includes("acqueon.com"))     return "Acqueon Workspace";
  return host;
}

function friendlyMethod(m) {
  if (!m) return "unknown method";
  const s = m.toLowerCase();
  if (s.includes("spotify"))        return "Spotify controls";
  if (s.includes("soundcloud"))     return "SoundCloud controls";
  if (s.includes("youtube"))        return "YouTube controls";
  if (s.includes("audio/video"))    return "direct audio control";
  if (s.includes("generic button")) return "media button";
  if (s === "none")                  return "no method (nothing found)";
  return m;
}

function friendlyTabName(tabId, urlMap) {
  if (urlMap && urlMap[tabId]) {
    try {
      const host = new URL(urlMap[tabId]).hostname;
      return friendlyHost(host);
    } catch (_) {}
  }
  return `Tab ${tabId}`;
}

// ── v1.3: Service icon per friendly name ─────────────────────────────────

function serviceIcon(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("spotify"))      return "🎵";
  if (n.includes("soundcloud"))   return "🔊";
  if (n.includes("youtube"))      return "▶";
  if (n.includes("apple music"))  return "🎵";
  if (n.includes("tidal"))        return "🎵";
  if (n.includes("deezer"))       return "🎵";
  if (n.includes("pandora"))      return "🎵";
  if (n.includes("amazon music")) return "🎵";
  return "🎧";
}

// ── v1.3: Log badge classification (unchanged from v1.5) ─────────────────

function logBadge(msg) {
  if (!msg) return { cls: "log-badge-info", lbl: "INFO" };
  const m = msg.toLowerCase();
  if (m.includes("test"))                                              return { cls: "log-badge-test",   lbl: "TEST"   };
  if (m === "call active" || m.startsWith("call active"))             return { cls: "log-badge-active", lbl: "ACTIVE" };
  if (m.startsWith("call wrap"))                                      return { cls: "log-badge-wrap",   lbl: "WRAP"   };
  if (m.startsWith("call idle"))                                      return { cls: "log-badge-wrap",   lbl: "IDLE"   };
  if (m.startsWith("pause method") || m.startsWith("paused "))       return { cls: "log-badge-paused", lbl: "PAUSE"  };
  if (m.startsWith("resume method") || m.startsWith("resumed "))     return { cls: "log-badge-resume", lbl: "RESUME" };
  if (m.startsWith("wrap resume"))                                    return { cls: "log-badge-wrap",   lbl: "WRAP"   };
  if (m.startsWith("no audible") || m.includes("scanning"))          return { cls: "log-badge-scan",   lbl: "SCAN"   };
  if (m.includes("error") || m.includes("fail") || m.includes("not found")) return { cls: "log-badge-err", lbl: "ERROR" };
  if (m.includes("disabled"))                                         return { cls: "log-badge-scan",   lbl: "OFF"    };
  if (m.includes("enabled"))                                          return { cls: "log-badge-resume", lbl: "ON"     };
  return { cls: "log-badge-info", lbl: "INFO" };
}

// ── Feature 5 — Toast ─────────────────────────────────────────────────────

let _toastTimer = null;

function showToast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("show"), 3000);
}

// ── Feature 6 — Statistics (derived from diag.events) ────────────────────

function deriveStats(events) {
  let calls   = 0;
  let pauses  = 0;
  let resumes = 0;

  (events || []).forEach((ev) => {
    const m = (ev.message || "").toLowerCase();
    if (m === "call active")                          calls++;
    if (m.startsWith("paused ") && !m.includes("0 tab")) pauses++;
    if (m.startsWith("resumed ") && !m.includes("0 element")) resumes++;
  });

  return { calls, pauses, resumes };
}

// ── Render: Developer tab ─────────────────────────────────────────────────

function renderLog(container, items, emptyMsg) {
  if (!items || items.length === 0) {
    container.innerHTML = `<div class="log-empty">${emptyMsg}</div>`;
    return;
  }
  container.innerHTML = items.map((ev) => {
    const { cls, lbl } = logBadge(ev.message);
    const display = humanReadable(ev.message);
    return `<div class="log-item">
      <span class="log-t">${ev.time}</span>
      <span class="log-badge ${cls}">${lbl}</span>
      <span class="log-m">${display}</span>
    </div>`;
  }).join("");
}

function render(diag) {
  $("ext-dot").className      = "dot dot-green";
  $("ext-status").textContent = "Running";
  $("ext-status").style.color = "var(--green)";

  const s = diag.currentState || "idle";
  const cStateEl = $("c-state");
  cStateEl.textContent = s.charAt(0).toUpperCase() + s.slice(1);
  cStateEl.className   = "card-val " + stateClass(s);

  const aq = diag.acqueonTabDetected;
  const cAcqEl = $("c-acq");
  cAcqEl.textContent = aq ? "Yes" : "No";
  cAcqEl.className   = "card-val " + (aq ? "s-yes" : "s-no");

  $("c-paused").textContent = diag.pausedTabCount ?? 0;
  $("r-change").textContent = diag.lastStateChange || "—";

  const rDetEl = $("r-det");
  rDetEl.textContent = detLabel(diag.detectionMethod);
  rDetEl.className   = "row-val " + detClass(diag.detectionMethod);

  const rActEl = $("r-action");
  rActEl.textContent = diag.lastAction || "None";
  rActEl.className   = "row-val " + actionClass(diag.lastAction);

  $("r-media").textContent    = diag.mediaMethod        || "—";
  $("r-pause-t").textContent  = diag.lastPauseTimestamp  || "—";
  $("r-resume-t").textContent = diag.lastResumeTimestamp || "—";

  const lastErrEl = $("r-last-err");
  const errText = diag.lastError ? humanReadable(diag.lastError) : "None";
  lastErrEl.textContent = errText;
  lastErrEl.className   = diag.lastError ? "row-val v-err" : "row-val v-none";

  const evs  = diag.events || [];
  const errs = diag.errors || [];
  $("ev-badge").textContent  = `${evs.length} / 25`;
  $("err-badge").textContent = `${errs.length} / 10`;
  renderLog($("ev-log"),  evs,  "No events yet");
  renderLog($("err-log"), errs, "No errors");

  $("footer-t").textContent = "Updated " + nowTime();
}

function renderError(msg) {
  $("ext-dot").className      = "dot dot-red";
  $("ext-status").textContent = msg || "Cannot reach background worker";
  $("ext-status").style.color = "var(--red)";
  $("footer-t").textContent   = "Failed " + nowTime();

  // About section: mark offline
  const aboutStatus = $("about-status");
  if (aboutStatus) {
    aboutStatus.textContent = "Not responding";
    aboutStatus.className   = "about-val";
    aboutStatus.style.color = "var(--red)";
  }
}

// ── fetchDiag — UNCHANGED ─────────────────────────────────────────────────

function fetchDiag() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (resp) => {
    if (chrome.runtime.lastError) {
      chrome.storage.local.get("diag", (r) => {
        if (r?.diag) {
          render(r.diag);
          renderSimple(r.diag);
          $("ext-status").textContent = "Running (cached)";
          $("ext-status").style.color = "var(--amber)";
          $("ext-dot").className      = "dot dot-amber";
        } else {
          renderError("Extension not responding");
        }
      });
      return;
    }
    if (!resp?.ok) { renderError("Bad response"); return; }
    render(resp.diag);
    renderSimple(resp.diag);
  });
}

// ── Dev tab button handlers — UNCHANGED ───────────────────────────────────

$("btn-pause").addEventListener("click", () => {
  $("btn-pause").textContent = "⏸ Sending…";
  chrome.runtime.sendMessage({ type: "TEST_PAUSE" }, () => {
    $("btn-pause").textContent = "⏸ Test Pause";
    showToast("✓ Test pause triggered");
    setTimeout(fetchDiag, 600);
  });
});

$("btn-resume").addEventListener("click", () => {
  $("btn-resume").textContent = "▶ Sending…";
  chrome.runtime.sendMessage({ type: "TEST_RESUME" }, () => {
    $("btn-resume").textContent = "▶ Test Resume";
    showToast("✓ Test resume triggered");
    setTimeout(fetchDiag, 600);
  });
});

function requestSafeRecovery(button, originalLabel) {
  button.disabled = true;
  button.textContent = "↻ Checking…";
  chrome.runtime.sendMessage({ type: "RECOVER_SAFELY" }, (resp) => {
    button.disabled = false;
    button.textContent = originalLabel;
    if (chrome.runtime.lastError || !resp?.ok) {
      showToast("⚠ Recovery could not reach the extension");
      return;
    }
    showToast(`✓ Recovery complete — ${resp.removed} stale record(s) cleared`);
    setTimeout(fetchDiag, 300);
  });
}

$("btn-recover").addEventListener("click", () => {
  requestSafeRecovery($("btn-recover"), "↻ Recover");
});

$("btn-ref").addEventListener("click", fetchDiag);

fetchDiag();
const timer = setInterval(fetchDiag, 2000);
window.addEventListener("unload", () => clearInterval(timer));

// ── Tab switcher — UNCHANGED ──────────────────────────────────────────────

$("tab-simple-btn").addEventListener("click", () => {
  $("tab-simple-btn").classList.add("active");
  $("tab-dev-btn").classList.remove("active");
  $("tab-simple").classList.add("active");
  $("tab-dev").classList.remove("active");
});

$("tab-dev-btn").addEventListener("click", () => {
  $("tab-dev-btn").classList.add("active");
  $("tab-simple-btn").classList.remove("active");
  $("tab-dev").classList.add("active");
  $("tab-simple").classList.remove("active");
});

// ── Theme switcher — UNCHANGED ────────────────────────────────────────────

const THEME_KEY = "amp_theme";

function applyTheme(theme) {
  const body = document.body;
  if (theme === "light") {
    body.setAttribute("data-theme", "light");
  } else if (theme === "dark") {
    body.removeAttribute("data-theme");
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    prefersDark ? body.removeAttribute("data-theme") : body.setAttribute("data-theme", "light");
  }
  // Update About section theme label (element removed in v1.3 polish — no-op guard kept for safety)
}

function setTheme(theme) {
  ["theme-auto", "theme-dark", "theme-light"].forEach((id) => $(id).classList.remove("active"));
  $("theme-" + theme).classList.add("active");
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
}

(function initTheme() {
  let saved = "auto";
  try { saved = localStorage.getItem(THEME_KEY) || "auto"; } catch (_) {}
  setTheme(saved);
})();

$("theme-auto").addEventListener("click",  () => setTheme("auto"));
$("theme-dark").addEventListener("click",  () => setTheme("dark"));
$("theme-light").addEventListener("click", () => setTheme("light"));

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const active = document.querySelector(".theme-btn.active");
  if (active?.id === "theme-auto") applyTheme("auto");
});

// ── Simple tab — CORE RENDER (v1.5, unchanged) ────────────────────────────

function renderSimple(diag) {
  // ── State cell (merged into stat strip) ──
  const s = diag.currentState || "idle";
  $("hero-card").setAttribute("data-state", s);
  $("s-state").textContent = s === "active" ? "ACTIVE" : s === "wrap" ? "WRAPUP" : "IDLE";

  // ── Stat strip ──
  const aqEl = $("s-acq");
  aqEl.textContent = diag.acqueonTabDetected ? "Detected" : "Not Detected";
  aqEl.className   = "stat-val " + (diag.acqueonTabDetected ? "s-yes" : "s-no");
  $("s-paused-count").textContent = diag.pausedTabCount ?? 0;

  const actionRaw = diag.lastAction || "";
  const actionEl  = $("s-last-action");
  if (!actionRaw || actionRaw === "None") {
    actionEl.textContent = "—";
    actionEl.className   = "stat-val v-none";
  } else if (actionRaw.toLowerCase().includes("pause")) {
    actionEl.textContent = "Audio paused";
    actionEl.className   = "stat-val v-pause";
  } else if (actionRaw.toLowerCase().includes("resume")) {
    actionEl.textContent = "Audio resumed";
    actionEl.className   = "stat-val v-resume";
  } else if (actionRaw.toLowerCase().includes("disabled")) {
    actionEl.textContent = "Extension off";
    actionEl.className   = "stat-val v-none";
  } else {
    actionEl.textContent = actionRaw;
    actionEl.className   = "stat-val";
  }

  // ── Feature 1: Audio Being Managed ──
  const list   = $("s-media-list");
  const ids    = Array.isArray(diag.pausedTabIds) ? diag.pausedTabIds : [];
  const urlMap = diag.pausedTabUrls || {};

  if (ids.length === 0) {
    list.innerHTML = '<div class="info-empty">No audio currently managed</div>';
  } else {
    list.innerHTML = ids.map((id) => {
      const name = friendlyTabName(id, urlMap);
      const icon = serviceIcon(name);
      return `<div class="media-item">
        <span class="media-icon">${icon}</span>
        <span class="media-name">${name}</span>
        <span class="media-badge">Managed</span>
      </div>`;
    }).join("");
  }

  // ── Feature 2: Protected Tabs ──
  const protList = $("s-protected-list");
  const protectedApps = [];

  if (diag.acqueonTabDetected) {
    // Determine which platform(s) based on available diag info.
    // We show Acqueon always if detected; SmartAgent if acqueonTabId matches
    // a known SmartAgent pattern — but we only have a tab ID, not a URL, for
    // the protected tab itself. Show both as "detected" since either may be active.
    protectedApps.push({ icon: "☎", name: "Acqueon" });
    // SmartAgent: show if we have evidence from events
    const hasSmartAgent = (diag.events || []).some((ev) =>
      /smartagent/i.test(ev.message)
    );
    if (hasSmartAgent) {
      protectedApps.push({ icon: "☎", name: "SmartAgent" });
    }
  }

  if (protectedApps.length === 0) {
    protList.innerHTML = '<div class="info-empty">No protected tabs detected</div>';
  } else {
    protList.innerHTML = protectedApps.map((app) =>
      `<div class="protected-item">
        <span class="protected-icon">${app.icon}</span>
        <span class="protected-name">${app.name}</span>
        <span class="protected-badge">Protected</span>
      </div>`
    ).join("");
  }

  // ── Feature 6: Statistics ──
  const stats = deriveStats(diag.events);
  $("stat-calls").textContent   = stats.calls;
  $("stat-pauses").textContent  = stats.pauses;
  $("stat-resumes").textContent = stats.resumes;

  $("stat-pause-rate").textContent = `${(diag.events || []).length}/25`;
  $("stat-pause-sub").textContent  = "recent logs only";

  // ── Toggle ──
  const enabled = diag.isEnabled !== false;
  const tog = $("s-toggle");
  const lbl = $("s-toggle-lbl");
  tog.classList.toggle("on", enabled);
  lbl.textContent = enabled ? "ON" : "OFF";
  lbl.className   = "toggle-lbl " + (enabled ? "on" : "off");

  // ── Feature 3: About — status ──
  const aboutStatus = $("about-status");
  if (aboutStatus) {
    aboutStatus.textContent = "Running";
    aboutStatus.className   = "about-val v-green";
    aboutStatus.style.color = "";
  }
}

// ── Toggle — UNCHANGED ────────────────────────────────────────────────────

$("s-toggle").addEventListener("click", () => {
  const currentlyOn = $("s-toggle").classList.contains("on");
  const newVal = !currentlyOn;
  chrome.runtime.sendMessage({ type: "SET_ENABLED", value: newVal }, () => {
    if (chrome.runtime.lastError) return;
    showToast(newVal ? "✓ Extension enabled" : "✓ Extension disabled");
    setTimeout(fetchDiag, 200);
  });
});

// ── Simple tab manual controls — UNCHANGED ────────────────────────────────

$("s-btn-pause").addEventListener("click", () => {
  $("s-btn-pause").textContent = "⏸ Sending…";
  chrome.runtime.sendMessage({ type: "TEST_PAUSE" }, () => {
    $("s-btn-pause").textContent = "⏸ Pause";
    showToast("✓ Pause triggered");
    setTimeout(fetchDiag, 600);
  });
});

$("s-btn-resume").addEventListener("click", () => {
  $("s-btn-resume").textContent = "▶ Sending…";
  chrome.runtime.sendMessage({ type: "TEST_RESUME" }, () => {
    $("s-btn-resume").textContent = "▶ Resume";
    showToast("✓ Resume triggered");
    setTimeout(fetchDiag, 600);
  });
});

$("s-btn-recover").addEventListener("click", () => {
  requestSafeRecovery($("s-btn-recover"), "↻ Recover safely");
});

$("s-btn-ref").addEventListener("click", fetchDiag);

// ── Task 1 — Clear Events button (v1.2, unchanged) ───────────────────────

$("btn-clear-events").addEventListener("click", () => {
  chrome.storage.local.get("diag", (r) => {
    if (chrome.runtime.lastError || !r?.diag) return;
    const cleared = Object.assign({}, r.diag, { events: [], errors: [], lastError: null });
    chrome.storage.local.set({ diag: cleared }, () => {
      render(cleared);
      renderSimple(cleared);
      showToast("✓ Events cleared");
    });
  });
});

// ── Task 2 — Compact Mode (v1.2, unchanged) ──────────────────────────────

const COMPACT_KEY = "amp_compact";

function applyCompact(on) {
  if (on) {
    document.body.setAttribute("data-compact", "");
  } else {
    document.body.removeAttribute("data-compact");
  }
  const lbl = $("compact-lbl");
  const tog = $("compact-toggle");
  lbl.textContent = on ? "ON" : "OFF";
  lbl.className   = "toggle-lbl " + (on ? "on" : "off");
  tog.classList.toggle("on", on);
}

(function initCompact() {
  let saved = false;
  try { saved = localStorage.getItem(COMPACT_KEY) === "true"; } catch (_) {}
  applyCompact(saved);
})();

$("compact-toggle").addEventListener("click", () => {
  const nowOn = document.body.hasAttribute("data-compact");
  const next  = !nowOn;
  applyCompact(next);
  try { localStorage.setItem(COMPACT_KEY, String(next)); } catch (_) {}
});

// ── Feature 4 — Export Diagnostics ───────────────────────────────────────

$("btn-export").addEventListener("click", () => {
  chrome.storage.local.get("diag", (r) => {
    if (chrome.runtime.lastError || !r?.diag) {
      showToast("⚠ No data to export");
      return;
    }
    const d = r.diag;

    // Derive theme from localStorage
    let theme = "auto";
    try { theme = localStorage.getItem(THEME_KEY) || "auto"; } catch (_) {}

    const lines = [];
    lines.push("Acqueon Media Pauser — Diagnostics Export");
    lines.push("==========================================");
    lines.push(`Exported:   ${new Date().toLocaleString("en-GB")}`);
    lines.push(`Version:    v3.0`);
    lines.push(`Theme:      ${theme}`);
    lines.push("");
    lines.push("── Current State ──");
    lines.push(`State:      ${d.currentState || "—"}`);
    lines.push(`Enabled:    ${d.isEnabled !== false ? "Yes" : "No"}`);
    lines.push(`Acqueon:    ${d.acqueonTabDetected ? "Detected" : "Not detected"}`);
    lines.push(`Paused:     ${d.pausedTabCount ?? 0} tab(s)`);
    lines.push(`Last Change:${d.lastStateChange || "—"}`);
    lines.push(`Last Action:${d.lastAction || "—"}`);
    lines.push(`Media Meth: ${d.mediaMethod || "—"}`);
    lines.push(`Last Pause: ${d.lastPauseTimestamp || "—"}`);
    lines.push(`Last Resume:${d.lastResumeTimestamp || "—"}`);
    lines.push(`Last Error: ${d.lastError || "None"}`);
    lines.push("");

    // Statistics
    const stats = deriveStats(d.events);
    lines.push("── Statistics ──");
    lines.push(`Calls Managed:   ${stats.calls}`);
    lines.push(`Media Pauses:    ${stats.pauses}`);
    lines.push(`Resumes:         ${stats.resumes}`);
    lines.push("");

    lines.push("── Events ──");
    (d.events || []).forEach((ev) => {
      lines.push(`[${ev.time}] ${ev.message}`);
    });
    if (!d.events || d.events.length === 0) lines.push("(none)");
    lines.push("");

    lines.push("── Errors ──");
    (d.errors || []).forEach((ev) => {
      lines.push(`[${ev.time}] ${ev.message}`);
    });
    if (!d.errors || d.errors.length === 0) lines.push("(none)");

    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    const ts   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.href     = url;
    a.download = `amp-diagnostics-${ts}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("✓ Diagnostics exported");
  });
});
