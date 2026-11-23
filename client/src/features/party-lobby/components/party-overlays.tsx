import { Hand, Megaphone, PartyPopper, Sparkles, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';

import { useReducedMotion } from '@/features/noraebang/hooks';
import {
  isMicSlot,
  slotColor,
  type FxSound,
  type MicSlot,
  type PartySinger,
  type PartyStage,
} from '@/features/remote-mic/protocol';
import { t, useTranslation, type TranslationKey } from '@/i18n';
import { playerColorOption } from '@/shared/player-colors';
import { cn } from '@/shared/utils/cn';

import { usePartyTv, type FxFlash } from '../party-store';
import { SLOT_STYLES } from '../slot-style';

const FX_LABELS: Readonly<Record<FxSound, TranslationKey>> = {
  applause: 'firesong.fx.applause',
  tambourine: 'firesong.fx.tambourine',
  cheer: 'firesong.fx.cheer',
  'air-horn': 'firesong.fx.airHorn',
};

const FX_ICONS: Readonly<Record<FxSound, LucideIcon>> = {
  applause: Hand,
  tambourine: Sparkles,
  cheer: PartyPopper,
  'air-horn': Megaphone,
};

type Names = ReadonlyMap<MicSlot, string>;

const namesOf = (singers: readonly PartySinger[]): Names => {
  const names = new Map<MicSlot, string>();
  for (const singer of singers) {
    if (isMicSlot(singer.slot) && singer.name !== undefined) {
      names.set(singer.slot, singer.name);
    }
  }
  return names;
};

const nameFor = (names: Names, slot: MicSlot): string =>
  names.get(slot) ?? t(playerColorOption(slotColor(slot)).label);

function Flash({ flash, names, still }: { flash: FxFlash; names: Names; still: boolean }) {
  const style = SLOT_STYLES[slotColor(flash.slot)];
  const Icon = FX_ICONS[flash.sound];
  return (
    <li
      className={cn(
        'flex items-center gap-[1.2vh] rounded-full border-[0.4vh] bg-slate-950/85 px-[2.4vh] py-[1vh] text-[2.8vh] font-black',
        style.border,
        style.text,
        !still && 'animate-in fade-in zoom-in-90 duration-200',
      )}
    >
      <Icon aria-hidden="true" className="size-[3.4vh]" />
      {t('firesong.fx.sent', {
        name: nameFor(names, flash.slot),
        sound: t(FX_LABELS[flash.sound]),
      })}
    </li>
  );
}

const ON_STAGE: ReadonlySet<string> = new Set(['starting', 'singing', 'paused']);

/** The phone singers of the song on stage; none in the lobby or the reveal. */
const onStage = (stage: PartyStage | undefined): MicSlot[] =>
  stage !== undefined && ON_STAGE.has(stage.state) ? stage.singers.filter(isMicSlot) : [];

/** Who is singing the song on stage, each in their colour. */
function StageSingers({ slots, names }: { slots: readonly MicSlot[]; names: Names }) {
  return (
    <ul
      aria-label={t('firesong.party.onStage')}
      className="pointer-events-none fixed top-[21vh] right-[3vw] z-40 flex max-w-[45vw] flex-wrap justify-end gap-[1vh]"
    >
      {slots.map((slot) => (
        <li
          key={slot}
          className={cn(
            'rounded-full border-[0.3vh] bg-slate-950/70 px-[1.8vh] py-[0.5vh] text-[2.6vh] font-bold',
            SLOT_STYLES[slotColor(slot)].border,
            SLOT_STYLES[slotColor(slot)].text,
          )}
        >
          {nameFor(names, slot)}
        </li>
      ))}
    </ul>
  );
}

/**
 * Party notices over the lobby and the song: who is singing, who just played a fun sound (in
 * their colour, without motion when reduced motion is asked for), a phone
 * mic being tuned, and a key change rendering.
 */
export function PartyOverlays() {
  useTranslation();
  const { snapshot, flashes, tuning, shifting } = usePartyTv();
  const still = useReducedMotion();
  const names = useMemo(() => namesOf(snapshot?.singers ?? []), [snapshot]);
  const last = flashes.at(-1);
  const singing = onStage(snapshot?.stage);

  return (
    <>
      {singing.length > 0 && <StageSingers slots={singing} names={names} />}
      {last !== undefined && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none fixed inset-0 z-50 ring-[1.2vh] ring-inset',
            SLOT_STYLES[slotColor(last.slot)].ring,
            !still && 'animate-in fade-in duration-150',
          )}
        />
      )}
      {flashes.length > 0 && (
        <ul
          aria-live="polite"
          className={cn(
            'pointer-events-none fixed right-[3vw] z-50 flex flex-col items-end gap-[1vh]',
            singing.length > 0 ? 'top-[28vh]' : 'top-[4vh]',
          )}
        >
          {flashes.map((flash) => (
            <Flash key={flash.id} flash={flash} names={names} still={still} />
          ))}
        </ul>
      )}
      {tuning !== null && (
        <output className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-[2vh] bg-slate-950/80 text-center text-white">
          <span className={cn('text-[6vh] font-black', SLOT_STYLES[slotColor(tuning)].text)}>
            {t('firesong.party.tuning', { name: nameFor(names, tuning) })}
          </span>
          <span className="text-[3vh] text-white/80">{t('firesong.party.tuningHint')}</span>
        </output>
      )}
      {shifting && (
        <output className="fixed top-[4vh] left-1/2 z-50 -translate-x-1/2 rounded-full bg-slate-950/85 px-[3vh] py-[1.2vh] text-[3vh] font-black text-white">
          {t('firesong.party.shifting')}
        </output>
      )}
    </>
  );
}
