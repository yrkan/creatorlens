// node:sqlite behind one function. Node 26 is renaming DatabaseSync to Database (DEP0210); this prefers Database when
// the running Node has it, and falls back to DatabaseSync (CMP-18).

import * as sqlite from 'node:sqlite';

export type Db = sqlite.DatabaseSync;
export type OpenOptions = ConstructorParameters<typeof sqlite.DatabaseSync>[1];

const Ctor: typeof sqlite.DatabaseSync =
  ((sqlite as unknown as Record<string, unknown>).Database as typeof sqlite.DatabaseSync | undefined) ?? sqlite.DatabaseSync;

export function openDatabase(file: string, options?: OpenOptions): Db {
  return options ? new Ctor(file, options) : new Ctor(file);
}

export const sqliteConstants = sqlite.constants;
export const sqliteBackup = sqlite.backup;
