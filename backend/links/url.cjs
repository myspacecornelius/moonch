'use strict';
/* Which links the loader opens. Pure: no I/O, no DNS. A refusal names the reason and never repeats the pasted text (a link can carry a
   signature or a share token).

   validateLink   the pasted task link. https only, a DNS name (never a number or a bracketed address), no user name or password, no
                  hidden or control characters, no internal or special-use name, the standard port or 1024 to 65535, at most 2048
                  characters. http is accepted only for localhost and 127.0.0.1 when the loader was built with allowLoopback (tests).
   fileUrlAllowed every URL the loader later acts on while it fetches a file (the link, each redirect hop): the same rules, plus the
                  task page's own host is always fine.
   Not done here (the threat model's consent cards and address checks): the person is not asked to confirm the host and no DNS answer is
   checked against private address ranges. Exports: validateLink, fileUrlAllowed, hostProblem, pathOf. */

const net = require('node:net');

const MAX_LINK_CHARS = 2048;
const MAX_PATH_CHARS = 1024;
const MAX_FILE_URL_CHARS = 8192;
/* Anything the URL parser would silently drop or that can hide text: C0/C1 controls, DEL, line and paragraph separators, zero-width and
   bidi controls, BOM, word joiner and invisible operators. */
const HIDDEN_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const INTERNAL_SUFFIXES = ['localhost', 'local', 'localdomain', 'internal', 'home.arpa', 'lan', 'intranet', 'corp', 'home', 'private', 'onion', 'arpa'];
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

const fail = (code, message) => ({ ok: false, code, message });

/* null when the host name is acceptable, else { code, message }. */
function hostProblem(hostname, { allowLoopback = false } = {}) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  if (LOOPBACK.has(host)) return allowLoopback ? null : fail('reserved-name', 'Names for this computer are not accepted.');
  if (host.startsWith('[') || net.isIP(host) || /^[0-9a-fx.]+$/i.test(host)) return fail('ip-literal', 'Addresses written as numbers are not accepted. Use the site name.');
  if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return fail('host-chars', 'The host name has characters that are not allowed.');
  const labels = host.split('.');
  if (labels.length < 2) return fail('single-label', 'The host name must have at least two parts (for example site.example).');
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return fail('host-labels', 'The host name is not valid.');
  if (/^[0-9]+$/.test(labels[labels.length - 1]) || /^0x/i.test(labels[labels.length - 1])) return fail('numeric-tld', 'The host name ends in a number.');
  for (const suffix of INTERNAL_SUFFIXES) if (host === suffix || host.endsWith('.' + suffix)) return fail('reserved-name', `Names ending in .${suffix} are not accepted.`);
  return null;
}

/* The path shown and kept for a page: origin and path, never the query or the fragment. */
const pathOf = (url) => (url.pathname.length > 200 ? url.pathname.slice(0, 197) + '\u2026' : url.pathname);

function validateLink(raw, options = {}) {
  if (typeof raw !== 'string') return fail('type', 'The link must be text.');
  const text = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!text) return fail('empty', 'Paste a link.');
  if (text.length > MAX_LINK_CHARS) return fail('too-long', `The link is longer than ${MAX_LINK_CHARS} characters.`);
  if (HIDDEN_RE.test(text)) return fail('control', 'The link contains a hidden or control character.');
  if (/\s/.test(text)) return fail('space', 'The link contains a space. Copy the address again from the address bar.');
  if (text.includes('\\')) return fail('backslash', 'The link contains a backslash.');
  const scheme = /^(https?):\/\//i.exec(text);
  if (!scheme) return fail('scheme', 'Only https:// links are accepted.');
  const authority = text.slice(scheme[0].length).split(/[/?#]/, 1)[0];
  if (!authority) return fail('no-host', 'The link has no host.');
  if (authority.includes('@')) return fail('userinfo', 'The link contains a user name or password before the host. Those are not accepted.');
  if (authority.includes('%')) return fail('encoded-host', 'The host contains an encoded character.');
  let parsed;
  try { parsed = new URL(text); } catch (e) { return fail('unparseable', 'The link could not be read as an address.'); }
  if (parsed.username || parsed.password) return fail('userinfo', 'The link contains a user name or password before the host. Those are not accepted.');
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const problem = hostProblem(hostname, options);
  if (problem) return problem;
  const loopback = LOOPBACK.has(hostname);
  if (parsed.protocol !== 'https:' && !(loopback && options.allowLoopback === true)) return fail('scheme', 'Only https:// links are accepted.');
  if (parsed.port !== '' && !loopback && !(Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535)) return fail('port', 'Only the standard port or a port from 1024 to 65535 is accepted.');
  if (parsed.pathname.length > MAX_PATH_CHARS) return fail('path-too-long', 'The path is too long.');
  /* href holds the query and the fragment: in memory for the load, never logged, stored or shown. */
  return { ok: true, href: parsed.href, origin: parsed.origin, host: parsed.host, hostname, path: pathOf(parsed) };
}

/* url: a URL object. page: the task page's URL object. */
function fileUrlAllowed(url, page, options = {}) {
  if (url.href.length > MAX_FILE_URL_CHARS || url.username || url.password) return false;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && page.protocol === 'http:' && options.allowLoopback === true)) return false;
  if (url.hostname === page.hostname) return true;
  return hostProblem(url.hostname, options) === null;
}

module.exports = { validateLink, fileUrlAllowed, hostProblem, pathOf, MAX_LINK_CHARS, MAX_FILE_URL_CHARS };
