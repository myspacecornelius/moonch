'use strict';
/* Real page, or a wall in front of it? Pure function: the same inputs always give the same answer, so it is unit-tested with fixtures and
   its signals are the only thing it reports. A platform shows "you are not signed in" in at least five ways:
     1. the link answers 302 to a login path on the same host                              (redirect-to-login-path, login-path)
     2. the link answers 302 through another host, an identity provider                     (redirect-to-other-host, login-host)
     3. the link answers 200 with the sign-in form in place, same URL, no redirect          (password-field, login-words)
     4. the HTML shell loads, then the page's own fetch() gets 401 and script sends the browser to the login URL   (api-401, login-path)
     5. the HTML shell loads and the data calls get 401, and the page just stays empty or shows "session expired"  (api-401, little-content)
   plus the walls no program can pass: a CAPTCHA, a one-time code, a "checking your browser" interstitial. Those come back as
   needs-person; the loader handles both the same way (the person finishes them in the window). The score is a sum of weights with a
   threshold; there is no learned model. Exports: classifyPage, LOGIN_PATH_RE. */

const LOGIN_PATH_RE = /\/(log-?in|sign-?in|sign_in|signin|logon|sso|saml2?|oauth2?|openid|authorize|authenticate|auth|idp|session\/new|account\/login|accounts\/login|users\/sign_in)(\/|$|\.|\?)/i;
const LOGIN_HOST_RE = /^(login|signin|sign-in|accounts?|auth|sso|id|idp|identity|secure|sts|adfs)\./i;
const LOGIN_WORDS_RE = /\b(sign[ -]?in|log[ -]?in|log on|sign on|authenticate|session (has )?expired|please (sign|log) in|welcome back)\b/i;
const CHALLENGE_RE = /(verify (that )?you are (a )?human|are you a robot|checking your browser|just a moment|captcha|two[- ]?factor|2[- ]?step|verification code|one[- ]?time (code|password)|authenticator app|enter the (6|six)[- ]digit|security key|passkey|unusual traffic|access denied by|attention required)/i;
const RETURN_PARAMS = ['next', 'redirect', 'redirect_to', 'redirect_uri', 'return', 'returnto', 'return_to', 'returnurl', 'continue', 'callback', 'service', 'relaystate', 'goto', 'url', 'target', 'destination', 'from'];

function parse(text) { try { return new URL(text); } catch (e) { return null; } }
const norm = (url) => (url ? url.pathname.replace(/\/+$/, '') || '/' : '');

/* input: { requestedUrl, finalUrl, hops: [{ rawUrl, status }], mainResponse: { status } | null, api: [{ status }],
            snapshot: extractPage result | null, navError: string | null,
            ignoreChallengeWords: true once the person has said "I did it" (words like "verification code" in the first 600 characters
            are weak evidence; a CAPTCHA element or a code field still counts) } */
function classifyPage(input) {
  const requested = parse(input.requestedUrl);
  const final = parse(input.finalUrl || '');
  const signals = [];
  let score = 0;
  const fire = (name, weight) => { signals.push(name); score += weight; };
  const snap = input.snapshot || null;
  const mainStatus = input.mainResponse ? input.mainResponse.status : null;

  if (input.navError) return { state: 'error', score, signals: ['navigation-failed'], reason: `The browser could not open the link (${input.navError}).` };

  const hops = (input.hops || []).map((h) => parse(h.rawUrl)).filter(Boolean);
  const urlChanged = Boolean(final && requested && (norm(final) !== norm(requested) || final.hostname !== requested.hostname));
  /* A chain that passes through a login path or an identity provider and comes back to the page we asked for is a silent
     re-authentication, not a wall: what counts is where we ended up. */
  const passedLogin = hops.slice(1).some((h) => LOGIN_PATH_RE.test(h.pathname));
  if (passedLogin) { if (urlChanged) fire('redirect-to-login-path', 3); else signals.push('passed-through-login'); }
  if (requested && hops.slice(1).some((h) => h.hostname !== requested.hostname)) {
    if (urlChanged) fire('redirect-to-other-host', 1); else signals.push('passed-through-other-host');
    if (urlChanged && hops.slice(1).some((h) => LOGIN_HOST_RE.test(h.hostname))) fire('login-host', 2);
  }
  if (final && LOGIN_PATH_RE.test(final.pathname) && !(requested && LOGIN_PATH_RE.test(requested.pathname))) fire('login-path', 3);
  if (urlChanged) {
    signals.push('url-changed');
    for (const [key, value] of final.searchParams) {
      if (RETURN_PARAMS.includes(key.toLowerCase()) && (value.includes(requested.pathname) || value.includes(requested.host))) { fire('return-param', 2); break; }
    }
  }
  if (mainStatus === 401) fire('status-401', 3);
  if (mainStatus === 403) signals.push('status-403');
  if ((input.api || []).some((a) => a.status === 401 || a.status === 419 || a.status === 440)) fire('api-401', 3);

  if (snap) {
    const heads = [snap.title || '', ...(snap.headings || []).slice(0, 3).map((h) => h.text)].join(' | ');
    const bodyHead = (snap.sections || []).map((s) => `${s.heading} ${s.text}`).join(' ').slice(0, 600);
    if (snap.signals.hasPasswordField) fire('password-field', snap.controlCount <= 6 ? 3 : 1);
    if (LOGIN_WORDS_RE.test(heads)) fire('login-words', 2);
    if (snap.signals.bodyTextChars < 120 && (snap.headings || []).length === 0 && snap.linkCount < 3) fire('little-content', 1);
    if (snap.signals.hasOtpField) signals.push('otp-field');
    if (snap.signals.hasCaptcha) signals.push('captcha');
    if (!input.ignoreChallengeWords && CHALLENGE_RE.test(`${heads} ${bodyHead}`)) signals.push('challenge-words');
  }

  if (signals.includes('captcha') || signals.includes('otp-field') || signals.includes('challenge-words')) {
    return { state: 'needs-person', score, signals, reason: 'The page asks for something only you can do (a code, a CAPTCHA or a browser check). Finish it in the Chrome window.' };
  }
  if (score >= 3) return { state: 'needs-sign-in', score, signals, reason: 'The platform is asking you to sign in. Sign in in the Chrome window.' };
  if (mainStatus === 404 || mainStatus === 410) return { state: 'not-found', score, signals, reason: `The platform answered ${mainStatus}: the task page is not there.` };
  if (mainStatus === 403) return { state: 'forbidden', score, signals, reason: 'The platform answered 403: you are signed in but this page is not open to you.' };
  if (mainStatus !== null && mainStatus >= 400) return { state: 'error', score, signals, reason: `The platform answered ${mainStatus}.` };
  return { state: 'ready', score, signals, reason: 'The task page is open.' };
}

module.exports = { classifyPage, LOGIN_PATH_RE, LOGIN_HOST_RE, CHALLENGE_RE };
