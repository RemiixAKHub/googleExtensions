/**
 * detector.js
 * Acqueon Media Pauser — Content Script (v1.5)
 *
 * Detection strategy — two layers, most specific first:
 *
 * LAYER 1 — CSS class selectors (precise, from inspected DOM):
 *
 *   WRAP signals (checked FIRST — more specific):
 *     span.ongoing-view.onhold-view   — confirmed Wrapup badge (orange bg)
 *     span.agentstatusname.ss-name-time.state-chage.pl-0
 *                                     — agent status name element (Wrapup text)
 *     span.ss-name-time.state-time.lastchild-time
 *                                     — state timer shown during wrap
 *
 *   ACTIVE signals:
 *     span.ongoing-view.ongoing-preview — confirmed active-call badge (green bg)
 *     span.ongoing-view                 — bare fallback if neither specific
 *                                         class matched (treat as active)
 *
 *   TIMER signal (secondary):
 *     span.ai-timer                — active call timer (present during Ongoing)
 *
 * LAYER 2 — innerText fallback:
 *   If no CSS match, fall back to scanning document.body.innerText for
 *   "Ongoing" / "Wrapup" keywords (original approach).
 *
 * LAYER 3 — targeted element observer (v1.5):
 *   A second MutationObserver watches span.ongoing-view.onhold-view directly
 *   for class attribute changes. Fires immediately on transition, before the
 *   body-level observer or fallback interval would catch it.
 *
 * Runs in ALL frames (manifest all_frames: true) so it catches the
 * Acqueon agent panel wherever it loads — top frame or iframe.
 *
 * State model:  idle → active → wrap → idle
 */

