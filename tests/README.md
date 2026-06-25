# Tests

## Unit tests (no browser)

```sh
node tests/unit.mjs           # crypto, generator, domain matching
node tests/unit-sessions.mjs  # session bookkeeping (domain grouping, stop-on-last-tab)
```

## End-to-end (`e2e.mjs`)

Loads the unpacked extension in Chromium via Playwright and drives the real
options page, background worker, and content-script fill flow: vault creation,
add credential, password generator, lock/unlock persistence, wrong-password
rejection, in-page fill-icon injection + fill, and change-master-password.

Requires Playwright + Chromium. In this environment:

```sh
# one-time: make the global Playwright resolvable locally
ln -s "$(npm root -g)/playwright"      node_modules/playwright
ln -s "$(npm root -g)/playwright-core" node_modules/playwright-core

# run (headed Chromium under a virtual display)
xvfb-run -a node tests/e2e.mjs
```

The test points `executablePath` at the pre-installed Chromium
(`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). Loading an extension
requires full Chromium (not the headless shell), hence `xvfb-run`.

## Recording tests

```sh
xvfb-run -a node tests/encoding.mjs    # VP9 capture pipeline -> playable WebM (ffmpeg + real decoder)
xvfb-run -a node tests/offscreen.mjs   # offscreen engine: start/switch/stop -> chrome.downloads
```

`encoding.mjs` validates the exact `captureStream(0)` + `requestFrame()` + VP9
technique and plays the result back through Chromium's decoder (Playwright's
bundled ffmpeg has no VP9 *decoder*, so it's used only to confirm the container
and stream, not to decode).

`offscreen.mjs` drives `offscreen.js` as shipped, patching only
`getUserMedia` (test-side, via `addInitScript`) to supply a synthetic stream in
place of a real tab capture — real `tabCapture` can't be granted in automation
because it needs a genuine toolbar gesture. It writes incremental results to
`tests/.offscreen-results.txt` so progress is visible even if the run is killed.

Note: if your shell uses `errexit`, a leading `pkill` that matches nothing exits
non-zero and aborts the command before the test runs — guard cleanup with
`|| true`.
