// Minimal RFC 6455 WebSocket server side for the mock relay: unfragmented
// text frames, close, ping/pong. Enough for /rtc test traffic; not a
// general-purpose implementation.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#finish(1006));
    socket.on('error', () => this.#finish(1006));
  }

  sendText(text) {
    if (!this.closed) {
      this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
    }
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  close(code = 1000) {
    if (this.closed) {
      return;
    }
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.#finish(code);
  }

  /** Simulates a network drop: no close frame, the TCP connection just dies. */
  kill() {
    this.socket.destroy();
    this.#finish(1006);
  }

  #finish(code) {
    if (!this.closed) {
      this.closed = true;
      this.emit('close', code);
    }
  }

  #onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(this.buffer);
      if (parsed === null) {
        return;
      }
      this.buffer = this.buffer.subarray(parsed.length);
      this.#onFrame(parsed);
    }
  }

  #onFrame({ opcode, payload }) {
    if (opcode === 0x1) {
      this.emit('text', payload.toString('utf8'));
    } else if (opcode === 0x2) {
      this.emit('binary', payload);
    } else if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      this.close(code);
    } else if (opcode === 0x9) {
      this.socket.write(frame(0xa, payload));
    }
  }
}

function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) {
    return null;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (mask !== null) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return { opcode, payload, length: offset + maskLength + length };
}

/** Completes the upgrade handshake; returns null (and answers 400) if it is not one. */
export function acceptUpgrade(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return new WsConnection(socket);
}
