'use strict';
/* Chrome DevTools Protocol over a pair of byte streams (--remote-debugging-pipe: Chrome reads commands from its file descriptor 3 and
   writes replies and events to its file descriptor 4; each message is one UTF-8 JSON document and a NUL byte). No listening socket, so
   no other process can attach, and when this process dies the pipe closes and Chrome exits by itself. With { flatten: true } every tab
   is addressed by a sessionId on each message; session(id) returns a sender bound to one tab.

   Network events carry Cookie and Authorization values. This client emits them to the listeners that ask; nothing here stores or logs
   a raw event, and tab.cjs keeps only fixed shapes. Exports: Cdp, CdpError, sleep. */

const { EventEmitter } = require('node:events');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CdpError extends Error {
  constructor(message, { code, method } = {}) {
    super(message);
    this.name = 'CdpError';
    this.code = code;      /* a protocol error number, or one of TIMEOUT PIPE_CLOSED WRITE CANCELLED DETACHED TARGET_CRASHED SPAWN OVERSIZE */
    this.method = method;
  }
}

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;   /* a message bigger than this means something is wrong; do not buffer without bound */

class Cdp extends EventEmitter {
  /* toBrowser: writable that reaches Chrome's fd 3. fromBrowser: readable that carries Chrome's fd 4. */
  constructor(toBrowser, fromBrowser, { maxMessageBytes = MAX_MESSAGE_BYTES } = {}) {
    super();
    this.setMaxListeners(0);
    this.toBrowser = toBrowser;
    this.nextId = 1;
    this.pending = new Map();      /* id -> { resolve, reject, timer, method, sessionId } */
    this.deadSessions = new Map(); /* sessionId -> code: tabs that were detached or crashed; a command to one never gets an answer */
    this.closed = false;
    let buffer = Buffer.alloc(0);
    fromBrowser.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let at;
      while ((at = buffer.indexOf(0)) !== -1) {
        const raw = buffer.subarray(0, at).toString('utf8');
        buffer = buffer.subarray(at + 1);
        if (raw) this.dispatch(raw);
      }
      if (buffer.length > maxMessageBytes) this.fail(new CdpError(`A message from the browser is larger than ${maxMessageBytes} bytes.`, { code: 'OVERSIZE' }));
    });
    const finish = () => this.fail(new CdpError('The browser closed the pipe.', { code: 'PIPE_CLOSED' }));
    fromBrowser.on('close', finish);
    fromBrowser.on('error', finish);
    toBrowser.on('error', finish);
  }

  dispatch(raw) {
    let message;
    try { message = JSON.parse(raw); } catch (e) { return; }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new CdpError(message.error.message, { code: message.error.code, method: entry.method }));
      else entry.resolve(message.result || {});
      return;
    }
    if (!message.method) return;
    const params = message.params || {};
    /* A tab that went away or crashed never answers the commands still waiting on it. Fail those now instead of at the timeout. */
    if (message.method === 'Target.detachedFromTarget' && params.sessionId) this.failSession(params.sessionId, 'DETACHED', 'The tab was detached.');
    else if (message.method === 'Inspector.targetCrashed' && message.sessionId) this.failSession(message.sessionId, 'TARGET_CRASHED', 'The tab crashed.');
    else if (message.method === 'Inspector.detached' && message.sessionId) this.failSession(message.sessionId, 'DETACHED', 'The tab was detached.');
    this.emit(message.method, params, message.sessionId);
  }

  failSession(sessionId, code, text) {
    this.deadSessions.set(sessionId, code);
    for (const [id, entry] of this.pending) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new CdpError(text, { code, method: entry.method }));
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.emit('closed', error);
  }

  /* One command. sessionId targets a tab; omit it for browser-level commands (Browser.*, Target.*). */
  send(method, params = {}, { sessionId, timeout = 30000 } = {}) {
    if (this.closed) return Promise.reject(new CdpError('The browser is closed.', { code: 'PIPE_CLOSED', method }));
    if (sessionId && this.deadSessions.has(sessionId)) return Promise.reject(new CdpError('The tab is gone.', { code: this.deadSessions.get(sessionId), method }));
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeout} ms.`, { code: 'TIMEOUT', method }));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method, sessionId });
      this.toBrowser.write(JSON.stringify(message) + '\0', (error) => {
        if (error && this.pending.delete(id)) { clearTimeout(timer); reject(new CdpError(error.message, { code: 'WRITE', method })); }
      });
    });
  }

  /* A sender bound to one tab, so tab code reads tab.send('Page.enable'). */
  session(sessionId) {
    return {
      sessionId,
      send: (method, params, options) => this.send(method, params, { ...options, sessionId }),
      on: (method, handler) => {
        const wrapped = (params, sid) => { if (sid === sessionId) handler(params); };
        this.on(method, wrapped);
        return () => this.off(method, wrapped);
      },
      waitFor: (method, options) => this.waitFor(method, { ...options, sessionId }),
    };
  }

  /* Resolve with the params of the next event that passes the filter. Rejects on timeout or a closed pipe. */
  waitFor(method, { filter, timeout = 30000, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off(method, onEvent); this.off('closed', onClosed); };
      const onEvent = (params, sid) => {
        if (sessionId && sid !== sessionId) return;
        if (filter && !filter(params)) return;
        cleanup();
        resolve(params);
      };
      const onClosed = (error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new CdpError(`Waiting for ${method} timed out after ${timeout} ms.`, { code: 'TIMEOUT', method })); }, timeout);
      this.on(method, onEvent);
      this.once('closed', onClosed);
    });
  }
}

module.exports = { Cdp, CdpError, sleep, MAX_MESSAGE_BYTES };
