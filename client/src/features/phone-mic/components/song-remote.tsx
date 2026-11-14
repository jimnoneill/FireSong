import { PauseIcon, PlayIcon, SquareIcon } from 'lucide-react';
import { useState } from 'react';

import { ConfirmDialog } from '@/features/phone-mic/components/confirm-dialog';
import { KeyTempoEditor } from '@/features/phone-mic/components/key-tempo-editor';
import type { PartyController } from '@/features/phone-mic/lib/party-controller';
import type { PartyState } from '@/features/phone-mic/lib/party-state';
import { currentSong, isPending, stageSongKey } from '@/features/phone-mic/lib/party-view';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

type SongRemoteProps = {
  party: PartyState;
  controller: PartyController;
  disabled: boolean;
};

/** The remote for the song this phone sings: pause or resume, stop, key and tempo. */
export function SongRemote({ party, controller, disabled }: SongRemoteProps) {
  const [confirmStop, setConfirmStop] = useState(false);
  const song = currentSong(party);
  const stage = party.snapshot?.stage;
  if (song === null || stage === undefined) {
    return null;
  }
  const paused = stage.state === 'paused';
  const busy = disabled || isPending(party, 'control');
  const { keyOffset, tempo } = song.settings;

  return (
    <section
      aria-labelledby="phone-remote-title"
      className="flex flex-col gap-4 rounded-2xl border bg-card p-4"
    >
      <div className="min-w-0">
        <h2 id="phone-remote-title" className="text-sm text-muted-foreground">
          {t('phoneMic.remote.heading')}
        </h2>
        <p className="truncate text-lg font-semibold">{song.title ?? ''}</p>
        {song.artist === undefined ? null : (
          <p className="truncate text-sm text-muted-foreground">{song.artist}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Button
          type="button"
          size="lg"
          className="h-14 text-lg"
          disabled={busy}
          onClick={() => controller.control(paused ? 'resume' : 'pause')}
        >
          {paused ? <PlayIcon className="size-6" /> : <PauseIcon className="size-6" />}
          {paused ? t('phoneMic.remote.resume') : t('common.actions.pause')}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="destructive"
          className="h-14 text-lg"
          disabled={busy}
          onClick={() => setConfirmStop(true)}
        >
          <SquareIcon className="size-5" />
          {t('phoneMic.remote.stop')}
        </Button>
      </div>
      {song.shiftable ? (
        <KeyTempoEditor
          key={`${stageSongKey(stage)}:${String(keyOffset)}:${String(tempo)}`}
          party={party}
          controller={controller}
          settings={song.settings}
          disabled={disabled}
        />
      ) : null}
      <ConfirmDialog
        open={confirmStop}
        title={t('phoneMic.remote.stopConfirm')}
        body={t('phoneMic.remote.stopBody')}
        confirmLabel={t('phoneMic.remote.stopYes')}
        destructive
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          controller.control('stop');
        }}
      />
    </section>
  );
}
