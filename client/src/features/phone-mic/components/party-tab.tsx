import { FxPad } from '@/features/phone-mic/components/fx-pad';
import { NightBoard } from '@/features/phone-mic/components/night-board';
import type { PhoneMicApp } from '@/features/phone-mic/lib/app';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import type { MicSlot } from '@/features/remote-mic/protocol';

type PartyTabProps = {
  app: PhoneMicApp;
  party: PartyState;
  slot: MicSlot | null;
  offline: boolean;
};

/** Party: the fun buttons and tonight's best scores. */
export function PartyTab({ app, party, slot, offline }: PartyTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <FxPad
        party={party}
        disabled={offline || party.snapshot?.tvConnected !== true}
        onPlay={(sound) => {
          if (app.party.fx(sound)) {
            app.vibrate(30);
          }
        }}
      />
      <NightBoard party={party} slot={slot} />
    </div>
  );
}