(function () {
  "use strict";

  let currentState    = "idle";
  let detectionMethod = "interval";

  // ── CSS-based detection (primary — uses real inspected class names) ───────

  function detectByCSS() {
    // Both active and wrapup use the same base element (span.ongoing-view)
    // but with a different second class, confirmed by DOM inspection:
    //
    //   ACTIVE  → span.ongoing-view.ongoing-preview  (green bg, "Ongoing" text)
    //   WRAPUP  → span.ongoing-view.onhold-view       (orange bg, "Wrapup" text)
    //
    // Check both specific selectors BEFORE the bare span.ongoing-view fallback
    // so we always get the right state.

    // ── ACTIVE: confirmed class during a live call ──
    if (document.querySelector("span.ongoing-view.ongoing-preview")) {
      return "active";
    }

    // ── WRAP: confirmed class during wrapup ──
    if (document.querySelector("span.ongoing-view.onhold-view")) {
      return "wrap";
    }

    // ── Secondary wrap signals ──
    if (document.querySelector("span.agentstatusname.ss-name-time.state-chage.pl-0")) {
      return "wrap";
    }
    if (document.querySelector("span.ss-name-time.state-time.lastchild-time")) {
      return "wrap";
    }

    // ── Bare ongoing-view fallback (neither specific class matched) ──
    // Treat as active — it's safer to pause than to miss a call.
    if (document.querySelector("span.ongoing-view")) {
      return "active";
    }

    // Active timer span — secondary active signal
    if (document.querySelector("span.ai-timer")) {
      if (!document.querySelector("span.agentstatusname.ss-name-time")) {
        return "active";
      }
    }

    return null; // no CSS signal found
  }

  // ── Text-based detection (fallback) ──────────────────────────────────────

  function detectByText() {
    const text = document.body ? document.body.innerText : "";
    if (/\bOngoing\b/i.test(text))      return "active";
    if (/\bWrap[\s-]?up\b/i.test(text)) return "wrap";
    return null;
  }

  // ── Combined detection ────────────────────────────────────────────────────

  function detectCallState() {
    const cssResult = detectByCSS();
    if (cssResult !== null) return { state: cssResult, method: "cssSelector" };

    const textResult = detectByText();
    if (textResult !== null) return { state: textResult, method: "textFallback" };

    return { state: "idle", method: detectionMethod };
  }

  // ── Emit ──────────────────────────────────────────────────────────────────

  function emitState(newState, method) {
    if (newState === currentState) return;
    currentState    = newState;
    detectionMethod = method || detectionMethod;

    try {
      chrome.runtime.sendMessage({
        type:   "CALL_STATE",
        state:  newState,
        method: detectionMethod,
      }, () => { void chrome.runtime.lastError; });
    } catch (e) {
      // Extension context invalidated — ignore
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  function sendHeartbeat() {
    try {
      chrome.runtime.sendMessage({ type: "ACQUEON_TAB_ALIVE" }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {}
  }

  // ── Evaluate ─────────────────────────────────────────────────────────────

  function evaluate(fallbackMethod) {
    const { state, method } = detectCallState();
    // method from detectCallState takes priority; fallbackMethod is used
    // only when detectCallState returns idle with no CSS/text signal
    emitState(state, method !== detectionMethod ? method : fallbackMethod);
  }

  // ── MutationObserver ──────────────────────────────────────────────────────

  const observer = new MutationObserver(() => {
    evaluate("mutationObserver");
  });

  function startObserver() {
    const target = document.body || document.documentElement;
    if (!target) return;
    observer.observe(target, {
      childList:     true,
      subtree:       true,
      characterData: true,
      attributes:    true,       // catch class changes on existing elements
      attributeFilter: ["class"] // only care about class mutations
    });
    evaluate("mutationObserver");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver);
  } else {
    startObserver();
  }

  // ── v1.5: Targeted element observer ──────────────────────────────────────
  // Watches span.ongoing-view.onhold-view directly for class attribute changes.
  // This fires immediately when the badge transitions, before the body-level
  // observer or 2 s fallback interval would process it.
  // ✅ ADDED

  const elementObserver = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      if (mut.type !== "attributes" || mut.attributeName !== "class") continue;

      const el = mut.target;
      const classList = el.classList;

      // The element being watched was found via span.ongoing-view.onhold-view.
      // If it no longer has ongoing-view, the call has fully ended → idle.
      // If it still has ongoing-view but its text content says "Wrapup", → wrap.
      // We re-run the full CSS detection rather than guessing from class alone,
      // so all existing logic stays authoritative.
      evaluate("elementObserver");
    }
  });

  function attachElementObserver() {
    // The badge element may not exist yet at page load — poll briefly for it.
    const el = document.querySelector("span.ongoing-view.onhold-view") ||
               document.querySelector("span.ongoing-view");
    if (el) {
      elementObserver.observe(el, {
        attributes:      true,
        attributeFilter: ["class"],
      });
    }
    // Also watch for the element being added to the DOM later (new call arrives)
    // by hooking into the existing body-level observer via a childList sentinel.
    // No extra observer needed — the body observer already fires on childList
    // changes, which will call evaluate() and re-run detectByCSS().
  }

  // Run after startObserver so the body observer is already active.
  attachElementObserver();

  // Re-attach when the body-level observer fires a childList mutation —
  // the badge element may have been replaced by a new call.
  // We do this by wrapping the existing observer callback non-destructively.
  const _origObserver = observer;
  const _origCallback = _origObserver.takeRecords; // just a reference check
  // Instead of replacing the observer, add a lightweight DOM poller that
  // re-attaches elementObserver whenever the badge element is replaced.
  // Runs only if elementObserver has no observed nodes (i.e. badge was removed).
  setInterval(() => {
    // elementObserver.takeRecords().length === 0 means it may have lost its target
    const badge = document.querySelector("span.ongoing-view.onhold-view") ||
                  document.querySelector("span.ongoing-view");
    if (badge) {
      // Disconnect and re-observe to ensure we're on the current DOM node
      elementObserver.disconnect();
      elementObserver.observe(badge, {
        attributes:      true,
        attributeFilter: ["class"],
      });
    }
  }, 3000);

  // ── Fallback interval ─────────────────────────────────────────────────────
  setInterval(() => evaluate("fallbackCheck"), 2000);

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  sendHeartbeat();
  setInterval(sendHeartbeat, 10000);

})();
