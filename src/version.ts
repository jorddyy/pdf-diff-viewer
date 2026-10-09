export interface BuildInfo {
  version: string;
  commit: string;
  built: string;
}

declare const __APP_BUILD__: BuildInfo;

/** What this page was built from (injected by vite.config.ts). */
export const BUILD: BuildInfo = typeof __APP_BUILD__ === 'undefined' ? { version: '0.0.0', commit: 'dev', built: '' } : __APP_BUILD__;

export const CHANGELOG_URL = 'https://github.com/jorddyy/pdf-diff-viewer/blob/main/CHANGELOG.md';

/** The version currently deployed next to this page, if it differs from the running one. Never sends anything but a GET of version.json. */
export async function newerBuild(): Promise<BuildInfo | null> {
  if (!/^https?:$/.test(location.protocol) || BUILD.commit === 'dev') return null;
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const b = (await r.json()) as BuildInfo;
    return b.commit && b.commit !== BUILD.commit && b.built > BUILD.built ? b : null;
  } catch {
    return null;
  }
}
