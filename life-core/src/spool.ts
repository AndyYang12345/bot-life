import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Local write-ahead handoff. Only the channel's already-authorized events enter here. */
export class Spool<T extends { key: string }> {
  private order = 0n;
  private files = new Map<string, string>();
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(root).filter(n => n.endsWith('.json'))) {
      const hash = name.slice(-69, -5);
      this.files.set(hash, name);
      const prefix = /^(\d{20})-/.exec(name)?.[1];
      if (prefix && BigInt(prefix) > this.order) this.order = BigInt(prefix);
    }
  }
  private syncDir(): void {
    const fd = openSync(this.root, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  put(value: T): void {
    const hash = createHash('sha256').update(value.key).digest('hex');
    const previous = this.files.get(hash);
    if (previous) return;
    const time = BigInt(Date.now()) * 1000000n;
    this.order = time > this.order ? time : this.order + 1n;
    const name = this.order.toString().padStart(20, '0') + '-' + hash + '.json';
    const final = join(this.root, name);
    const temp = final + '.' + randomUUID() + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ value })); fsyncSync(fd); } finally { closeSync(fd); }
    // Do not replace an earlier copy while drain() is awaiting its commit.
    try { linkSync(temp, final); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    finally { unlinkSync(temp); }
    this.syncDir();
    this.files.set(hash, name);
  }
  count(): number { return readdirSync(this.root).filter(p => p.endsWith('.json')).length; }
  async drain(accept: (event: T) => Promise<unknown>, limit = Infinity): Promise<void> {
    // Read payloads only for this batch; a large backlog must not fill process memory.
    for (const name of readdirSync(this.root).filter(p => p.endsWith('.json')).sort().slice(0, limit)) {
      const path = join(this.root, name);
      const { value } = JSON.parse(readFileSync(path, 'utf8')) as { value: T };
      await accept(value); // Unlink only after the database transaction committed.
      unlinkSync(path); this.syncDir();
      if (this.files.get(name.slice(-69, -5)) === name) this.files.delete(name.slice(-69, -5));
    }
  }
}
