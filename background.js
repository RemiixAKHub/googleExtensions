/**
 * background.js
 * Acqueon Media Pauser — Background Service Worker (v1.5)
 *
 * Media control strategy per site:
 *
 *  YouTube    — direct video element (.pause()/.play()) — always works
 *  Spotify    — aria-label="Pause" button click (stable accessibility attr)
 *               Falls back to aria-label="Pause playback"
 *  SoundCloud — aria-label="Pause current" button click (stable attr)
 *               Falls back to button[title*="Pause"]
 *  Generic    — audio/video element direct control
 *
 * Two-pass approach for every tab:
 *   Pass 1: try audio/video elements directly
 *   Pass 2: if pass 1 found nothing, try site-specific button click
 *
 * Resume is deliberately stricter than pause: it only resumes a DOM element
 * or control that this extension marked in the current document. It never
 * clicks a generic Play button merely because a tab was tracked earlier.
 *
 * Hotfix: soft media-control lookup misses are no longer recorded as real
 * health-impacting errors when the extension recovers or no media was present.
 */

"use strict";

// ── In-memory state ───────────────────────────────────────────────────────

const pausedTabs   = new Set(); // tabId → method used
const pauseMethod  = new Map(); // tabId → "element" | "button"
const pausedTabUrls = {};       // v1.6 — tabId → url string (display only, never affects pause/resume)
let currentState = "idle";
const callSources = new Map();  // `${tabId}:${frameId}` → { state, method, seenAt }

// ── v1.4: ON/OFF toggle and Acqueon tab ID tracking ───────────────────────
let isEnabled = true;
let acqueonTabId = null; // tabId of the detected Acqueon tab

// ── v1.5: Wrapup safe-resume token ───────────────────────────────────────
// Incremented whenever a new active call arrives, invalidating any
// in-flight deferred wrap resume so music stays paused for the new call.
let wrapResumeToken = 0;

// ── Diagnostics ───────────────────────────────────────────────────────────

const diag = {
  currentState:        "idle",
  lastStateChange:     null,
  detectionMethod:     "—",
  acqueonTabDetected:  false,
  lastAction:          "None",
  mediaMethod:         "—",
  pausedTabCount:      0,
  lastPauseTimestamp:  null,
  lastResumeTimestamp: null,
  lastError:           null,
  isEnabled:           true,   // v1.4
  acqueonTabId:        null,   // v1.4
  pausedTabIds:        [],     // v1.4 — list of currently paused tab IDs for Simple tab
  pausedTabUrls:       {},     // v1.6 — { tabId: url } for friendly name display only
  events: [],   // max 25
  errors: [],   // max 10
};

function ts() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}
function addEvent(msg) {
  diag.events.unshift({ time: ts(), message: msg });
  if (diag.events.length > 25) diag.events.length = 25;
  persist();
}
function addError(msg) {
  diag.errors.unshift({ time: ts(), message: msg });
  if (diag.errors.length > 10) diag.errors.length = 10;
  diag.lastError = msg;
  persist();
}

// ── Diagnostic classification ─────────────────────────────────────────────
//
// Some media-control lookups are expected to fail temporarily. For example,
// SoundCloud may briefly expose a different button while a track loads, or a
// fallback scan may inspect a media site that is not currently playing.
// These messages should not lower health/confidence when a later method
// succeeds or when there was nothing to pause/resume.
const SOFT_MEDIA_ERROR_RE = /(pause button not found|play button not found|no media found|no video or button found|ownership proof unavailable)/i;

function isSoftMediaError(msg) {
  return SOFT_MEDIA_ERROR_RE.test(String(msg || ""));
}

function cleanHistoricalSoftMediaErrors() {
  if (Array.isArray(diag.errors)) {
    diag.errors = diag.errors.filter((ev) => !isSoftMediaError(ev?.message));
  }
  if (isSoftMediaError(diag.lastError)) {
    diag.lastError = null;
  }
}

function tabHost(tab) {
  try { return new URL(tab?.url || "").hostname; } catch (_) { return `Tab ${tab?.id ?? "unknown"}`; }
}
function updateDiag(patch) {
  Object.assign(diag, patch);
  persist();
}
function persist() {
  chrome.storage.local.set({ diag }).catch(() => {});
}

