/**
 * The TV page's half of the party flight recorder (docs/firesong/FLIGHT.md).
 * Events are batched and posted to the server, which files them next to its
 * own stalls and host samples, so a white screen or a silent mic can be
 * explained afterwards. Only the TV page records; anywhere else `flight` and
 * the samplers do nothing.
 */
const FLIGHT_PATH = '/api/firesong/flight';
const FLUSH_MS = 5000;
const SAMPLE_MS = 10_000;
const MAX_BUFFER = 600;
/** The server keeps up to 200 events per request. */
const MAX_BATCH = 200;

export type FlightFields = Record<string, unknown>;

/** `wall` is the TV's clock (Unix ms) when the event happened; the server's `t` is arrival. */
type FlightEvent = FlightFields & { ev: string; wall: number };

type Recorder = {
  on: boolean;
  buffer: FlightEvent[];
  samplers: Map<string, () => FlightFields>;
  sending: boolean;
};

const recorder: Recorder = { on: false, buffer: [], samplers: new Map(), sending: false };

/** A numeric property of a non-standard browser object, when present. */
const numberAt = (value: unknown, key: string): number | undefined => {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'number' ? field : undefined;
};

/** Records one event when the recorder runs. */
export const flight = (ev: string, fields: FlightFields = {}): void => {
  if (!recorder.on) {
    return;
  }
  recorder.buffer.push({ ...fields, ev, wall: Date.now() });
  if (recorder.buffer.length > MAX_BUFFER) {
    recorder.buffer.splice(0, recorder.buffer.length - MAX_BUFFER);
  }
};

/** Adds fields to the periodic `sample` event; returns its removal. */
export const addFlightSampler = (name: string, sampler: () => FlightFields): (() => void) => {
  recorder.samplers.set(name, sampler);
  return () => {
    if (recorder.samplers.get(name) === sampler) {
      recorder.samplers.delete(name);
    }
  };
};

const mib = (bytes: number | undefined): number | undefined =>
  bytes === undefined ? undefined : Math.round(bytes / 1048576);

/** Chromium's `performance.memory`, in MiB. */
const heap = (): FlightFields => {
  const memory: unknown = Reflect.get(performance, 'memory');
  return {
    heapMib: mib(numberAt(memory, 'usedJSHeapSize')),
    heapLimitMib: mib(numberAt(memory, 'jsHeapSizeLimit')),
  };
};

const sample = (): void => {
  const fields: FlightFields = { ...heap(), visible: document.visibilityState === 'visible' };
  for (const [name, sampler] of recorder.samplers) {
    try {
      fields[name] = sampler();
    } catch (error) {
      fields[name] = { error: String(error) };
    }
  }
  flight('sample', fields);
};

const flush = async (leaving: boolean): Promise<void> => {
  if (recorder.sending || recorder.buffer.length === 0) {
    return;
  }
  const events = recorder.buffer.splice(0, MAX_BATCH);
  recorder.sending = true;
  try {
    const response = await fetch(FLIGHT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: leaving,
    });
    if (!response.ok) {
      throw new Error(String(response.status));
    }
  } catch {
    recorder.buffer.unshift(...events);
    recorder.buffer.splice(MAX_BUFFER);
  } finally {
    recorder.sending = false;
  }
};

const errorFields = (error: unknown): FlightFields =>
  error instanceof Error
    ? { message: error.message, stack: error.stack?.slice(0, 1500) }
    : { message: String(error) };

/** Starts recording on the TV page: page load, errors, samples, flushes. */
export const startFlightRecorder = (): void => {
  if (recorder.on) {
    return;
  }
  recorder.on = true;
  flight('page-load', {
    userAgent: navigator.userAgent,
    deviceMemoryGib: numberAt(navigator, 'deviceMemory'),
  });
  window.addEventListener('error', (event) => {
    flight('error', {
      ...errorFields(event.error ?? event.message),
      source: event.filename,
      line: event.lineno,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    flight('rejection', errorFields(event.reason));
  });
  document.addEventListener('visibilitychange', () => {
    flight('visibility', { visible: document.visibilityState === 'visible' });
  });
  window.addEventListener('pagehide', () => {
    flight('page-hide');
    void flush(true);
  });
  window.setInterval(sample, SAMPLE_MS);
  window.setInterval(() => void flush(false), FLUSH_MS);
};
