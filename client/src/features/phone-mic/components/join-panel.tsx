import { MicIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { problemMessage } from '@/features/phone-mic/components/problem-message';
import { SlotDisc } from '@/features/phone-mic/components/slot-disc';
import type { PhoneMicProblem } from '@/features/phone-mic/lib/session';
import { MAX_NAME_CHARS, slotColor, type MicSlot } from '@/features/remote-mic/protocol';
import { t } from '@/i18n';
import { Alert, AlertDescription } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { playerColorOption } from '@/shared/player-colors';

type JoinPanelProps = {
  slot: MicSlot | null;
  starting: boolean;
  problem: PhoneMicProblem | null;
  defaultName: string;
  onJoin: (name: string) => void;
};

/** "Join as Rose mic": the tap that starts capture, so it must stay a real user gesture. */
export function JoinPanel({ slot, starting, problem, defaultName, onJoin }: JoinPanelProps) {
  const [name, setName] = useState(defaultName);
  const nameId = useId();
  const color = slot === null ? null : slotColor(slot);
  const joinLabel =
    color === null
      ? t('phoneMic.join.any')
      : t('phoneMic.join.asColor', { color: t(playerColorOption(color).label) });

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onJoin(name);
      }}
    >
      <header className="flex flex-col items-center gap-4 pt-6 text-center">
        <SlotDisc color={color} size="lg" />
        <h1 className="text-2xl font-semibold">{t('phoneMic.join.title')}</h1>
      </header>

      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId} className="text-sm">
          {t('phoneMic.join.nameLabel')}
        </Label>
        <Input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t('phoneMic.join.namePlaceholder')}
          maxLength={MAX_NAME_CHARS}
          autoComplete="nickname"
          enterKeyHint="go"
          className="h-11 text-base"
        />
      </div>

      {problem === null ? null : (
        <Alert variant="destructive">
          <AlertDescription className="text-sm">{problemMessage(problem)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" size="lg" disabled={starting} className="h-14 text-lg">
        <MicIcon className="size-6" />
        {starting ? t('phoneMic.join.starting') : joinLabel}
      </Button>

      <p className="text-center text-sm text-muted-foreground">{t('phoneMic.join.keepOpen')}</p>
    </form>
  );
}
