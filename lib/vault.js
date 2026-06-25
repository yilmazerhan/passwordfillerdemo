// Vault entry helpers: ID generation, domain extraction, domain matching.

export function newEntry(fields) {
  return {
    id:        crypto.randomUUID(),
    title:     fields.title     ?? '',
    url:       fields.url       ?? '',
    domain:    fields.domain    ?? extractDomain(fields.url ?? ''),
    username:  fields.username  ?? '',
    password:  fields.password  ?? '',
    notes:     fields.notes     ?? '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function extractDomain(urlOrHost) {
  try {
    const u = urlOrHost.includes('://') ? new URL(urlOrHost) : new URL('https://' + urlOrHost);
    return u.hostname;
  } catch {
    return urlOrHost;
  }
}

export function registrableDomain(hostname) {
  if (!hostname) return '';
  const h = hostname.replace(/:\d+$/, '').replace(/^\*\./, '');
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

export function matchesForDomain(vault, domain) {
  const target = registrableDomain(domain);
  return vault.filter(e => registrableDomain(e.domain) === target);
}
