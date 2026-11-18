// Local macOS notifications through osascript: no network, no third party (CMP-11, UX-16). The text is always ours
// (fixed templates with a profile name and dates), never a stranger's.

import type { Exec } from './exec.ts';

function appleScriptString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`;
}

export function notificationScript(title: string, message: string): string {
  return `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
}

export type Notifier = (title: string, message: string) => Promise<void>;

export function makeNotifier(exec: Exec, platform: NodeJS.Platform): Notifier {
  return async (title, message) => {
    if (platform !== 'darwin') return;
    try {
      await exec('/usr/bin/osascript', ['-e', notificationScript(title, message)], { timeoutMs: 10_000 });
    } catch {
      // a notification that cannot be shown never stops the work
    }
  };
}
