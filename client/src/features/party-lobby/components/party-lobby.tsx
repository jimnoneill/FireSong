import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';

import { TIER_CAPTIONS } from '@/features/noraebang/captions';
import type { NightScore, PrepState } from '@/features/remote-mic/protocol';
import { t, tp, useTranslation } from '@/i18n';
import { BRAND_MARK_URL } from '@/shared/firesong-brand';
import { playerColorOption, type PlayerColor } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

import type { LobbyStatus } from '../conductor';
import type { LobbyItem, LobbyModel, LobbySinger, LobbySlot } from '../lobby-model';
import { SLOT_STYLES } from '../slot-style';

type Props = {
  model: LobbyModel;
  status: LobbyStatus;
  /** The TV holds its `/rtc` seat. */
  connected: boolean;
  linksError: boolean;
  onStartNow: () => void;
  onPickSong: () => void;
  onClearBest: () => void;
};

const CLEAR_CONFIRM_MS = 4000;
const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowUp', 'ArrowLeft']);
const BUTTON_FOCUS = 'outline-none focus:scale-105 focus:ring-[0.8vh] focus:ring-white';

/** Where an arrow key moves between the lobby's buttons: 1, -1, or 0 for any other key. */
const arrowStep = (key: string): number => {
  if (NEXT_KEYS.has(key)) {
    return 1;
  }
  return PREVIOUS_KEYS.has(key) ? -1 : 0;
};

