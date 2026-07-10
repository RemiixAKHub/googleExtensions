# Acqueon Media Pauser — Chrome Extension

Automatically pauses media in other tabs when an Acqueon call goes **Ongoing**,
and resumes it when the call enters **Wrapup**.

---

## Files

```
acqueon-media-pauser/
├── manifest.json   — Extension manifest (MV3)
├── background.js   — Service worker: media pause/resume logic
├── detector.js     — Content script: Acqueon call state detection
└── README.md
```

---

## Installation

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer mode** (toggle, top-right corner)
3. Click **"Load unpacked"**
4. Select the `acqueon-media-pauser` folder
5. The extension will appear in your extensions list

No API key or sign-in is required.

---

## How It Works

| Acqueon Status | Extension State | Action |
|---|---|---|
| Ready for Outbound | idle | Nothing |
| Busy + **Ongoing** | active | Pauses all audible tabs (except acqueon.com) |
| Busy + **Wrapup** | wrap | Resumes tabs that were paused |
| Back to Ready | idle | Fallback resume (if wrap missed) |

---

## Testing Steps

### Basic test

1. Open a YouTube video (or Spotify, SoundCloud, etc.) in a tab and let it play.
2. Open your Acqueon workspace in another tab.
3. Wait for a call to be presented — when the **Ongoing** badge appears, YouTube should **pause automatically**.
4. When the call moves to **Wrapup**, YouTube should **resume automatically**.

### Manual test (without a live call)

You can simulate state changes via the browser console on the Acqueon tab:

```js
// Simulate ACTIVE
chrome.runtime.sendMessage({ type: "CALL_STATE", state: "active" });

// Simulate WRAP
chrome.runtime.sendMessage({ type: "CALL_STATE", state: "wrap" });

// Simulate IDLE
chrome.runtime.sendMessage({ type: "CALL_STATE", state: "idle" });
```

### Checking logs

1. Go to `chrome://extensions`
2. Find **Acqueon Media Pauser** → click **"Service Worker"** (Inspect)
3. Open the **Console** tab
4. You will see:
   - `[AcqueonMP] CALL ACTIVE — paused media in N tab(s) (N element(s))`
   - `[AcqueonMP] CALL WRAP — resumed N element(s)`

### Checking detector.js logs

1. Open the Acqueon tab
2. Open DevTools → Console
3. You will see `[AcqueonMP] CALL ACTIVE`, `[AcqueonMP] CALL WRAP`, etc. as state changes occur

---

## Notes

- The extension **never pauses** the Acqueon tab itself.
- The extension **only resumes** media it previously paused (`_cmpWasPlaying` marker).
- If a user manually pauses something during a call, the extension will **not** resume it.
- The 3-second fallback interval is lightweight and only re-evaluates state — it does not spam pause/resume.
- No data leaves the browser. No analytics. No external requests.