chrome.storage.local.get(["diag", "pausedTabEntries", "isEnabled"]).then((r) => {
  if (r?.diag) {
    Object.assign(diag, r.diag);
    cleanHistoricalSoftMediaErrors();
    diag.pausedTabCount      = 0;
    diag.acqueonTabDetected  = false;
  }
  // Restore paused-tab tracking so resume works after a service-worker restart.
  if (Array.isArray(r?.pausedTabEntries)) {
    for (const [tabId, method] of r.pausedTabEntries) {
      pausedTabs.add(tabId);
      pauseMethod.set(tabId, method);
    }
    diag.pausedTabCount = pausedTabs.size;
    diag.pausedTabIds   = [...pausedTabs];
  }
  // v1.4: restore isEnabled
  if (typeof r?.isEnabled === "boolean") {
    isEnabled      = r.isEnabled;
    diag.isEnabled = isEnabled;
  }
}).catch(() => {});

// Write pausedTabs + pauseMethod to storage so they survive service-worker restarts.
function persistPausedTabs() {
  const entries = [...pausedTabs].map((id) => [id, pauseMethod.get(id) ?? "unknown"]);
  chrome.storage.local.set({ pausedTabEntries: entries }).catch(() => {});
  diag.pausedTabIds  = [...pausedTabs]; // keep diag in sync for Simple tab
  diag.pausedTabUrls = Object.fromEntries([...pausedTabs].map((id) => [id, pausedTabUrls[id] ?? ""])); // v1.6
}

// ── Injected payload: PAUSE ───────────────────────────────────────────────
// Returns { method, count }  — serialised and run inside the target tab

function injectedPause() {
  function markAndPauseButton(btn) {
    btn._cmpWasButton = true;
    btn._cmpUserIntervened = false;
    if (!btn._cmpUserIntentListener) {
      btn._cmpUserIntentListener = true;
      btn.addEventListener("click", () => {
        if (btn._cmpWasButton && !btn._cmpClicking) btn._cmpUserIntervened = true;
      }, true);
    }
    btn._cmpClicking = true;
    btn.click();
    btn._cmpClicking = false;
  }

  // ── Pass 1: direct audio/video elements ──────────────────────────────
  const mediaEls = document.querySelectorAll("audio, video");
  let count = 0;
  mediaEls.forEach((el) => {
    if (!el.paused && !el._cmpWasPlaying) {
      el._cmpWasPlaying = true;
      el._cmpUserIntervened = false;
      if (!el._cmpUserIntentListener) {
        el._cmpUserIntentListener = true;
        el.addEventListener("play", () => {
          if (el._cmpWasPlaying && !el._cmpResuming) el._cmpUserIntervened = true;
        });
      }
      el.pause();
      count++;
    }
  });
  if (count > 0) return { method: "audio/video element", count };

  // ── Pass 2: site-specific button click ───────────────────────────────

  // Helper: find the first visible, clickable button matching a selector
  function findBtn(selectors) {
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el && typeof el.click === "function") return el;
        }
      } catch (_) {}
    }
    return null;
  }

  const host = location.hostname;

  // ── Spotify ──────────────────────────────────────────────────────────
  // Uses dynamically generated class names — must use aria-label
  if (host.includes("spotify.com")) {
    const btn = findBtn([
      '[aria-label="Pause"]',
      '[aria-label="Pause playback"]',
      '[data-testid="control-button-pause"]',
      'button[title="Pause"]',
    ]);
    if (btn) {
      markAndPauseButton(btn);
      return { method: "Spotify button", count: 1 };
    }
    return { method: "Spotify button", count: 0, error: "Pause button not found" };
  }

  // ── SoundCloud ───────────────────────────────────────────────────────
  if (host.includes("soundcloud.com")) {
    const btn = findBtn([
      '[aria-label="Pause current"]',
      '[aria-label="Pause"]',
      'button.playControl[title*="Pause"]',
      'button[title="Pause"]',
    ]);
    if (btn) {
      markAndPauseButton(btn);
      return { method: "SoundCloud button", count: 1 };
    }
    return { method: "SoundCloud button", count: 0, error: "Pause button not found" };
  }

  // ── YouTube ──────────────────────────────────────────────────────────
  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    // YouTube always has a real video element — try it again more broadly
    const vid = document.querySelector("video");
    if (vid && !vid.paused) {
      vid._cmpWasPlaying = true;
      vid.pause();
      return { method: "YouTube video element", count: 1 };
    }
    // Button fallback
    const btn = findBtn([
      '.ytp-play-button[aria-label*="Pause"]',
      '[aria-label="Pause (k)"]',
      '[aria-label="Pause"]',
    ]);
    if (btn) {
      markAndPauseButton(btn);
      return { method: "YouTube button", count: 1 };
    }
    return { method: "YouTube", count: 0, error: "No video or button found" };
  }

  // ── Generic fallback button ───────────────────────────────────────────
  const btn = findBtn([
    '[aria-label="Pause"]',
    '[aria-label*="Pause"]',
    'button[title="Pause"]',
  ]);
  if (btn) {
    markAndPauseButton(btn);
    return { method: "generic button", count: 1 };
  }

  return { method: "none", count: 0, error: "No media found" };
}

