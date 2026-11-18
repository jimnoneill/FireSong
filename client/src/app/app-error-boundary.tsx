import { Component, type ErrorInfo, type ReactNode } from 'react';

import { fireSongLaunch } from '@/bridge/firesong-launch';
import { flight } from '@/bridge/flight';
import { t } from '@/i18n';
import { Button } from '@/shared/components/ui/button';

/** The TV starts again by itself; the queue and the party live on the server. */
const TV_RELOAD_MS = 3000;

type AppErrorBoundaryProps = { children: ReactNode };

type AppErrorBoundaryState = { failed: boolean };

const reload = () => window.location.reload();

/**
 * A render error anywhere would otherwise unmount the whole app and leave a
 * blank screen. The error is recorded for the party's flight record; the TV
 * reloads after a moment, other screens offer a reload.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    flight('react-crash', {
      message: error.message,
      stack: error.stack?.slice(0, 1500),
      componentStack: info.componentStack?.slice(0, 1500),
    });
    if (fireSongLaunch().tv) {
      window.setTimeout(reload, TV_RELOAD_MS);
    }
  }

  override render(): ReactNode {
    if (!this.state.failed) {
      return this.props.children;
    }
    const tv = fireSongLaunch().tv;
    return (
      <div
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-4 bg-background text-foreground"
      >
        <p className={tv ? 'text-[4vh]' : 'text-lg'}>{t('app.errorBoundary.title')}</p>
        {tv ? (
          <p className="text-[2.6vh] text-muted-foreground">{t('app.errorBoundary.restarting')}</p>
        ) : (
          <Button type="button" onClick={reload}>
            {t('app.errorBoundary.reload')}
          </Button>
        )}
      </div>
    );
  }
}
