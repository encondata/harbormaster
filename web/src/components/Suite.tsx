// The HSL Suite kit's app switcher and user menu (hsl-ui/suite.js draws them; types in
// hsl-ui/hsl-suite.d.ts). Attributes are strings; sign-out arrives as the hsl-signout event.
import { useEffect, useRef } from 'react';

export type SuiteApp = { id: string; name: string; url: string; description?: string };

/** Hides itself when no apps are configured (HSL_SUITE_APPS). */
export function AppSwitcher({ apps, current }: { apps: SuiteApp[]; current: string }) {
  return <hsl-app-switcher apps={JSON.stringify(apps)} current={current} />;
}

export function UserMenu({ name, detail, profileUrl, onSignOut }: { name: string; detail: string; profileUrl: string; onSignOut: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const signOut = useRef(onSignOut);
  useEffect(() => { signOut.current = onSignOut; });
  useEffect(() => {
    const el = ref.current;
    const on = () => signOut.current();
    el?.addEventListener('hsl-signout', on);
    return () => el?.removeEventListener('hsl-signout', on);
  }, []);
  return <hsl-user-menu ref={ref} name={name} detail={detail} profile-url={profileUrl} />;
}
