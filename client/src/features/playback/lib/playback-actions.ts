import type { PlaybackCommand, PlaybackStatus } from '@/bridge/playback-status';
import type { TranslationKey } from '@/i18n';

export type PlaybackAction = {
  command: PlaybackCommand;
  labelKey: TranslationKey;
  variant: 'default' | 'outline' | 'destructive';
};

const exitLabelKey = (status: PlaybackStatus): TranslationKey =>
  status.sessionPlayback ? 'playback.actions.exitPlayback' : 'playback.actions.backToMenu';

const nextAction = (
  status: PlaybackStatus,
  variant: PlaybackAction['variant'],
): PlaybackAction[] =>
  status.hasNext
    ? [
        {
          command: 'next',
          labelKey: status.finished ? 'playback.result.nextSong' : 'playback.actions.skip',
          variant,
        },
      ]
    : [];

/**
 * The single definition of which playback actions apply in a given state. The
 * pause overlay, the end-of-song dialog, and the phone remote all render this
 * list, so a new action or a visibility rule only has to change here.
 */
export const playbackActions = (status: PlaybackStatus): PlaybackAction[] => {
  if (!status.active) {
    return [];
  }

  if (status.finished) {
    return [
      ...nextAction(status, 'default'),
      { command: 'exit', labelKey: exitLabelKey(status), variant: 'outline' },
    ];
  }

  // Continue comes first: it is where focus starts, so OK on a remote resumes.
  if (status.paused) {
    return [
      { command: 'resume', labelKey: 'common.actions.continue', variant: 'default' },
      ...nextAction(status, 'outline'),
      { command: 'exit', labelKey: exitLabelKey(status), variant: 'destructive' },
    ];
  }

  return [{ command: 'pause', labelKey: 'common.actions.pause', variant: 'outline' }];
};

/** Exit wording for surfaces that render it outside the action list. */
export const playbackExitLabelKey = exitLabelKey;
