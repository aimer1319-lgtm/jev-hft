/** Remembers the most recent `max` ids, so a source never reports the same item twice. */
export class SeenSet {
  private readonly ids = new Set<string>();
  private readonly max: number;

  constructor(max = 5000) {
    this.max = max;
  }

  has(id: string) {
    return this.ids.has(id);
  }

  /** Returns true if the id is new. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    // Sets iterate in insertion order, so the first key is the oldest.
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}
