import { Hand, Megaphone, PartyPopper, Sparkles, type LucideIcon } from 'lucide-react';
import { useMemo } from 'react';

import { useReducedMotion } from '@/features/noraebang/hooks';
import {
  isMicSlot,
  slotColor,
  type FxSound,
  type MicSlot,
  type PartySinger,
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

/**
 * Party notices over the lobby and the song: who just played a fun sound (in
 * their colour, without motion when reduced motion is asked for), a phone
 * mic being tuned, and a key change rendering.
 */
export function PartyOverlays() {
  useTranslation();
  const { snapshot, flashes, tuning, shifting } = usePartyTv();
  const still = useReducedMotion();
  const names = useMemo(() => namesOf(snapshot?.singers ?? []), [snapshot]);
  const last = flashes.at(-1);

  return (
    <>
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
          className="pointer-events-none fixed top-[4vh] right-[3vw] z-50 flex flex-col items-end gap-[1vh]"
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
