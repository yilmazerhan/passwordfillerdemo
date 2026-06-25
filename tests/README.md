# Tests

## Unit tests (`unit.mjs`)

Pure-module tests for crypto, generator, and domain matching. No browser needed.

```sh
node tests/unit.mjs
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
