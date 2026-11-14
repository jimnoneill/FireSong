import { RemoteConnect } from '@/features/remote/remote-connect';
import { SidebarHeader } from '@/shared/components/ui/sidebar';
import { BRAND_LOGO_URL, BRAND_NAME } from '@/shared/firesong-brand';

import { ThemeToggle } from './theme-toggle';

type HeaderProps = {
  remoteIndex: number;
  registerRemoteCallback: (callback: (() => void) | null) => void;
  themeIndex: number;
  registerThemeCallback: (callback: (() => void) | null) => void;
};

export const Header = ({
  remoteIndex,
  registerRemoteCallback,
  themeIndex,
  registerThemeCallback,
}: HeaderProps) => (
  <SidebarHeader>
    <div className="relative flex w-full items-center justify-center pb-2">
      <img src={BRAND_LOGO_URL} className="w-5/6" alt={BRAND_NAME} />
      <div className="absolute right-1 top-0 flex items-center gap-0.5">
        <RemoteConnect
          focusedSidebarIndex={remoteIndex}
          registerCallback={registerRemoteCallback}
        />
        <ThemeToggle focusedSidebarIndex={themeIndex} registerCallback={registerThemeCallback} />
      </div>
    </div>
  </SidebarHeader>
);