// ── Injected payload: RESUME ──────────────────────────────────────────────

function injectedResume() {
  // ── Pass 1: direct audio/video elements ──────────────────────────────
  const mediaEls = document.querySelectorAll("audio, video");
  let count = 0;
  mediaEls.forEach((el) => {
    if (el._cmpWasPlaying && !el._cmpUserIntervened) {
      el._cmpResuming = true;
      el._cmpWasPlaying = false;
      el.play().catch(() => {}).finally(() => { el._cmpResuming = false; });
      count++;
    }
  });
  if (count > 0) return { method: "audio/video element", count };

  // Button controls may only resume when the same DOM control is still
  // present, remains marked, and has not received a user click since pause.
  // A reload, SPA replacement, or user interaction therefore fails closed.
  for (const btn of document.querySelectorAll("button, [role='button']")) {
    if (!btn._cmpWasButton || btn._cmpUserIntervened || typeof btn.click !== "function") continue;
    const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("title") || ""} ${btn.textContent || ""}`;
    if (!/\b(play|resume)\b/i.test(label)) continue;
    btn._cmpClicking = true;
    btn._cmpWasButton = false;
    btn.click();
    btn._cmpClicking = false;
    return { method: "verified button", count: 1 };
  }

  return { method: "none", count: 0, error: "Ownership proof unavailable; media left paused" };
}

// ── Protected hostname list ───────────────────────────────────────────────
//
// Any tab whose URL contains one of these strings is NEVER paused.
// Add new call-control hostnames here — no other code needs to change.
//
// Current protected environments:
//   acqueon.com              — Acqueon legacy / on-prem
//   amplifyapp.com           — Acqueon cloud (prod.d2if1ecm226hjg.amplifyapp.com)
//   smartagent.app           — SmartAgent (tw.smartagent.app)
//   chrome://                — Internal Chrome pages
//   chrome-extension://      — Extension pages (handled separately below)

const PROTECTED_HOSTNAMES = [
  "acqueon.com",
  "amplifyapp.com",
  "smartagent.app",
];

/**
 * Returns true if a tab should NEVER be paused.
 * Checks both the URL hostname list and the stored acqueonTabId.
 */
function isProtectedTab(tab) {
  if (!tab.url) return true; // no URL — skip safely
  if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) return true;
  for (const host of PROTECTED_HOSTNAMES) {
    if (tab.url.includes(host)) return true;
  }
  // Belt-and-suspenders: also skip by the tab ID recorded when detector.js
  // sent its last heartbeat (covers any hostname not yet in the list above).
  if (acqueonTabId !== null && tab.id === acqueonTabId) return true;
  return false;
}

// ── Tab scanning ──────────────────────────────────────────────────────────

async function scanAndPause() {
  let totalCount = 0;
  const methods  = [];
  const softIssues = [];

  // Do not rely on Chrome's audible flag: it can lag behind real playback and
  // causes missed pauses when another tab is already marked audible.
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) {}
  const usedFallbackScan = true;
  addEvent("Scanning open tabs for active media");

  for (const tab of tabs) {
    // v1.5: single authoritative protection check — never pauses call-control tabs
    if (isProtectedTab(tab)) continue;

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   injectedPause,
      });
      const res = results?.[0]?.result;
      if (!res) continue;

      if (res.error) {
        const msg = `Tab ${tab.id} (${tabHost(tab)}): ${res.error}`;
        if (isSoftMediaError(res.error)) {
          softIssues.push(msg);
        } else {
          addError(msg);
        }
      }

      if (res.count > 0) {
        pausedTabs.add(tab.id);
        pauseMethod.set(tab.id, res.method);
        pausedTabUrls[tab.id] = tab.url || ""; // v1.6 — capture URL for friendly display
        persistPausedTabs();
        totalCount += res.count;
        methods.push(res.method);
        // v1.6: log with friendly hostname so Developer tab shows "Spotify" not "Tab 693963098"
        addEvent(`PAUSE METHOD: ${res.method} (${tabHost(tab)})`);
      }
    } catch (err) {
      addError(`Inject failed (tab ${tab.id}): ${err.message}`);
    }
  }

  // Only convert soft lookup issues into a real error when we were scanning
  // genuinely audible tabs and every pause method failed. If at least one
  // source was paused, the lookup issue recovered automatically and should not
  // reduce health/confidence.
  if (softIssues.length > 0) {
    if (!usedFallbackScan && totalCount === 0) {
      addError(`Pause failed: audible media controls could not be located (${softIssues[0]})`);
    } else if (totalCount > 0) {
      addEvent("Recovered automatically from media-control lookup miss");
    }
  }

  return { totalCount, methods };
}

async function scanAndResume() {
  let totalCount = 0;
  const methods  = [];
  const softIssues = [];
  const tabsToResume = [...pausedTabs];

  for (const tabId of tabsToResume) {
    // v1.4: never resume the Acqueon tab
    if (acqueonTabId !== null && tabId === acqueonTabId) {
      pausedTabs.delete(tabId);
      pauseMethod.delete(tabId);
      continue;
    }

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func:   injectedResume,
      });
      const res = results?.[0]?.result;
      if (!res) { pausedTabs.delete(tabId); pauseMethod.delete(tabId); persistPausedTabs(); continue; }

      if (res.error) {
        const msg = `Tab ${tabId}: ${res.error}`;
        if (isSoftMediaError(res.error)) {
          softIssues.push(msg);
        } else {
          addError(msg);
        }
      }

      if (res.count > 0) {
        methods.push(res.method);
        totalCount += res.count;
        addEvent(`RESUME METHOD: ${res.method}`);
      }
    } catch (err) {
      addError(`Resume failed (tab ${tabId}): ${err.message}`);
    }
    pausedTabs.delete(tabId);
    pauseMethod.delete(tabId);
  }
  persistPausedTabs();

  // Only show a real resume error when there was media to resume and every
  // resume method failed. If at least one source resumed, temporary selector
  // misses are treated as recovered diagnostics.
  if (softIssues.length > 0) {
    if (tabsToResume.length > 0 && totalCount === 0) {
      addError(`Resume failed: playback controls could not be located (${softIssues[0]})`);
    } else if (totalCount > 0) {
      addEvent("Recovered automatically from media-control lookup miss");
    }
  }

  return { totalCount, methods };
}

function pruneCallSources() {
  const cutoff = Date.now() - 30000;
  for (const [key, source] of callSources) {
    if (source.seenAt < cutoff) callSources.delete(key);
  }
}

function aggregateCallState() {
  pruneCallSources();
  const states = [...callSources.values()].map((source) => source.state);
  if (states.includes("active")) return "active";
  if (states.includes("wrap")) return "wrap";
  return "idle";
}

function injectedOwnershipCheck() {
  const markedMedia = [...document.querySelectorAll("audio, video")]
    .some((el) => el._cmpWasPlaying && !el._cmpUserIntervened);
  const markedButton = [...document.querySelectorAll("button, [role='button']")]
    .some((el) => el._cmpWasButton && !el._cmpUserIntervened);
  return markedMedia || markedButton;
}

async function recoverSafely() {
  let removed = 0;
  for (const tabId of [...pausedTabs]) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedOwnershipCheck,
      });
      if (!results?.[0]?.result) {
        pausedTabs.delete(tabId);
        pauseMethod.delete(tabId);
        delete pausedTabUrls[tabId];
        removed++;
      }
    } catch (_) {
      pausedTabs.delete(tabId);
      pauseMethod.delete(tabId);
      delete pausedTabUrls[tabId];
      removed++;
    }
  }
  persistPausedTabs();
  updateDiag({ pausedTabCount: pausedTabs.size, lastAction: "Safe Recovery" });
  addEvent(`Safe recovery completed — removed ${removed} stale ownership record(s)`);

  // Ask known detector frames to publish their current state again. This is
  // reconciliation only; it never causes a resume on its own.
  const protectedTabs = await chrome.tabs.query({});
  for (const tab of protectedTabs) {
    if (isProtectedTab(tab)) chrome.tabs.sendMessage(tab.id, { type: "RECHECK_STATE" }).catch(() => {});
  }
  for (const [key] of callSources) {
    const [tabId, frameId] = key.split(":").map(Number);
    chrome.tabs.sendMessage(tabId, { type: "RECHECK_STATE" }, { frameId }).catch(() => {});
  }
  return { removed, remaining: pausedTabs.size };
}

// ── Core handlers ─────────────────────────────────────────────────────────

async function handleActive(detMethod) {
  if (currentState === "active") return;
  currentState = "active";
  // v1.5: invalidate any deferred wrap resume that may be waiting
  wrapResumeToken++;
  updateDiag({ currentState: "active", lastStateChange: ts(), detectionMethod: detMethod || "unknown" });
  addEvent("CALL ACTIVE");

  const { totalCount, methods } = await scanAndPause();

  const mediaMethodStr = methods.length > 0 ? methods.join(", ") : "none";
  const pauseDiagPatch = {
    lastAction:         "Pause Attempt",
    mediaMethod:        mediaMethodStr,
    pausedTabCount:     pausedTabs.size,
    lastPauseTimestamp: ts(),
  };
  if (totalCount > 0) pauseDiagPatch.lastError = null;
  updateDiag(pauseDiagPatch);
  addEvent(`Paused ${pausedTabs.size} tab(s) via: ${mediaMethodStr}`);
  console.log(`[AcqueonMP] CALL ACTIVE — ${pausedTabs.size} tab(s), method: ${mediaMethodStr}`);
}

async function handleResume(trigger) {
  if (currentState === "idle" && trigger === "idle") return;

  currentState = trigger === "wrap" ? "wrap" : "idle";
  updateDiag({ currentState: currentState, lastStateChange: ts() });

  const label = trigger === "wrap" ? "CALL WRAP" : "CALL IDLE (fallback)";
  addEvent(label);

  // v1.5: For wrap triggers, defer the actual resume by 1500 ms.
  // This gives time for a rapid next-call (active) signal to arrive and
  // increment wrapResumeToken, which cancels the resume safely.
  if (trigger === "wrap") {
    const myToken = ++wrapResumeToken;
    addEvent(`Wrap resume pending — token ${myToken} (1.5 s safety delay)`);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Check 1: a new call arrived during the delay → abort
    if (wrapResumeToken !== myToken) {
      addEvent(`Wrap resume CANCELLED — new call detected (token mismatch)`);
      console.log(`[AcqueonMP] Wrap resume cancelled — new call arrived during delay`);
      return;
    }
    // Check 2: state moved back to active for any other reason → abort
    if (currentState === "active") {
      addEvent(`Wrap resume CANCELLED — state is active`);
      return;
    }
  }

  const { totalCount, methods } = await scanAndResume();

  const mediaMethodStr = methods.length > 0 ? methods.join(", ") : "none";
  const resumeDiagPatch = {
    lastAction:          "Resume Attempt",
    mediaMethod:         mediaMethodStr,
    pausedTabCount:      0,
    lastResumeTimestamp: ts(),
  };
  if (totalCount > 0) resumeDiagPatch.lastError = null;
  updateDiag(resumeDiagPatch);
  addEvent(`Resumed ${totalCount} element(s) via: ${mediaMethodStr}`);
  console.log(`[AcqueonMP] ${label} — ${totalCount} element(s), method: ${mediaMethodStr}`);

  currentState = "idle";
  updateDiag({ currentState: "idle" });
}

// ── Message listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message?.type === "GET_STATUS") {
    sendResponse({ ok: true, diag });
    return true;
  }

  if (message?.type === "ACQUEON_TAB_ALIVE") {
    // v1.4: store the tab ID so we can exclude it from media control
    if (sender?.tab?.id != null) {
      acqueonTabId = sender.tab.id;
      updateDiag({ acqueonTabDetected: true, acqueonTabId });
    } else {
      updateDiag({ acqueonTabDetected: true });
    }
    if (sender?.tab?.id != null) {
      callSources.set(`${sender.tab.id}:${sender.frameId ?? 0}`, {
        state: message.state || "idle",
        method: message.method || "heartbeat",
        seenAt: Date.now(),
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  // v1.4: ON/OFF toggle messages
  if (message?.type === "SET_ENABLED") {
    isEnabled      = !!message.value;
    diag.isEnabled = isEnabled;
    chrome.storage.local.set({ isEnabled }).catch(() => {});
    persist();
    if (!isEnabled) {
      // Clear tracking immediately when turned off
      pausedTabs.clear();
      pauseMethod.clear();
      persistPausedTabs();
      updateDiag({ pausedTabCount: 0, pausedTabIds: [], lastAction: "Extension Disabled" });
      addEvent("Extension DISABLED — tracking cleared");
    } else {
      addEvent("Extension ENABLED");
    }
    sendResponse({ ok: true, isEnabled });
    return true;
  }

  if (message?.type === "GET_ENABLED") {
    sendResponse({ ok: true, isEnabled });
    return true;
  }

  if (message?.type === "TEST_PAUSE") {
    if (!isEnabled) { sendResponse({ ok: false, reason: "disabled" }); return true; }
    addEvent("TEST: manual pause triggered");
    handleActive("testButton").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "TEST_RESUME") {
    if (!isEnabled) { sendResponse({ ok: false, reason: "disabled" }); return true; }
    addEvent("TEST: manual resume triggered");
    handleResume("wrap").then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type === "RECOVER_SAFELY") {
    recoverSafely().then((result) => sendResponse({ ok: true, ...result }));
    return true;
  }

  if (message?.type === "CALL_STATE") {
    // Track the tab ID for any call-control host, not just acqueon.com.
    // Uses PROTECTED_HOSTNAMES as the single source of truth so this
    // stays in sync automatically if the list is ever extended.
    const senderUrl = sender?.tab?.url || "";
    if (PROTECTED_HOSTNAMES.some((h) => senderUrl.includes(h))) {
      if (sender?.tab?.id != null) {
        acqueonTabId = sender.tab.id;
        updateDiag({ acqueonTabDetected: true, acqueonTabId });
      } else {
        updateDiag({ acqueonTabDetected: true });
      }
    }

    // v1.4: ignore call state changes when disabled
    if (!isEnabled) { sendResponse({ ok: true, reason: "disabled" }); return true; }

    const { state, method } = message;
    if (sender?.tab?.id != null) {
      callSources.set(`${sender.tab.id}:${sender.frameId ?? 0}`, {
        state,
        method: method || "unknown",
        seenAt: Date.now(),
      });
    }
    const aggregateState = aggregateCallState();
    const aggregateMethod = method || "unknown";
    if (message.recoveryOnly) {
      currentState = aggregateState;
      updateDiag({
        currentState: aggregateState,
        lastStateChange: ts(),
        detectionMethod: aggregateMethod,
      });
      addEvent(`Safe recovery rechecked Acqueon state: ${aggregateState}`);
      sendResponse({ ok: true, recoveryOnly: true });
      return true;
    }
    switch (aggregateState) {
      case "active": handleActive(aggregateMethod).then(() => sendResponse({ ok: true })); return true;
      case "wrap":   handleResume("wrap").then(() => sendResponse({ ok: true })); return true;
      case "idle":
        if (currentState === "active" || currentState === "wrap") {
          handleResume("idle").then(() => sendResponse({ ok: true }));
        } else {
          currentState = "idle";
          updateDiag({ currentState: "idle" });
          sendResponse({ ok: true });
        }
        return true;
      default: sendResponse({ ok: false }); return true;
    }
  }

  return false;
});

// ── Tab close cleanup ─────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  if (pausedTabs.has(tabId)) {
    pausedTabs.delete(tabId);
    pauseMethod.delete(tabId);
    delete pausedTabUrls[tabId]; // v1.6
    persistPausedTabs();
    updateDiag({ pausedTabCount: pausedTabs.size });
  }
  // v1.4: clear acqueonTabId if that tab closes
  if (tabId === acqueonTabId) {
    acqueonTabId = null;
    updateDiag({ acqueonTabDetected: false, acqueonTabId: null });
  }
  for (const key of callSources.keys()) {
    if (key.startsWith(`${tabId}:`)) callSources.delete(key);
  }
});
