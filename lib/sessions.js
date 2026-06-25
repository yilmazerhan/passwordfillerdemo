// Pure session bookkeeping for tab-session recording. No Chrome APIs here so it
// can be unit-tested in isolation. A session is keyed by registrable domain and
// tracks which tabs belong to it; when the last tab closes the session ends.
import { registrableDomain, extractDomain } from './vault.js';

export function domainOf(url) {
  if (!url || !/^https?:/.test(url)) return ''; // ignore chrome://, about:, etc.
  return registrableDomain(extractDomain(url));
}

export class SessionStore {
  constructor() {
    this.byDomain = new Map(); // domain -> { id, domain, tabIds:Set<number>, filename, currentTabId }
  }

  get(domain)      { return this.byDomain.get(domain); }
  all()            { return [...this.byDomain.values()]; }
  hasDomain(d)     { return this.byDomain.has(d); }

  create(domain, tabId, id, filename) {
    const session = { id, domain, tabIds: new Set([tabId]), filename, currentTabId: tabId };
    this.byDomain.set(domain, session);
    return session;
  }

  addTab(domain, tabId) {
    const s = this.byDomain.get(domain);
    if (s) s.tabIds.add(tabId);
    return s;
  }

  // Remove a tab from whatever session contains it. Returns the session if it
  // became empty (i.e. should stop), else null.
  removeTab(tabId) {
    for (const s of this.byDomain.values()) {
      if (s.tabIds.delete(tabId)) {
        if (s.tabIds.size === 0) { this.byDomain.delete(s.domain); return s; }
        if (s.currentTabId === tabId) s.currentTabId = [...s.tabIds][0];
        return null;
      }
    }
    return null;
  }

  delete(domain) { this.byDomain.delete(domain); }

  toJSON() {
    return this.all().map(s => ({ ...s, tabIds: [...s.tabIds] }));
  }

  static fromJSON(arr) {
    const store = new SessionStore();
    for (const s of arr ?? []) {
      store.byDomain.set(s.domain, { ...s, tabIds: new Set(s.tabIds) });
    }
    return store;
  }
}
