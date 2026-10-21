import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Read-only importer for the first adapter release. PostgreSQL owns current state. */
export class LegacyState {
  data: { sessions: Record<string, string>; seen: string[]; outbound: string[]; rates: Record<string, number[]>; paused: boolean };
  private file: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, 'adapter-state.json');
    try { this.data = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; this.data = { sessions: {}, seen: [], outbound: [], rates: {}, paused: false }; }
  }
}
