// Which local history versions to delete. Free of editor imports so Node can test it.

const KEEP_DAYS = 14;
const KEEP_VERSIONS = 100;

/** Versions to delete: those older than `days`, and all but the newest `count`. Names are `<ms>.txt`. */
export function toPrune(names: string[], now: number, days = KEEP_DAYS, count = KEEP_VERSIONS): string[] {
  const newestFirst = [...names].sort().reverse();
  return newestFirst.filter((n, i) => i >= count || now - Number.parseInt(n) > days * 86_400_000);
}
