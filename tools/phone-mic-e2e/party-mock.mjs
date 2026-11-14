// The party side of the mock FireSong server for the phone e2e test
// (docs/firesong/PROTOCOL.md §13): a fake song book, reservations with the
// §13.7 rules and §13.10 limits, a scripted TV for the remote, calibration and
// lyric lines, and tonight's best. It plays the server and the TV at once:
// accepted `control` frames change the stage the way the real TV would.

const COLORS = { 1: 'rose', 2: 'fuchsia', 3: 'amber', 4: 'emerald' };
const LIMITS = { reservations: 3, preparing: 2, preparingTotal: 6, singNext: 1, partners: 3 };
const REQUEST_RULE = { burst: 6, refillMs: 3_000 };
const FX_RULE = { burst: 3, refillMs: 2_000 };
const SHIFT_COOLDOWN_MS = 15_000;
const CALIBRATION_COOLDOWN_MS = 30_000;
const MAX_BOOK_PAGE = 50;
const SINGING = new Set(['starting', 'singing', 'paused']);
const REQUESTS = new Set(['reserve', 'edit', 'cancel', 'control', 'shift-current', 'calibrate']);
export const PARTY_TYPES = new Set([...REQUESTS, 'fx', 'mix']);

const TITLES = [
  ['Neon Harbour', 'The Lanterns'],
  ['Paper Moon Parade', 'Juniper Fox'],
  ['Midnight Karaoke Queen', 'Disco Owls'],
  ['노래방 스타', 'Seoul Sparks'],
  ['Song 2', 'Blur'],
  ['Wonderwall', 'Oasis'],
  ['The Final Countdown', 'Europe'],
  ['Creep', 'Radiohead'],
  ['Golden Hour Highway', 'Marigold Lane'],
  ['A Very Long Title That Keeps Going Past The Edge Of A Phone Screen', 'Wordy Band'],
];

/** 60 songs: 40 ready (some not shiftable), 20 waiting for analysis. */
export const fixtureLibrary = () =>
  Array.from({ length: 60 }, (_, index) => {
    const [title, artist] = TITLES[index % TITLES.length];
    const ready = index < 40;
    return {
      fileHash: `${index.toString(16).padStart(4, '0')}${'a'.repeat(28)}`,
      title: index < TITLES.length ? title : `${title} ${index}`,
      artist,
      durationSecs: 150 + ((index * 37) % 120),
      shiftable: index % 7 !== 3,
      prep: ready ? { state: 'ready' } : { state: 'not-ready', etaSecs: 120 + (index % 5) * 60 },
    };
  });

const bucket = (rule, now) => ({ tokens: rule.burst, at: now });
const take = (state, rule, now) => {
  state.tokens = Math.min(rule.burst, state.tokens + (now - state.at) / rule.refillMs);
  state.at = now;
  if (state.tokens < 1) return false;
  state.tokens -= 1;
  return true;
};

