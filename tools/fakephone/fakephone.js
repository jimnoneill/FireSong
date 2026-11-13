// FireSong fake phone: a test stub of the /m page for headless runs. It joins
// /rtc as a mic, captures the browser's (fake) microphone and sends it to the
// TV as a send-only Opus stream, following docs/firesong/PROTOCOL.md. It is
// not the phone page; that is a separate work package.
//
// Query: ?micId=<id>&slot=<1-4>&name=<name>

const params = new URLSearchParams(location.search);
const micId = params.get('micId') ?? `fake-${crypto.randomUUID()}`;
const wantSlot = Number(params.get('slot') ?? '1');
const name = params.get('name') ?? 'Fake phone';
const GATHER_TIMEOUT_MS = 2000;

const state = {
  micId,
  slot: null,
  resumeKey: null,
  socket: 'connecting',
  connection: 'new',
  answers: 0,
  offers: 0,
  errors: [],
};

let socket = null;
let pc = null;
let stream = null;
let pingTimer = null;

const send = (frame) => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(frame));
  }
};

const gathered = (connection) =>
  new Promise((resolve) => {
    if (connection.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
    connection.addEventListener('icegatheringstatechange', () => {
      if (connection.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });

const capture = async () => {
  stream ??= await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
  return stream;
};

const offer = async (restart) => {
  const media = await capture();
  if (!restart || pc === null) {
    pc?.close();
    pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
    pc.addEventListener('connectionstatechange', () => {
      state.connection = pc.connectionState;
    });
    pc.addTransceiver(media.getAudioTracks()[0], { direction: 'sendonly', streams: [media] });
  } else {
    pc.restartIce();
  }
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  state.offers += 1;
  send({ type: 'offer', sdp: pc.localDescription.sdp, restart });
};

const onFrame = async (frame) => {
  switch (frame.type) {
    case 'assign':
      state.slot = frame.slot;
      state.resumeKey = frame.resumeKey;
      if (frame.tvConnected) {
        await offer(false);
      }
      break;
    case 'tv-state':
      if (frame.connected) {
        await offer(false);
      }
      break;
    case 'answer':
      await pc?.setRemoteDescription({ type: 'answer', sdp: frame.sdp });
      state.answers += 1;
      break;
    case 'restart':
      await offer(true);
      break;
    case 'error':
      state.errors.push(frame.code);
      break;
    default:
      break;
  }
};

const connect = () => {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rtc`);
  socket.addEventListener('open', () => {
    state.socket = 'open';
    send({
      type: 'hello',
      v: 1,
      micId,
      slot: wantSlot,
      name,
      ...(state.resumeKey === null ? {} : { resumeKey: state.resumeKey }),
    });
    pingTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), 5000);
  });
  socket.addEventListener('message', (event) => {
    onFrame(JSON.parse(event.data)).catch((error) => state.errors.push(String(error)));
  });
  socket.addEventListener('close', (event) => {
    state.socket = `closed:${event.code}`;
    clearInterval(pingTimer);
  });
};

window.fakePhone = {
  state,
  /** outbound-rtp audio counters, for packet-rate (ptime) checks. */
  async outbound() {
    const stats = await pc?.getStats();
    for (const stat of stats?.values() ?? []) {
      if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
        return { packetsSent: stat.packetsSent, bytesSent: stat.bytesSent, at: performance.now() };
      }
    }
    return null;
  },
  trackState() {
    const track = stream?.getAudioTracks()[0];
    return track === undefined ? null : { readyState: track.readyState, enabled: track.enabled };
  },
  /** Leaves on purpose (`bye`), or vanishes without one. */
  leave(sayBye) {
    if (sayBye) {
      send({ type: 'bye' });
    }
    socket?.close();
    pc?.close();
    stream?.getTracks().forEach((track) => track.stop());
  },
};

connect();