const qrDataUrl = (svg: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;

const colorName = (color: PlayerColor): string => t(playerColorOption(color).label);

const singerName = (singer: { name: string | null; color: PlayerColor }): string =>
  singer.name ?? colorName(singer.color);

const nameOf = (model: LobbyModel, slot: number): string => {
  const entry = model.slots.find((candidate) => candidate.slot === slot);
  if (entry === undefined) {
    return '';
  }
  return entry.singer === null ? colorName(entry.color) : singerName(entry.singer);
};

function headline(status: LobbyStatus, model: LobbyModel): { main: string; sub: string | null } {
  switch (status.kind) {
    case 'empty':
      return {
        main: t(model.queued === 0 ? 'firesong.party.empty' : 'firesong.party.preparingOnly'),
        sub: null,
      };
    case 'held':
      return { main: t('firesong.party.firstUp', { title: status.entry.title }), sub: null };
    case 'countdown': {
      const owner = status.singers.at(0);
      return {
        main:
          owner === undefined
            ? tp('firesong.party.countdown.song', status.secondsLeft, { title: status.entry.title })
            : tp('firesong.party.countdown.singer', status.secondsLeft, {
                name: nameOf(model, owner),
              }),
        sub: status.entry.title,
      };
    }
    case 'waiting':
      return {
        main: t('firesong.party.waiting', { name: nameOf(model, status.owner) }),
        sub: status.secondsLeft === null ? null : tp('firesong.party.passIn', status.secondsLeft),
      };
    case 'starting':
      return { main: t('firesong.party.starting', { title: status.entry.title }), sub: null };
  }
  status satisfies never;
  return { main: '', sub: null };
}

function prepLabel(prep: PrepState): string | null {
  switch (prep.state) {
    case 'ready':
    case 'not-ready':
      return null;
    case 'queued':
    case 'analyzing':
      if (prep.pct !== undefined && prep.state === 'analyzing') {
        return t('firesong.party.prep.percent', { pct: prep.pct });
      }
      return prep.etaSecs === undefined
        ? t('firesong.party.prep.preparing')
        : tp('firesong.party.prep.eta', Math.max(1, Math.ceil(prep.etaSecs / 60)));
    case 'waiting-gpu':
      return t('firesong.party.prep.waitingGpu');
    case 'failed':
      return t('firesong.party.prep.failed');
  }
  prep.state satisfies never;
  return null;
}

function SingerChip({ singer }: { singer: LobbySinger }) {
  const style = SLOT_STYLES[singer.color];
  return (
    <span className={cn('inline-flex items-center gap-[0.8vh] font-bold', style.text)}>
      <span aria-hidden="true" className={cn('size-[1.4vh] rounded-full', style.dot)} />
      {singerName(singer)}
    </span>
  );
}

function UpNextRow({ item, index }: { item: LobbyItem; index: number }) {
  const prep = prepLabel(item.prep);
  return (
    <li className="flex items-center gap-[2vh] border-b border-white/10 py-[0.8vh] last:border-b-0">
      <span className="w-[3.5vh] text-right text-[2.6vh] font-black text-white/40 tabular-nums">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[2.8vh] leading-tight font-bold text-white">{item.title}</p>
        <p className="truncate text-[2vh] leading-tight text-white/60">{item.artist}</p>
      </div>
      <div className="flex max-w-[45%] flex-col items-end gap-[0.3vh] text-[2.2vh] leading-tight">
        <div className="flex flex-wrap justify-end gap-x-[2vh]">
          {item.singers.length === 0 ? (
            <span className="text-white/50">{t('firesong.party.hostSong')}</span>
          ) : (
            item.singers.map((singer) => <SingerChip key={singer.slot} singer={singer} />)
          )}
        </div>
        {prep !== null && <span className="text-[1.8vh] text-sky-300">{prep}</span>}
      </div>
    </li>
  );
}

function UpNext({ model }: { model: LobbyModel }) {
  return (
    <section aria-labelledby="party-up-next" className="flex min-h-0 flex-col">
      <div className="mb-[1vh] flex items-baseline justify-between gap-[2vh]">
        <h2
          id="party-up-next"
          className="text-[2.6vh] font-bold tracking-wide text-white/70 uppercase"
        >
          {t('firesong.party.upNext')}
        </h2>
        {model.more > 0 && (
          <p className="text-[2.2vh] text-white/50">
            {tp('firesong.party.upNext.more', model.more)}
          </p>
        )}
      </div>
      {model.upNext.length === 0 ? (
        <p className="text-[2.6vh] text-white/50">{t('firesong.party.upNext.none')}</p>
      ) : (
        <ol>
          {model.upNext.map((item, index) => (
            <UpNextRow key={item.key} item={item} index={index} />
          ))}
        </ol>
      )}
    </section>
  );
}

function BestRow({ score, rank }: { score: NightScore; rank: number }) {
  const caption = TIER_CAPTIONS[score.tier];
  const style = SLOT_STYLES[score.color];
  return (
    <li className="flex items-center gap-[1.6vh] py-[0.8vh]">
      <span className="w-[4vh] text-right text-[2.4vh] font-black text-white/40 tabular-nums">
        {t('firesong.noraebang.reveal.rank', { rank })}
      </span>
      <span className="w-[7vh] text-right text-[3.4vh] leading-none font-black text-amber-300 tabular-nums">
        {score.displayScore}
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate text-[2.4vh] leading-tight font-bold', style.text)}>
          {score.name ?? colorName(score.color)}
        </p>
        <p className="truncate text-[1.8vh] leading-tight text-white/60">
          {t(caption.korean)} · {score.title ?? ''}
        </p>
      </div>
    </li>
  );
}

function TonightsBest({ best }: { best: readonly NightScore[] }) {
  return (
    <section aria-labelledby="party-best" className="flex min-h-0 flex-col">
      <h2
        id="party-best"
        className="mb-[1vh] text-[2.6vh] font-bold tracking-wide text-white/70 uppercase"
      >
        {t('firesong.party.best')}
      </h2>
      {best.length === 0 ? (
        <p className="text-[2.4vh] text-white/50">{t('firesong.party.best.empty')}</p>
      ) : (
        <ol>
          {best.map((score, index) => (
            <BestRow key={`${score.atSecs}-${score.slot}`} score={score} rank={index + 1} />
          ))}
        </ol>
      )}
    </section>
  );
}

function slotState(slot: LobbySlot): string {
  if (slot.singer === null) {
    return t('firesong.party.slotState.free');
  }
  return t(
    slot.singer.reconnecting
      ? 'firesong.party.slotState.reconnecting'
      : 'firesong.party.slotState.joined',
  );
}

function SlotCard({ slot }: { slot: LobbySlot }) {
  const style = SLOT_STYLES[slot.color];
  const svg = slot.link?.qrSvg ?? null;
  return (
    <li
      className={cn(
        'flex items-center gap-[1.6vh] rounded-[2vh] border-[0.5vh] bg-white/5 p-[1.2vh]',
        style.border,
      )}
    >
      {svg === null ? (
        <div className="flex size-[21vh] shrink-0 items-center justify-center rounded-[1vh] bg-white/10 p-[1vh] text-center text-[2vh] text-white/60">
          {t('firesong.party.slotNoLink')}
        </div>
      ) : (
        <img
          src={qrDataUrl(svg)}
          alt={t('firesong.party.slotQr', { slot: slot.slot })}
          className="size-[21vh] shrink-0 rounded-[1vh] bg-white p-[0.8vh]"
        />
      )}
      <div className="flex min-w-0 flex-col gap-[0.6vh]">
        <p className={cn('text-[2.8vh] leading-tight font-black', style.text)}>
          {t('firesong.party.slotName', { slot: slot.slot })}
        </p>
        {slot.singer !== null && (
          <p className={cn('truncate text-[2.6vh] leading-tight font-bold', style.text)}>
            {singerName(slot.singer)}
          </p>
        )}
        <p className="text-[2vh] leading-tight text-white/70">{slotState(slot)}</p>
      </div>
    </li>
  );
}

/**
 * The TV's party lobby between songs: join codes, up next, the countdown and
 * tonight's best. Operated with the remote only: the arrows move between the
 * buttons and OK presses the highlighted one. Back does nothing here; holding
 * it leaves the app.
 */
export function PartyLobby({
  model,
  status,
  connected,
  linksError,
  onStartNow,
  onPickSong,
  onClearBest,
}: Props) {
  useTranslation();
  const rootRef = useRef<HTMLDialogElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const [armed, setArmed] = useState(false);
  const canStart = status.kind !== 'empty' && status.kind !== 'starting';
  const { main, sub } = headline(status, model);

  // The remote starts on "Start now" whenever a song can start.
  useEffect(() => {
    (canStart ? startRef : pickRef).current?.focus();
  }, [canStart]);

  useEffect(() => {
    if (!armed) {
      return undefined;
    }
    const timer = setTimeout(() => setArmed(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);

  const start = () => {
    if (canStart) {
      onStartNow();
    }
  };

  const clear = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    onClearBest();
    // The button goes once the board is empty; keep the remote on the lobby.
    pickRef.current?.focus();
  };

  // OK presses the focused button; Back and the arrows are handled here.
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = arrowStep(event.key);
    if (step === 0 && event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (step === 0) {
      return;
    }
    const buttons = [startRef.current, pickRef.current, clearRef.current].filter(
      (button) => button !== null,
    );
    const next = buttons.indexOf(event.currentTarget) + step;
    buttons.at(next % buttons.length)?.focus();
  };

  // Keep the remote's keys here: focus that wanders off (the library behind
  // grabbing it) comes back to the lobby's buttons.
  const onBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const root = rootRef.current;
    if (
      root === null ||
      (event.relatedTarget instanceof Node && root.contains(event.relatedTarget))
    ) {
      return;
    }
    requestAnimationFrame(() => {
      if (root.isConnected && !root.contains(document.activeElement)) {
        (startRef.current ?? pickRef.current)?.focus();
      }
    });
  };

  return (
    <dialog
      ref={rootRef}
      open
      aria-modal="true"
      aria-label={t('firesong.party.lobby')}
      data-nav-passthrough
      className="fixed inset-0 z-40 m-0 grid size-full max-h-none max-w-none grid-rows-[auto_minmax(0,1fr)_auto_auto] gap-[2vh] border-0 bg-linear-to-b from-slate-950 via-indigo-950 to-slate-950 px-[4vw] py-[3vh] text-white"
    >
      <header className="flex items-center gap-[2.4vh]">
        <img src={BRAND_MARK_URL} alt="" className="size-[8vh]" />
        <div className="min-w-0 flex-1" aria-live="polite">
          <p className="truncate text-[5vh] leading-tight font-black">{main}</p>
          {sub !== null && <p className="truncate text-[2.8vh] text-white/70">{sub}</p>}
        </div>
        {!connected && <p className="text-[2.2vh] text-amber-300">{t('firesong.party.offline')}</p>}
      </header>

      <div className="grid min-h-0 grid-cols-[3fr_2fr] gap-[4vw] overflow-hidden">
        <UpNext model={model} />
        <TonightsBest best={model.best} />
      </div>

      <section aria-label={t('firesong.party.joinHint')} className="flex flex-col gap-[1vh]">
        <ul className="grid grid-cols-4 gap-[1.6vw]">
          {model.slots.map((slot) => (
            <SlotCard key={slot.slot} slot={slot} />
          ))}
        </ul>
        {linksError && (
          <p className="text-[2vh] text-amber-300">{t('firesong.party.linksError')}</p>
        )}
      </section>

      <footer className="flex items-center gap-[2vw]">
        {canStart && (
          <button
            ref={startRef}
            type="button"
            onClick={start}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className={cn(
              'rounded-full bg-amber-400 px-[3vh] py-[1.4vh] text-[2.8vh] font-black text-slate-950',
              BUTTON_FOCUS,
            )}
          >
            {t('firesong.party.startNow')}
          </button>
        )}
        <button
          ref={pickRef}
          type="button"
          onClick={onPickSong}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
          className={cn(
            'rounded-full px-[3vh] py-[1.4vh] text-[2.8vh] font-black',
            canStart ? 'border-[0.3vh] border-white/40 text-white' : 'bg-amber-400 text-slate-950',
            BUTTON_FOCUS,
          )}
        >
          {t('firesong.party.pickSong')}
        </button>
        {model.best.length > 0 && (
          <button
            ref={clearRef}
            type="button"
            onClick={clear}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className={cn(
              'rounded-full border-[0.3vh] border-white/40 px-[3vh] py-[1.2vh] text-[2.4vh] font-bold text-white',
              BUTTON_FOCUS,
            )}
          >
            {t(armed ? 'firesong.party.clearBest.confirm' : 'firesong.party.clearBest')}
          </button>
        )}
        <p className="ml-auto text-[2.2vh] text-white/60">{t('firesong.party.keys')}</p>
      </footer>
    </dialog>
  );
}
