import '@/app/app.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createBrowserPhoneMic } from '@/features/phone-mic/lib/browser';
import { urlWithoutPairingToken } from '@/features/phone-mic/lib/join-link';
import { PhoneMicPage } from '@/features/phone-mic/phone-mic-page';
import { t } from '@/i18n';

const withoutToken = urlWithoutPairingToken(window.location.href);
if (withoutToken !== null) {
  window.history.replaceState(null, '', withoutToken);
}

const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
const followColorScheme = (): void => {
  document.documentElement.classList.toggle('dark', darkScheme.matches);
};
followColorScheme();
darkScheme.addEventListener('change', followColorScheme);
document.title = t('phoneMic.documentTitle');

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing application root');
}

createRoot(root).render(
  <StrictMode>
    <PhoneMicPage app={createBrowserPhoneMic()} />
  </StrictMode>,
);
