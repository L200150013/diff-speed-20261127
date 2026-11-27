// Fast drop-in for makefun-diff 1.0.0: the same answers, much less CPU.
//
// How it is faster than the reference: the reference allocates a path
// object (plus linked-list components) for every (d, k) step of Myers's
// search and compares lines as strings; this module interns every line to
// one integer id, runs the same greedy search on typed-array V rows (one
// snapshot per depth, kept only for backtracking), and rebuilds the exact
// same edit script by walking those snapshots backwards with the same
// tie-break (a deletion wins when it reaches as far as an insertion).
// Snapshots are Uint16Array when the texts fit (under 65,535 lines) and
// Int32Array otherwise, so the search holds half the memory. No result is
// cached from one case to the next: every run() is fresh.

// v3: v1 structure (per-depth snapshot rows) + micro-optimised k loop
// (edge diagonals handled outside the middle loop, running source indices,
// running snake indices) + INTERN toggle to measure interning's value.
export const FORMAT = 'makefun-diff/1';
export const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

function tokenize(text) {
  const parts = text.split('\n');
  const lines = [];
  const last = parts.length - 1;
  for (let i = 0; i < last; i++) lines.push(parts[i] + '\n');
  if (parts[last] !== '') lines.push(parts[last]);
  return lines;
}

function editRuns(a, b, ox, oy, n, m, IA) {
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[ox + x] === b[oy + y]) {
    x++;
    y++;
  }
  const snaps = [new IA([x])];
  if (x === n && y === m) return [];
  const maxEdit = n + m;
  let foundD = -1;
  let foundK = 0;
  // One snake step from a post-edit point; returns the x reached.
  const snake = (xx, k) => {
    let ai = ox + xx;
    let bi = oy + xx - k;
    const aEnd = ox + n;
    const bEnd = oy + m;
    while (ai < aEnd && bi < bEnd && a[ai] === b[bi]) {
      ai++;
      bi++;
    }
    return ai - ox;
  };
  outer: for (let d = 1; d <= maxEdit; d++) {
    const prev = snaps[d - 1];
    const pm = d - 1;
    const cur = new IA(2 * d + 1);
    // Edge k = -d: only the insertion source (prev diagonal -(d-1), index 0).
    {
      const k = -d;
      const xIns = prev[0];
      if (xIns >= 0 && xIns + d <= m) {
        const xx = snake(xIns, k);
        cur[0] = xx;
        if (xx === n && xx - k === m) {
          foundD = d;
          foundK = k;
          snaps.push(cur);
          break outer;
        }
      } else {
        cur[0] = -1;
      }
    }
    // Middle diagonals: both sources in range; walk them with running indices.
    let iDel = 0;
    let iIns = 2;
    for (let k = -d + 2; k <= d - 2; k += 2) {
      const idx = k + d;
      const xDel = prev[iDel];
      const xIns = prev[iIns];
      iDel += 2;
      iIns += 2;
      const canRemove = xDel >= 0 && xDel < n;
      const canAdd = xIns >= 0 && xIns - k <= m;
      if (!canRemove && !canAdd) {
        cur[idx] = -1;
        continue;
      }
      const byDel = canRemove ? xDel + 1 : -2;
      const byIns = canAdd ? xIns : -2;
      const xx = snake(byDel >= byIns ? xDel + 1 : xIns, k);
      cur[idx] = xx;
      if (xx === n && xx - k === m) {
        foundD = d;
        foundK = k;
        snaps.push(cur);
        break outer;
      }
    }
    // Edge k = d: only the deletion source (prev diagonal d-1, last index).
    {
      const k = d;
      const xDel = prev[2 * pm];
      if (xDel >= 0 && xDel < n) {
        const xx = snake(xDel + 1, k);
        cur[2 * d] = xx;
        if (xx === n && xx - k === m) {
          foundD = d;
          foundK = k;
          snaps.push(cur);
          break outer;
        }
      } else {
        cur[2 * d] = -1;
      }
    }
    snaps.push(cur);
  }
  if (foundD < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  const rev = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = rev[rev.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else rev.push({ kind, count });
  };
  let k = foundK;
  for (let d = foundD; d >= 1; d--) {
    const prev = snaps[d - 1];
    const pm = d - 1;
    const xEnd = snaps[d][k + d];
    let xDel = -1;
    if (k - 1 >= -pm && k - 1 <= pm) xDel = prev[(k - 1) + pm];
    let xIns = -1;
    if (k + 1 >= -pm && k + 1 <= pm) xIns = prev[(k + 1) + pm];
    const canRemove = xDel >= 0 && xDel < n;
    const canAdd = xIns >= 0 && xIns - k <= m;
    const byDel = canRemove ? xDel + 1 : -2;
    const byIns = canAdd ? xIns : -2;
    let xStart;
    let kind;
    let prevK;
    if (byDel >= byIns) {
      xStart = xDel + 1;
      kind = DELETE;
      prevK = k - 1;
    } else {
      xStart = xIns;
      kind = INSERT;
      prevK = k + 1;
    }
    push(KEEP, xEnd - xStart);
    push(kind, 1);
    k = prevK;
  }
  push(KEEP, snaps[0][0]);
  rev.reverse();
  return rev;
}

function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const a = tokenize(input.old);
  const b = tokenize(input.new);
  const n = a.length;
  const m = b.length;

  // Intern every line to one integer id (one shared map, so a line equal
  // in both texts shares its id); the search then compares integers.
  const ids = new Map();
  const aId = new Int32Array(n);
  const bId = new Int32Array(m);
  let next = 0;
  for (let i = 0; i < n; i++) {
    const s = a[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = next++;
      ids.set(s, id);
    }
    aId[i] = id;
  }
  for (let j = 0; j < m; j++) {
    const s = b[j];
    let id = ids.get(s);
    if (id === undefined) {
      id = next++;
      ids.set(s, id);
    }
    bId[j] = id;
  }

  let prefix = 0;
  while (prefix < n && prefix < m && aId[prefix] === bId[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aId[n - 1 - suffix] === bId[m - 1 - suffix]) suffix++;

  const IA = n > 65534 || m > 65534 ? Int32Array : Uint16Array;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...editRuns(aId, bId, prefix, prefix, n - prefix - suffix, m - prefix - suffix, IA));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}
