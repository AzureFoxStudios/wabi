/** An explicit user action owns its result only until another action or teardown. */
export class LatestIntent {
 private version = 0;
 private alive = true;
 begin(): number { return ++this.version; }
 current(version: number): boolean { return this.alive && version === this.version; }
 cancel(): void { this.version++; }
 dispose(): void { this.alive = false; this.cancel(); }
}