export function createPartyMock({ slots, sendTo, toTv, hasTv, now = () => Date.now() }) {
  const library = fixtureLibrary();
  const byHash = new Map(library.map((song) => [song.fileHash, song]));
  let rev = 0;
  let seq = 0;
  let stage = { state: 'lobby', singers: [] };
  let queue = [];
  let scores = [];
  const perSlot = new Map();
  const options = { dropAcks: false, calibrationScript: null };
  const counters = { fxRelayed: 0 };

  const slotState = (slot) => {
    if (!perSlot.has(slot)) {
      perSlot.set(slot, {
        requests: bucket(REQUEST_RULE, now()),
        fx: bucket(FX_RULE, now()),
        volumePct: 100,
        echoPct: 100,
        lastShiftAt: -Infinity,
        lastCalibrateAt: -Infinity,
      });
    }
    return perSlot.get(slot);
  };

  const singers = () =>
    [...slots.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((entry) => ({
        slot: entry.slot,
        color: COLORS[entry.slot],
        ...(entry.name === undefined ? {} : { name: entry.name }),
        state: entry.conn === null ? 'reserved' : 'connected',
        volumePct: slotState(entry.slot).volumePct,
        echoPct: slotState(entry.slot).echoPct,
      }));

  const snapshot = () => {
    rev += 1;
    const shown = queue.filter((item, index) => index < 30 || item.singers.length > 0);
    return {
      rev,
      tvConnected: hasTv(),
      stage,
      queue: shown.map(({ seq: _seq, ...item }) => item),
      queueTotal: queue.length,
      singers: singers(),
      scores,
    };
  };

  const phoneOf = (slot) => slots.get(slot)?.conn ?? null;
  const toPhone = (slot, frame) => {
    const conn = phoneOf(slot);
    if (conn !== null) sendTo(conn, 'mic', frame);
  };
  const broadcast = () => {
    const party = snapshot();
    for (const entry of slots.values()) {
      if (entry.conn !== null) sendTo(entry.conn, 'mic', { type: 'party', party });
    }
    toTv({ type: 'party', party });
  };

  const ack = (slot, frame, ok, extra = {}) => {
    if (frame.reqId === undefined || options.dropAcks) return;
    toPhone(slot, { type: 'ack', reqId: frame.reqId, ok, ...extra });
  };
  const refuse = (slot, frame, code) => ack(slot, frame, false, { code });

  const owned = (slot) => queue.filter((item) => item.singers[0] === slot);
  const firstReady = () => queue.find((item) => item.prep.state === 'ready') ?? null;
  const place = (item) => {
    const key = (each) => [each.singNext ? 0 : 1, each.seq];
    const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const lockedFirst = stage.state === 'starting' || (stage.state === 'lobby' && stage.countdownSecs !== undefined);
    let index = queue.findIndex((each) => before(key(item), key(each)));
    if (index < 0) index = queue.length;
    if (lockedFirst && index === 0 && queue.length > 0) index = 1;
    queue.splice(index, 0, item);
  };

  const reserveError = (slot, frame, song) => {
    if (song === undefined) return 'not-found';
    const partners = frame.partners ?? [];
    const partnersOk =
      partners.length <= LIMITS.partners &&
      new Set(partners).size === partners.length &&
      partners.every((each) => each !== slot && slots.has(each));
    if (!partnersOk) return 'invalid';
    const shifted = (frame.keyOffset ?? 0) !== 0 || (frame.tempo ?? 1) !== 1;
    if (shifted && (!song.shiftable || song.prep.state !== 'ready')) return 'unavailable';
    const mine = owned(slot);
    if (mine.some((item) => item.fileHash === song.fileHash)) return 'duplicate';
    if (mine.length >= LIMITS.reservations) return 'limit-reservations';
    const preparing = mine.filter((item) => item.prep.state !== 'ready').length;
    if (song.prep.state !== 'ready' && preparing >= LIMITS.preparing) return 'limit-preparing';
    const preparingTotal = queue.filter((item) => item.prep.state !== 'ready').length;
    if (song.prep.state !== 'ready' && preparingTotal >= LIMITS.preparingTotal) return 'prep-full';
    if (frame.singNext === true && mine.filter((item) => item.singNext).length >= LIMITS.singNext) {
      return 'limit-sing-next';
    }
    return null;
  };

  const reserve = (slot, frame) => {
    const song = byHash.get(frame.fileHash);
    const error = reserveError(slot, frame, song);
    if (error !== null) return refuse(slot, frame, error);
    seq += 1;
    const ready = song.prep.state === 'ready';
    const item = {
      reservationId: `r${seq}`,
      ...(ready ? { entryId: String(100 + seq) } : {}),
      fileHash: song.fileHash,
      title: song.title,
      artist: song.artist,
      durationSecs: song.durationSecs,
      singers: [slot, ...(frame.partners ?? [])],
      keyOffset: frame.keyOffset ?? 0,
      tempo: frame.tempo ?? 1,
      singNext: frame.singNext === true,
      shiftable: song.shiftable,
      prep: ready ? { state: 'ready' } : { state: 'queued', etaSecs: song.prep.etaSecs },
      seq,
    };
    place(item);
    ack(slot, frame, true, { reservationId: item.reservationId });
    for (const partner of frame.partners ?? []) {
      toPhone(partner, { type: 'notice', code: 'duet-added', title: song.title, bySlot: slot });
    }
    broadcast();
  };

  const findItem = (id) => queue.find((item) => item.reservationId === id);

  const edit = (slot, frame) => {
    const item = findItem(frame.reservationId);
    if (item === undefined) return refuse(slot, frame, 'not-found');
    if (item.singers[0] !== slot) return refuse(slot, frame, 'not-allowed');
    const shifted = frame.keyOffset !== undefined || frame.tempo !== undefined;
    if (shifted && (!item.shiftable || item.prep.state !== 'ready')) return refuse(slot, frame, 'unavailable');
    if (frame.singNext === true && !item.singNext && owned(slot).some((each) => each.singNext)) {
      return refuse(slot, frame, 'limit-sing-next');
    }
    Object.assign(item, {
      ...(frame.keyOffset === undefined ? {} : { keyOffset: frame.keyOffset }),
      ...(frame.tempo === undefined ? {} : { tempo: frame.tempo }),
    });
    if (frame.singNext !== undefined && frame.singNext !== item.singNext) {
      item.singNext = frame.singNext;
      queue = queue.filter((each) => each !== item);
      place(item);
    }
    ack(slot, frame, true);
    broadcast();
  };

  const cancel = (slot, frame) => {
    const item = findItem(frame.reservationId);
    if (item === undefined) return refuse(slot, frame, 'not-found');
    if (!item.singers.includes(slot)) return refuse(slot, frame, 'not-allowed');
    if (item.singers[0] === slot) {
      queue = queue.filter((each) => each !== item);
    } else {
      item.singers = item.singers.filter((each) => each !== slot);
    }
    ack(slot, frame, true);
    broadcast();
  };

  const startItem = (item) => {
    queue = queue.filter((each) => each !== item);
    stage = {
      state: 'singing',
      reservationId: item.reservationId,
      title: item.title,
      artist: item.artist,
      singers: [...item.singers],
    };
  };

  const control = (slot, frame) => {
    const stamp = { slot, micId: slots.get(slot)?.micId };
    if (frame.action === 'start-now') {
      const next = firstReady();
      const allowed = stage.state === 'lobby' && next !== null && (next.singers.length === 0 || next.singers.includes(slot));
      if (!allowed) return refuse(slot, frame, next === null || stage.state !== 'lobby' ? 'busy' : 'not-allowed');
      if (!hasTv()) return refuse(slot, frame, 'no-tv');
      toTv({ type: 'control', ...stamp, action: frame.action });
      ack(slot, frame, true);
      startItem(next);
      return broadcast();
    }
    if (!SINGING.has(stage.state) || !stage.singers.includes(slot)) return refuse(slot, frame, 'not-allowed');
    if (!hasTv()) return refuse(slot, frame, 'no-tv');
    toTv({ type: 'control', ...stamp, action: frame.action });
    ack(slot, frame, true);
    if (frame.action === 'pause') stage = { ...stage, state: 'paused' };
    if (frame.action === 'resume') stage = { ...stage, state: 'singing' };
    if (frame.action === 'stop') stage = { state: 'lobby', singers: [] };
    return broadcast();
  };

  const shiftCurrent = (slot, frame) => {
    if (!SINGING.has(stage.state) || !stage.singers.includes(slot)) return refuse(slot, frame, 'not-allowed');
    const state = slotState(slot);
    if (now() - state.lastShiftAt < SHIFT_COOLDOWN_MS) return refuse(slot, frame, 'rate-limited');
    state.lastShiftAt = now();
    toTv({ type: 'shift-current', slot, micId: slots.get(slot)?.micId, keyOffset: frame.keyOffset, tempo: frame.tempo });
    return ack(slot, frame, true);
  };

  const calibrate = (slot, frame) => {
    if (!hasTv()) return refuse(slot, frame, 'no-tv');
    if (stage.state !== 'lobby') return refuse(slot, frame, 'busy');
    const state = slotState(slot);
    if (now() - state.lastCalibrateAt < CALIBRATION_COOLDOWN_MS) return refuse(slot, frame, 'rate-limited');
    state.lastCalibrateAt = now();
    toTv({ type: 'calibrate', slot, micId: slots.get(slot)?.micId });
    ack(slot, frame, true);
    const script = options.calibrationScript ?? [
      { afterMs: 300, frame: { type: 'calibration', state: 'started' } },
      { afterMs: 1_500, frame: { type: 'calibration', state: 'done', latencyMs: 212 } },
    ];
    for (const step of script) setTimeout(() => toPhone(slot, step.frame), step.afterMs);
  };

  const mix = (slot, frame) => {
    const state = slotState(slot);
    if (frame.volumePct !== undefined) state.volumePct = frame.volumePct;
    if (frame.echoPct !== undefined) state.echoPct = frame.echoPct;
    toTv({ type: 'mix', slot, volumePct: state.volumePct, echoPct: state.echoPct });
    broadcast();
  };

  const fx = (slot, frame) => {
    if (!take(slotState(slot).fx, FX_RULE, now())) return;
    counters.fxRelayed += 1;
    toTv({ type: 'fx', slot, sound: frame.sound });
  };

  const HANDLERS = { reserve, edit, cancel, control, 'shift-current': shiftCurrent, calibrate, mix, fx };

  return {
    library,
    options,
    counters,
    get stage() {
      return stage;
    },
    get queue() {
      return queue;
    },
    /** A phone party frame from `slot`, already past the hello. */
    handle(slot, frame) {
      if (REQUESTS.has(frame.type) && !take(slotState(slot).requests, REQUEST_RULE, now())) {
        return refuse(slot, frame, 'rate-limited');
      }
      return HANDLERS[frame.type](slot, frame);
    },
    afterAssign(slot) {
      toPhone(slot, { type: 'party', party: snapshot() });
      broadcast();
    },
    slotFreed(slot) {
      perSlot.delete(slot);
      queue = queue
        .map((item) => {
          if (item.singers[0] !== slot) return { ...item, singers: item.singers.filter((each) => each !== slot) };
          return item.singers.length > 1 ? { ...item, singers: item.singers.slice(1) } : null;
        })
        .filter((item) => item !== null);
      broadcast();
    },
    tvChanged: () => broadcast(),
    /** The v1 song-result reached the phones: put it on the board and send `night-rank`. */
    songResult(frame) {
      const at = Math.floor(now() / 1_000);
      for (const result of frame.results) {
        const entry = slots.get(result.slot);
        if (entry === undefined) continue;
        scores.push({
          slot: result.slot,
          color: COLORS[result.slot],
          ...(entry.name === undefined ? {} : { name: entry.name }),
          ...(frame.title === undefined ? {} : { title: frame.title }),
          displayScore: result.displayScore,
          rawScore: result.rawScore,
          tier: result.tier,
          atSecs: at,
          result,
        });
      }
      scores.sort((a, b) => b.displayScore - a.displayScore || b.rawScore - a.rawScore || a.atSecs - b.atSecs);
      scores = scores.slice(0, 10);
      for (const result of frame.results) {
        const rank = scores.findIndex((score) => score.result === result);
        toPhone(result.slot, { type: 'night-rank', ...(rank < 0 ? {} : { rank: rank + 1 }), entries: scores.length });
      }
      scores = scores.map(({ result: _result, ...score }) => score);
      broadcast();
    },
    setStage(next) {
      stage = next;
      broadcast();
    },
    setScores(next) {
      scores = next;
      broadcast();
    },
    setPrep(reservationId, prep) {
      const item = findItem(reservationId);
      if (item === undefined) return;
      item.prep = prep;
      if (prep.state === 'ready') item.entryId = String(500 + item.seq);
      broadcast();
    },
    /** Puts a host-picked song (no singers) at the end of the queue. */
    hostQueue(fileHash) {
      const song = byHash.get(fileHash);
      seq += 1;
      queue.push({
        reservationId: `r${seq}`,
        entryId: String(100 + seq),
        fileHash,
        title: song.title,
        artist: song.artist,
        durationSecs: song.durationSecs,
        singers: [],
        keyOffset: 0,
        tempo: 1,
        singNext: false,
        shiftable: song.shiftable,
        prep: { state: 'ready' },
        seq,
      });
      broadcast();
    },
    /** A lyric line from the TV: only the singers of the current song get it. */
    lyric(frame) {
      for (const slot of stage.singers) toPhone(slot, { type: 'lyric', ...frame });
    },
    notice(slot, frame) {
      toPhone(slot, { type: 'notice', ...frame });
    },
    /** POST /api/cmd/firesong_song_book: §13.11, ready songs first, each part by title. */
    songBook(query) {
      const take = query?.take;
      const skip = query?.skip ?? 0;
      const search = query?.search;
      const valid =
        Number.isInteger(take) && take >= 1 && take <= MAX_BOOK_PAGE && Number.isInteger(skip) && skip >= 0 &&
        (search === undefined || (typeof search === 'string' && [...search].length <= 100));
      if (!valid) return null;
      const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const matches = library.filter((song) => {
        const text = `${song.title} ${song.artist}`.toLowerCase();
        return words.every((word) => text.includes(word));
      });
      const byTitle = (a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.fileHash.localeCompare(b.fileHash);
      const ready = matches.filter((song) => song.prep.state === 'ready').sort(byTitle);
      const rest = matches.filter((song) => song.prep.state !== 'ready').sort(byTitle);
      const ordered = [...ready, ...rest];
      return { items: ordered.slice(skip, skip + take), skip, total: ordered.length, readyTotal: ready.length };
    },
  };
}
