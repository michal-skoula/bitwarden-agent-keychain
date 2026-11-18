// Decides whether a page URL is allowed to receive a vault item's credentials.
// Mirrors Bitwarden's URI match detection so the keychain fills exactly where
// the Bitwarden browser extension would, and nowhere else.

import { getDomain } from 'tldts';
import type { LoginUri } from './bitwarden.ts';

const MATCH_DOMAIN = 0;
const MATCH_HOST = 1;
const MATCH_STARTS_WITH = 2;
const MATCH_EXACT = 3;
const MATCH_REGEX = 4;
const MATCH_NEVER = 5;

function parse(raw: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
}

// Registrable domain ("accounts.google.com" -> "google.com"). Falls back to the
// hostname for IPs and single-label hosts like "localhost".
export function baseDomain(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

// Only https pages get credentials, unless the saved URI itself explicitly
// says http (e.g. a router admin page or a local dev server).
function schemeAllowed(page: URL, saved: URL): boolean {
  if (page.protocol === 'https:') return true;
  return page.protocol === 'http:' && saved.protocol === 'http:';
}

export function uriMatches(pageUrl: string, saved: LoginUri): boolean {
  const page = parse(pageUrl);
  if (!page || (page.protocol !== 'https:' && page.protocol !== 'http:')) return false;
  const match = saved.match ?? MATCH_DOMAIN;

  switch (match) {
    case MATCH_NEVER:
      return false;
    case MATCH_EXACT:
      return pageUrl === saved.uri;
    case MATCH_STARTS_WITH:
      return pageUrl.startsWith(saved.uri);
    case MATCH_REGEX:
      try {
        return new RegExp(saved.uri, 'i').test(pageUrl);
      } catch {
        return false;
      }
    case MATCH_HOST: {
      const s = parse(saved.uri);
      return !!s && schemeAllowed(page, s) && s.host === page.host;
    }
    case MATCH_DOMAIN:
    default: {
      const s = parse(saved.uri);
      if (!s || (s.protocol !== 'https:' && s.protocol !== 'http:')) return false;
      return schemeAllowed(page, s) && baseDomain(s.hostname) === baseDomain(page.hostname);
    }
  }
}

export function anyUriMatches(pageUrl: string, uris: LoginUri[]): boolean {
  return uris.some((u) => uriMatches(pageUrl, u));
}
