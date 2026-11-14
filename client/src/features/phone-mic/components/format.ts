import type { PartyMessage, RequestFailureCode } from '@/features/phone-mic/lib/party-state';
import {
  isMicSlot,
  slotColor,
  type CalibrationFailure,
  type NoticeCode,
  type PartySinger,
  type PartySnapshot,
  type PrepState,
  type ScoreTier,
} from '@/features/remote-mic/protocol';
import { formatNumber, t, type TranslationKey } from '@/i18n';
import { playerColorOption } from '@/shared/player-colors';

export const TIER_CAPTIONS = {
  perfect: 'phoneMic.result.tier.perfect',
  excellent: 'phoneMic.result.tier.excellent',
  great: 'phoneMic.result.tier.great',
  good: 'phoneMic.result.tier.good',
  retry: 'phoneMic.result.tier.retry',
} satisfies Record<ScoreTier, TranslationKey>;

export const TIER_LINES = {
  perfect: 'phoneMic.result.tierLine.perfect',
  excellent: 'phoneMic.result.tierLine.excellent',
  great: 'phoneMic.result.tierLine.great',
  good: 'phoneMic.result.tierLine.good',
  retry: 'phoneMic.result.tierLine.retry',
} satisfies Record<ScoreTier, TranslationKey>;

/** `3:58` for a song length in seconds. */
export const formatDuration = (secs: number): string => {
  const total = Math.max(0, Math.round(secs));
  const seconds = formatNumber(total % 60, { minimumIntegerDigits: 2 });
  return `${formatNumber(Math.floor(total / 60))}:${seconds}`;
};

/** Whole minutes, at least one, for "~N min". */
export const etaMinutes = (etaSecs: number): string =>
  formatNumber(Math.max(1, Math.ceil(etaSecs / 60)));

export const formatKey = (keyOffset: number): string =>
  formatNumber(keyOffset, { signDisplay: 'exceptZero' });

export const formatTempo = (tempo: number): string =>
  formatNumber(tempo, { style: 'percent', maximumFractionDigits: 0 });

export const formatPercent = (pct: number): string =>
  formatNumber(pct / 100, { style: 'percent', maximumFractionDigits: 0 });

const waitingLabel = (prep: PrepState, withEta: TranslationKey, without: TranslationKey): string =>
  prep.etaSecs === undefined ? t(without) : t(withEta, { minutes: etaMinutes(prep.etaSecs) });

/** The state of a song that is not ready: "~4 min", "Getting ready… 40%", "Waiting", ... */
export const prepLabel = (prep: PrepState): string => {
  switch (prep.state) {
    case 'ready':
      return t('phoneMic.prep.ready');
    case 'not-ready':
      return waitingLabel(prep, 'phoneMic.prep.notReadyEta', 'phoneMic.prep.notReady');
    case 'analyzing':
      return prep.pct === undefined
        ? waitingLabel(prep, 'phoneMic.prep.gettingReadyEta', 'phoneMic.prep.gettingReady')
        : t('phoneMic.prep.percent', { pct: formatPercent(prep.pct) });
    case 'queued':
      return waitingLabel(prep, 'phoneMic.prep.gettingReadyEta', 'phoneMic.prep.waiting');
    case 'waiting-gpu':
      return t('phoneMic.prep.waiting');
    case 'failed':
      return t('phoneMic.prep.failed');
  }
  prep.state satisfies never;
  return '';
};

/** "Jim", or "Fuchsia mic" for a singer without a name. */
export const slotName = (slot: number, singer: PartySinger | null): string => {
  if (singer?.name !== undefined) {
    return singer.name;
  }
  return isMicSlot(slot)
    ? t('phoneMic.slotLabel', { color: t(playerColorOption(slotColor(slot)).label) })
    : t('phoneMic.join.any');
};

const FAILURE_KEYS = {
  'not-allowed': 'phoneMic.failure.notAllowed',
  'not-found': 'phoneMic.failure.notFound',
  invalid: 'phoneMic.failure.invalid',
  'limit-reservations': 'phoneMic.reserve.limitReservations',
  'limit-preparing': 'phoneMic.reserve.limitPreparing',
  'prep-full': 'phoneMic.failure.prepFull',
  'limit-sing-next': 'phoneMic.reserve.limitSingNext',
  duplicate: 'phoneMic.failure.duplicate',
  busy: 'phoneMic.failure.busy',
  'no-tv': 'phoneMic.failure.noTv',
  unavailable: 'phoneMic.failure.unavailable',
  'rate-limited': 'phoneMic.failure.rateLimited',
  'no-ack': 'phoneMic.failure.noAck',
  offline: 'phoneMic.link.offline',
} satisfies Record<RequestFailureCode, TranslationKey>;

export const failureText = (code: RequestFailureCode): string => t(FAILURE_KEYS[code]);

const CALIBRATION_FAILURE_KEYS = {
  busy: 'phoneMic.tune.failed.busy',
  'no-audio': 'phoneMic.tune.failed.noAudio',
  'no-tone': 'phoneMic.tune.failed.noTone',
  timeout: 'phoneMic.tune.failed.timeout',
  'no-tv': 'phoneMic.failure.noTv',
} satisfies Record<CalibrationFailure, TranslationKey>;

const isCalibrationFailure = (
  reason: CalibrationFailure | RequestFailureCode,
): reason is CalibrationFailure => Object.hasOwn(CALIBRATION_FAILURE_KEYS, reason);

/** A failed "Tune my mic": the TV's reason, or why the request did not go through. */
export const calibrationFailureText = (
  reason?: CalibrationFailure | RequestFailureCode,
): string => {
  if (reason === undefined) {
    return t('phoneMic.tune.failed.timeout');
  }
  return isCalibrationFailure(reason) ? t(CALIBRATION_FAILURE_KEYS[reason]) : failureText(reason);
};

const NOTICE_KEYS = {
  'duet-added': 'phoneMic.notice.duetAdded',
  'prep-failed': 'phoneMic.notice.prepFailed',
  'passed-over': 'phoneMic.notice.passedOver',
  'shift-failed': 'phoneMic.notice.shiftFailed',
  'start-failed': 'phoneMic.notice.startFailed',
} satisfies Record<NoticeCode, TranslationKey>;

export const messageText = (message: PartyMessage, snapshot: PartySnapshot | null): string => {
  if (message.kind === 'failure') {
    return failureText(message.code);
  }
  const by = message.bySlot;
  const singer =
    by === undefined ? null : (snapshot?.singers.find((each) => each.slot === by) ?? null);
  return t(NOTICE_KEYS[message.code], {
    title: message.title ?? t('phoneMic.notice.yourSong'),
    name: by === undefined ? t('phoneMic.notice.someone') : slotName(by, singer),
  });
};
