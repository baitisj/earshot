/** Whole-second ages, placed against the actual timestamps of displayed rows. */
export function historyTicks(times: readonly number[], visibleRows: number, height: number) {
  if (!times.length || visibleRows <= 0 || height <= 0 || !Number.isFinite(times[0])) return [];
  const rows = times.slice(0, visibleRows);
  const maxAge = times[0] - rows.at(-1)!;
  const ticks = [{ ageSeconds: 0, row: 0 }];
  if (!Number.isFinite(maxAge) || maxAge < 1) return ticks;
  const rawStep = Math.max(1, maxAge / Math.max(1, Math.floor(height / 90)));
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= rawStep)! * magnitude;
  let row = 1;
  for (let ageSeconds = step; ageSeconds <= maxAge; ageSeconds += step) {
    while (row < rows.length && times[0] - rows[row] < ageSeconds) row++;
    if (row >= rows.length) break;
    const before = times[0] - rows[row - 1];
    const after = times[0] - rows[row];
    if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before) continue;
    const position = row - 1 + (ageSeconds - before) / (after - before);
    // Bursty rows or timestamp gaps can otherwise pile several labels together.
    if ((position - ticks.at(-1)!.row) / visibleRows * height >= 60)
      ticks.push({ ageSeconds, row: position });
  }
  return ticks;
}

/** Screen geometry for a waterfall speed (a power of two, -3..2): slower speeds average
 * `group` rows into each line; faster ones show fewer, taller lines. */
export function speedGeometry(speed: number, baseLines: number) {
  const s = Math.max(-3, Math.min(2, Math.round(speed)));
  return s < 0 ? { group: 2 ** -s, lines: baseLines } : { group: 1, lines: Math.max(8, Math.round(baseLines / 2 ** s)) };
}

export function speedLabel(speed: number) {
  return speed < 0 ? `1/${2 ** -speed}×` : `${2 ** speed}×`;
}

/**
 * Newest-first time of each screen line, grouping rows the way the renderer does
 * (floor(sequence / group)); each line takes the time of its newest row.
 */
export function lineTimes(rows: readonly { sequence: number; time: number }[], group: number, lines: number): number[] {
  const times: number[] = [];
  let key = NaN;
  for (let i = rows.length - 1; i >= 0 && times.length <= lines; i--) {
    const k = group > 1 ? Math.floor(rows[i].sequence / group) : i;
    if (k !== key) {
      times.push(rows[i].time);
      key = k;
    }
  }
  return times.slice(0, lines);
}

/** Index into `rows` of the newest row on screen line `line` (0 = newest). */
export function rowForLine(rows: readonly { sequence: number }[], group: number, line: number): number {
  if (group <= 1) return rows.length - 1 - line;
  let key = NaN;
  let seen = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    const k = Math.floor(rows[i].sequence / group);
    if (k !== key) {
      key = k;
      if (++seen === line) return i;
    }
  }
  return -1;
}
