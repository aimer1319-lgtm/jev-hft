// Small helpers shared by the programs that run for a long time (live, record, news-live).

/**
 * A name part that is safe in file names and unique to this run: 2026-09-19T05-53-41-719Z-4821.
 * The number at the end is the process id. Without it, two programs started in the same
 * millisecond (a script starting several at once) would pick the same file and overwrite each
 * other's records, which is exactly what happened in a side-by-side test.
 */
export const fileStamp = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;

/** Log lines go to stderr with the time of day, so stdout stays free for results. */
export const log = (s: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${s}`);

/**
 * Run `stop` once: on Ctrl-C, when the system asks the program to end (SIGTERM, which is what
 * systemd sends), or after `runMs`. A second signal while records are being saved is ignored.
 */
export function onStop(stop: () => void, runMs = 0) {
  let stopping = false;
  const once = () => {
    if (stopping) return;
    stopping = true;
    stop();
  };
  process.on('SIGINT', once);
  process.on('SIGTERM', once);
  if (runMs > 0) setTimeout(once, runMs);
}
