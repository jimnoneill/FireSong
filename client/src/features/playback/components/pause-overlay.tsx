import { fireSongLaunch } from '@/bridge/firesong-launch';
import type { PlaybackCommand } from '@/bridge/playback-status';
import { PlaybackActionButtons } from '@/features/playback/components/playback-action-buttons';
import type { PlaybackAction } from '@/features/playback/lib/playback-actions';
import { t } from '@/i18n';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/components/ui/alert-dialog';

type PauseOverlayProps = {
  open: boolean;
  actions: PlaybackAction[];
  onCommand: (command: PlaybackCommand) => void;
};

/** Sizes for a TV across the room; the desktop keeps the dialog defaults. */
const TV = {
  content: 'gap-[3vh] p-[4vh] data-[size=default]:max-w-[56vw] data-[size=default]:sm:max-w-[56vw]',
  title: 'text-[4.5vh]',
  description: 'text-[2.6vh]',
  button: 'h-[8vh] px-[4vh] text-[3vh]',
};

export const PauseOverlay = ({ open, actions, onCommand }: PauseOverlayProps) => {
  const onContinue = () => onCommand('resume');
  const tv = fireSongLaunch().tv;

  return (
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/80" aria-hidden />}
      <AlertDialog open={open} onOpenChange={(value) => !value && onContinue()}>
        <AlertDialogContent
          className={tv ? TV.content : undefined}
          style={{ animation: 'none' }}
          onEscapeKeyDown={(event) => event.preventDefault()}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className={tv ? TV.title : undefined}>
              {t('playback.pauseOverlay.paused')}
            </AlertDialogTitle>
            <AlertDialogDescription className={tv ? TV.description : undefined}>
              {t('playback.pauseOverlay.exitingNowWonAposTDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <PlaybackActionButtons
              actions={actions}
              onCommand={onCommand}
              open={open}
              onBack={onContinue}
              className="w-full justify-end"
              buttonClassName={tv ? TV.button : undefined}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
