/**
 * The worker between the voice-out worklet and the TV app's native voice
 * door. It runs off the page's main thread, so a busy page never holds the
 * voice back. Messages in: `{ type: 'start', url, audio }` (audio is the
 * worklet's MessagePort), `{ type: 'disconnect' }`, `{ type: 'connect' }`.
 * Messages out: `{ type: 'open' }`, `{ type: 'closed' }` and, every 5 s,
 * `{ type: 'counts', sent, dropped }`. Blocks that arrive while the socket is
 * closed, or while it is more than 50 ms behind, are dropped.
 */
const WORKER_SRC = `
const MAX_BUFFERED_BYTES = 48000 * 4 * 0.05;
let url = null;
let socket = null;
let wanted = false;
let retries = 0;
let timer = 0;
let sent = 0;
let dropped = 0;
const post = (type, extra) => postMessage(Object.assign({ type }, extra || {}));
const connect = () => {
  timer = 0;
  if (!wanted || socket !== null || url === null) return;
  const next = new WebSocket(url);
  next.binaryType = 'arraybuffer';
  socket = next;
  next.onopen = () => {
    if (socket !== next) return;
    retries = 0;
    post('open');
  };
  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    post('closed');
    if (wanted) {
      timer = setTimeout(connect, Math.min(10000, 500 * 2 ** retries));
      retries += 1;
    }
  };
};
const disconnect = () => {
  wanted = false;
  if (timer) clearTimeout(timer);
  timer = 0;
  if (socket !== null) {
    const closing = socket;
    socket = null;
    closing.close();
  }
};
const send = (block) => {
  if (socket !== null && socket.readyState === 1 && socket.bufferedAmount < MAX_BUFFERED_BYTES) {
    socket.send(block);
    sent += 1;
  } else {
    dropped += 1;
  }
};
onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') {
    url = message.url;
    message.audio.onmessage = (audioEvent) => send(audioEvent.data);
    wanted = true;
    connect();
  } else if (message.type === 'connect') {
    wanted = true;
    connect();
  } else if (message.type === 'disconnect') {
    disconnect();
  }
};
setInterval(() => post('counts', { sent, dropped }), 5000);
`;

let workerUrl: string | null = null;

export const voiceOutWorkerUrl = (): string => {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_SRC], { type: 'application/javascript' }));
  return workerUrl;
};
