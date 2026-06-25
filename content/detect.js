// Login-form detection. Classic content script (no ES modules — Chrome does not
// support module content scripts). Exposes helpers on a shared namespace that
// inject.js (loaded next in the same isolated world) reads.
(() => {
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetWidth > 0;
  }

  function findLoginPairs() {
    return [...document.querySelectorAll('input[type="password"]')]
      .filter(isVisible)
      .map(pw => ({ passwordField: pw, usernameField: findUserField(pw) }));
  }

  function findUserField(pw) {
    const before = [...document.querySelectorAll('input')].filter(i =>
      isVisible(i) &&
      ['text', 'email', 'tel', ''].includes(i.type) &&
      i !== pw &&
      (pw.compareDocumentPosition(i) & Node.DOCUMENT_POSITION_PRECEDING)
    );
    return before[before.length - 1] ?? null;
  }

  // Calls onNew for each new login pair found after the initial scan.
  function watchForForms(onNew) {
    const seen = new WeakSet();
    let timer = null;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        findLoginPairs().forEach(pair => {
          if (!seen.has(pair.passwordField)) {
            seen.add(pair.passwordField);
            onNew(pair);
          }
        });
      }, 300);
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  }

  self.__pwFiller = { isVisible, findLoginPairs, watchForForms };
})();
