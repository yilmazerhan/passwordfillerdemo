// Unit tests for the pure session bookkeeping (no Chrome APIs).
// Run: node tests/unit-sessions.mjs
import { domainOf, SessionStore } from '../lib/sessions.js';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else      { fail++; console.error(`FAIL  ${name}`); }
};

// domainOf
check('domainOf full url -> registrable', domainOf('https://mail.google.com/inbox') === 'google.com');
check('domainOf http ok',                 domainOf('http://example.com/login') === 'example.com');
check('domainOf ignores chrome://',       domainOf('chrome://extensions') === '');
check('domainOf ignores about:blank',     domainOf('about:blank') === '');
check('domainOf empty for undefined',     domainOf(undefined) === '');

// session lifecycle
{
  const s = new SessionStore();
  s.create('example.com', 1, 'sid-1', 'f.webm');
  s.addTab('example.com', 2);
  s.addTab('example.com', 3);
  check('three tabs in session', s.get('example.com').tabIds.size === 3);

  check('removing non-last keeps session', s.removeTab(2) === null && s.hasDomain('example.com'));

  // current tab follows when current is removed
  s.get('example.com').currentTabId = 3;
  s.removeTab(3);
  check('currentTabId reassigned after removal', s.get('example.com').currentTabId === 1);

  const ended = s.removeTab(1);
  check('removing last tab ends session', ended && ended.domain === 'example.com');
  check('session gone after end', !s.hasDomain('example.com'));
}

// multiple concurrent domains
{
  const s = new SessionStore();
  s.create('a.com', 10, 'a', 'a.webm');
  s.create('b.com', 20, 'b', 'b.webm');
  check('two concurrent sessions', s.all().length === 2);
  const ended = s.removeTab(10);
  check('closing one domain ends only that one', ended.domain === 'a.com' && s.hasDomain('b.com'));
}

// persistence round-trip
{
  const s = new SessionStore();
  s.create('x.com', 5, 'x-1', 'x.webm');
  s.addTab('x.com', 6);
  const json = s.toJSON();
  const r = SessionStore.fromJSON(JSON.parse(JSON.stringify(json)));
  check('fromJSON restores tabs as Set', r.get('x.com').tabIds.has(6) && r.get('x.com').tabIds.size === 2);
  check('fromJSON restores currentTabId', r.get('x.com').currentTabId === 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
