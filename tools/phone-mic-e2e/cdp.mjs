// Chrome DevTools Protocol over --remote-debugging-pipe: no ports, no
// WebSocket client, no npm dependency. Messages are JSON separated by NUL.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class Chrome extends EventEmitter {
  static launch(executable, args, logStream) {
    const proc = spawn(executable, [...args, '--remote-debugging-pipe'], {
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    proc.stdout.pipe(logStream, { end: false });
    proc.stderr.pipe(logStream, { end: false });
    return new Chrome(proc);
  }

  constructor(proc) {
    super();
    this.proc = proc;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    proc.stdio[4].on('data', (chunk) => this.#onData(chunk));
    proc.on('exit', (code) => {
      for (const { reject } of this.pending.values()) {
        reject(new Error(`chrome exited (${code})`));
      }
      this.pending.clear();
      this.emit('exit', code);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.proc.stdio[3].write(`${JSON.stringify(message)}\0`);
    });
  }

  /** A page target with its own flattened session. */
  async newPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, targetId);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return page;
  }

  async close() {
    try {
      const exited = new Promise((resolve) => this.proc.once('exit', resolve));
      await Promise.race([
        this.send('Browser.close').then(() => exited),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      // Chrome may exit before it answers.
    }
    if (this.proc.exitCode === null) {
      const exited = new Promise((resolve) => this.proc.once('exit', resolve));
      this.proc.kill('SIGKILL');
      await exited;
    }
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let end = this.buffer.indexOf(0); end >= 0; end = this.buffer.indexOf(0)) {
      const message = JSON.parse(this.buffer.subarray(0, end).toString('utf8'));
      this.buffer = this.buffer.subarray(end + 1);
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        pending?.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending?.resolve(message.result);
      }
      return;
    }
    this.emit('event', message);
  }
}

export class Page {
  constructor(chrome, sessionId, targetId) {
    this.chrome = chrome;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.console = [];
    chrome.on('event', (message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Runtime.consoleAPICalled') {
        this.console.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.console.push(`EXCEPTION ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
      }
    });
  }

  send(method, params = {}) {
    return this.chrome.send(method, params, this.sessionId);
  }

  async navigate(url) {
    const loaded = new Promise((resolve) => {
      const onEvent = (message) => {
        if (message.sessionId === this.sessionId && message.method === 'Page.loadEventFired') {
          this.chrome.off('event', onEvent);
          resolve();
        }
      };
      this.chrome.on('event', onEvent);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  async evaluate(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (exceptionDetails !== undefined) {
      throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
    }
    return result.value;
  }

  /** Polls `expression` until it returns a truthy value; returns it and the time taken. */
  async waitFor(expression, { timeoutMs = 10_000, intervalMs = 50, what = expression } = {}) {
    const started = performance.now();
    for (;;) {
      const value = await this.evaluate(expression);
      if (value) {
        return { value, ms: performance.now() - started };
      }
      if (performance.now() - started > timeoutMs) {
        throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  /** A real touch tap (counts as a user gesture) at the centre of the first match. */
  async tap(selectorExpression) {
    const rect = await this.evaluate(`(() => {
      const element = ${selectorExpression};
      if (!element) return null;
      element.scrollIntoView({ block: 'center' });
      const r = element.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (rect === null) {
      throw new Error(`nothing to tap: ${selectorExpression}`);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [rect] });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async screenshot() {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(data, 'base64');
  }
}
