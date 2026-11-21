// Sokoban solver for make.fun — sokoban-solver-01-run-20261121.
//
// Idea: the generator builds every level as a hallway with one to four small
// rooms off it, each room holding 3 or 4 boxes and as many goals, and a box
// pushed out of its room through the door can never come back. So a level's
// push-optimal count is the sum of its rooms' optima, and each room can be
// solved on its own: a push-optimal A* over push-states (boxes + the region
// the player can reach), with a heuristic of assigned push-distances, dead
// square pruning, 2x2 blocks and frozen boxes. The rooms are then stitched
// together with free walks through the hallway; only pushes count for the
// score, so solving every room in its optimal pushes scores the full 1,000
// points per instance.
//
// Determinism: every search is bounded by a count of expanded states, never
// by the wall clock — the grader runs the program twice and the two outputs
// must match byte for byte, so a clock cut-off would answer differently from
// one run to the next. No time, no randomness, fixed iteration orders.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, in expanded states. Deterministic by construction.
const ROOM_ASTAR_BUDGET = 1_000_000;
const ROOM_GREEDY_BUDGET = 500_000;
const TOTAL_BUDGET = 6_000_000;

type Step = { dx: number; dy: number; ch: string };
const DIRS: Step[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

// Every ordering of up to 4 goal indices, for the assignment heuristic.
const PERMS: number[][][] = [[], [], [], [], []];
for (let k = 1; k <= 4; k++) {
  const out: number[][] = [];
  const used = new Array<boolean>(k).fill(false);
  const cur: number[] = [];
  const rec = (): void => {
    if (cur.length === k) { out.push([...cur]); return; }
    for (let g = 0; g < k; g++) {
      if (used[g]) continue;
      used[g] = true; cur.push(g); rec(); cur.pop(); used[g] = false;
    }
  };
  rec();
  PERMS[k] = out;
}

type Level = {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall
  goals: number[]; // square indices, sorted
  boxes: number[]; // square indices, sorted
  player: number; // square index
};

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const s = y * w + x;
      if (ch === '#') wall[s] = 1;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(s);
      if (ch === '$' || ch === '*') boxes.push(s);
      if (ch === '@' || ch === '+') player = s;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

type Room = {
  squares: number[]; // room floor squares, sorted
  inRoom: Uint8Array; // 1 = square is a room square; boxes live here
  floor: Uint8Array; // 1 = square the player may stand on while solving (room + entry)
  boxes: number[]; // room boxes, sorted
  goals: number[]; // room goals, sorted
  door: number; // room square adjacent to the hallway
  entry: number; // hallway square adjacent to the door
};

// Split a level into its rooms: remove the hallway (the player's row, or
// failing that the player's column) and take the connected floor components
// that hold boxes and goals. Each room opens onto the hallway through one
// door square. Falls back to the whole level as a single room.
function findRooms(level: Level): Room[] {
  const { w, h, wall, boxes, goals, player } = level;
  const py = Math.floor(player / w);
  const px = player % w;
  for (const horizontal of [true, false]) {
    const isHall = (s: number): boolean =>
      horizontal ? Math.floor(s / w) === py : s % w === px;
    const seen = new Uint8Array(w * h);
    const rooms: Room[] = [];
    let ok = true;
    for (let s = 0; s < w * h; s++) {
      if (wall[s] || isHall(s) || seen[s]) continue;
      const comp: number[] = [];
      const q: number[] = [s];
      seen[s] = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const c = q[qi]!;
        comp.push(c);
        for (const d of DIRS) {
          const nx = (c % w) + d.dx;
          const ny = Math.floor(c / w) + d.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const n = ny * w + nx;
          if (wall[n] || isHall(n) || seen[n]) continue;
          seen[n] = 1;
          q.push(n);
        }
      }
      const cb = comp.filter((c) => boxes.includes(c)).sort((a, b) => a - b);
      const cg = comp.filter((c) => goals.includes(c)).sort((a, b) => a - b);
      if (cb.length === 0 && cg.length === 0) continue;
      if (cb.length !== cg.length) { ok = false; break; }
      const doors = comp.filter((c) =>
        DIRS.some((d) => {
          const nx = (c % w) + d.dx;
          const ny = Math.floor(c / w) + d.dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) return false;
          const n = ny * w + nx;
          return isHall(n) && !wall[n];
        }),
      );
      if (doors.length === 0) { ok = false; break; }
      doors.sort((a, b) => a - b);
      const door = doors[0]!;
      let entry = -1;
      for (const d of DIRS) {
        const nx = (door % w) + d.dx;
        const ny = Math.floor(door / w) + d.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n = ny * w + nx;
        if (isHall(n) && !wall[n]) { entry = n; break; }
      }
      if (entry < 0) { ok = false; break; }
      const inRoom = new Uint8Array(w * h);
      for (const c of comp) inRoom[c] = 1;
      const floor = new Uint8Array(w * h);
      for (const c of comp) floor[c] = 1;
      floor[entry] = 1;
      comp.sort((a, b) => a - b);
      rooms.push({ squares: comp, inRoom, floor, boxes: cb, goals: cg, door, entry });
    }
    if (ok && rooms.length > 0) {
      const assigned = rooms.reduce((a, r) => a + r.boxes.length, 0);
      if (assigned === boxes.length) {
        // A room whose door is a goal goes last: a box ending on such a door
        // would trap the player inside, so those rooms are solved last.
        rooms.sort((a, b) => {
          const ga = goals.includes(a.door) ? 1 : 0;
          const gb = goals.includes(b.door) ? 1 : 0;
          return ga - gb || a.door - b.door;
        });
        return rooms;
      }
    }
  }
  const inRoom = new Uint8Array(w * h);
  const floor = new Uint8Array(w * h);
  const squares: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!wall[s]) { inRoom[s] = 1; floor[s] = 1; squares.push(s); }
  }
  return [{
    squares, inRoom, floor,
    boxes: [...boxes], goals: [...goals],
    door: player, entry: player,
  }];
}

// Per-room tables: which squares a box can still reach a goal from, and the
// fewest pushes from each square to each goal. Both come from one reverse
// search per goal: a box at q could have been pushed to p when the player
// could stand behind q, on the square 2q - p.
type RoomTables = {
  live: Uint8Array; // 1 = a box here can still reach some goal
  dist: Int32Array; // dist[goalIndex * N + square] = fewest pushes to that goal
  INF: number;
};

function buildRoomTables(level: Level, room: Room): RoomTables {
  const N = level.w * level.h;
  const INF = 1e9;
  const live = new Uint8Array(N);
  const dist = new Int32Array(room.goals.length * N).fill(INF);
  const { w, h } = level;
  for (let gi = 0; gi < room.goals.length; gi++) {
    const g = room.goals[gi]!;
    const base = gi * N;
    const q: number[] = [g];
    dist[base + g] = 0;
    live[g] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      const px = p % w;
      const py = Math.floor(p / w);
      for (const d of DIRS) {
        const qx = px - d.dx;
        const qy = py - d.dy;
        const bx = px - 2 * d.dx;
        const by = py - 2 * d.dy;
        if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
        if (bx < 0 || bx >= w || by < 0 || by >= h) continue;
        const prev = qy * w + qx;
        const behind = by * w + bx;
        if (!room.inRoom[prev] || !room.floor[behind]) continue;
        if (dist[base + prev] !== INF) continue;
        dist[base + prev] = dist[base + p] + 1;
        live[prev] = 1;
        q.push(prev);
      }
    }
  }
  return { live, dist, INF };
}

// Fewest pushes still needed, lower bound: the best assignment of boxes to
// goals by push distance. Each push moves one box one square, so the assigned
// sum can drop by at most one per push — admissible, and consistent.
function heuristic(boxes: number[], tables: RoomTables, N: number): number {
  const k = boxes.length;
  if (k === 0) return 0;
  let best = tables.INF;
  for (const perm of PERMS[k]!) {
    let sum = 0;
    for (let i = 0; i < k; i++) {
      const d = tables.dist[perm[i]! * N + boxes[i]!];
      if (d >= tables.INF) { sum = tables.INF; break; }
      sum += d;
      if (sum >= best) break;
    }
    if (sum < best) best = sum;
  }
  return best;
}

// Squares the player can reach from `start`, walking over `floor` squares
// that hold no box. Returns the reached set and its smallest square, which
// stands for the whole region: two player positions in one region are the
// same state, since walking between them costs no push.
function floodRegion(
  start: number, boxSet: Uint8Array, floor: Uint8Array, w: number, h: number,
): { seen: Uint8Array; canon: number } {
  const seen = new Uint8Array(w * h);
  const q: number[] = [start];
  seen[start] = 1;
  let canon = start;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    if (c < canon) canon = c;
    for (const d of DIRS) {
      const nx = (c % w) + d.dx;
      const ny = Math.floor(c / w) + d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (!floor[n] || boxSet[n] || seen[n]) continue;
      seen[n] = 1;
      q.push(n);
    }
  }
  return { seen, canon };
}

// True when a box configuration can never be solved: a box on a dead square,
// a 2x2 block of walls and boxes with no goal, or a box frozen between walls
// and frozen boxes (iterated to a fixpoint — a frozen box never moves again).
function isDead(
  boxes: number[], level: Level, room: Room, tables: RoomTables,
): boolean {
  const N = level.w * level.h;
  const { w, h, wall } = level;
  const boxSet = new Uint8Array(N);
  for (const b of boxes) boxSet[b] = 1;
  for (const b of boxes) {
    if (!tables.live[b] && !room.goals.includes(b)) return true;
  }
  const blocked = (s: number): boolean => {
    if (s < 0 || s >= N) return true;
    return wall[s] === 1 || boxSet[s] === 1;
  };
  for (const b of boxes) {
    const bx = b % w;
    const by = Math.floor(b / w);
    for (const [ox, oy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]] as const) {
      const x0 = bx + ox;
      const y0 = by + oy;
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const cells = [
        y0 * w + x0, y0 * w + x0 + 1,
        (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1,
      ];
      if (cells.every((c) => blocked(c)) && cells.some((c) => boxSet[c] === 1)
        && cells.every((c) => !room.goals.includes(c))) return true;
    }
  }
  const frozen = new Uint8Array(N);
  let changed = true;
  while (changed) {
    changed = false;
    for (const b of boxes) {
      if (frozen[b] || room.goals.includes(b)) continue;
      const bx = b % w;
      const by = Math.floor(b / w);
      let canMove = false;
      for (const d of DIRS) {
        const tx = bx + d.dx;
        const ty = by + d.dy;
        const sx = bx - d.dx;
        const sy = by - d.dy;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const t = ty * w + tx;
        const s = sy * w + sx;
        if (!room.inRoom[t] || frozen[t]) continue;
        if (!room.floor[s] || frozen[s]) continue;
        canMove = true;
        break;
      }
      if (!canMove) { frozen[b] = 1; changed = true; }
    }
  }
  return boxes.some((b) => frozen[b] === 1 && !room.goals.includes(b));
}

// Shortest walk from `from` to `to` over `floor` squares holding no box, or
// null when there is none. Fixed direction order, so the walk is the same
// every run.
function walkPath(
  from: number, to: number, boxSet: Uint8Array,
  floor: Uint8Array, w: number, h: number,
): string | null {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const prevCh: string[] = new Array<string>(w * h).fill('');
  const q: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    if (c === to) break;
    for (const d of DIRS) {
      const nx = (c % w) + d.dx;
      const ny = Math.floor(c / w) + d.dy;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const n = ny * w + nx;
      if (!floor[n] || boxSet[n] || prev[n] !== -1) continue;
      prev[n] = c;
      prevCh[n] = d.ch;
      q.push(n);
    }
  }
  if (prev[to] === -1) return null;
  let out = '';
  for (let c = to; c !== from; c = prev[c]!) out = prevCh[c] + out;
  return out;
}

// A* over push-states for one room, falling back to greedy best-first when
// the A* budget runs out. A state is the room's boxes (sorted, packed into
// one number) plus the player's region, stood for by its smallest square.
// Cost is pushes; the heuristic is the assigned push-distance sum, so the
// A* result is push-optimal. `requireExit` asks the final state to leave the
// player able to reach the door, so the next room can be entered.
type RoomSolution = { moves: string; endPlayer: number };

function boxSetOf(boxes: number[], N: number): Uint8Array {
  const s = new Uint8Array(N);
  for (const b of boxes) s[b] = 1;
  return s;
}

function solveRoom(
  level: Level, room: Room, tables: RoomTables,
  requireExit: boolean, total: { used: number },
): RoomSolution | null {
  const astar = searchRoom(level, room, tables, requireExit, ROOM_ASTAR_BUDGET, total, false);
  if (astar) return astar;
  return searchRoom(level, room, tables, requireExit, ROOM_GREEDY_BUDGET, total, true);
}

function searchRoom(
  level: Level, room: Room, tables: RoomTables,
  requireExit: boolean, budget: number, total: { used: number }, greedy: boolean,
): RoomSolution | null {
  const { w, h } = level;
  const N = w * h;
  const k = room.boxes.length;
  const pack = (bs: number[]): number => bs.reduce((a, b) => a * N + b, 0);
  const unpack = (key: number): number[] => {
    const out: number[] = new Array<number>(k);
    let v = key;
    for (let i = k - 1; i >= 0; i--) { out[i] = v % N; v = Math.floor(v / N); }
    return out;
  };
  const stBox: number[] = [];
  const stPlayer: number[] = [];
  const stG: number[] = [];
  const stH: number[] = [];
  const stParent: number[] = [];
  const stKey: number[] = [];
  const best = new Map<number, number>();
  const score = (i: number): number => (greedy ? stH[i]! : stG[i]! + stH[i]!);
  const less = (a: number, b: number): boolean => {
    const fa = score(a);
    const fb = score(b);
    if (fa !== fb) return fa < fb;
    if (stH[a] !== stH[b]) return stH[a]! < stH[b]!;
    return a < b;
  };
  const heap: number[] = [];
  const heapPush = (i: number): void => {
    let c = heap.length;
    heap.push(i);
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (!less(heap[c]!, heap[p]!)) break;
      [heap[c], heap[p]] = [heap[p]!, heap[c]!];
      c = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const addState = (
    boxesKey: number, player: number, g: number, hh: number, parent: number, key: number,
  ): number => {
    const idx = stBox.length;
    stBox.push(boxesKey);
    stPlayer.push(player);
    stG.push(g);
    stH.push(hh);
    stParent.push(parent);
    stKey.push(key);
    return idx;
  };
  const finish = (goalIdx: number): RoomSolution => {
    const parts: string[] = [];
    let cur = goalIdx;
    while (stParent[cur] !== -1) {
      const p = stParent[cur]!;
      const pBoxes = unpack(stBox[p]!);
      const cBoxes = unpack(stBox[cur]!);
      // The moved box is the one in the parent's set but not the child's
      // (comparing sorted positions index by index is wrong: resorting can
      // shift every index when a box moves past another).
      const from = pBoxes.find((b) => !cBoxes.includes(b))!;
      const to = cBoxes.find((b) => !pBoxes.includes(b))!;
      const d = DIRS.find((dd) => from + dd.dy * w + dd.dx === to)!;
      const behind = from - d.dy * w - d.dx;
      const walk = walkPath(stPlayer[p]!, behind, boxSetOf(pBoxes, N), room.floor, w, h) ?? '';
      parts.push(walk + d.ch);
      cur = p;
    }
    return { moves: parts.reverse().join(''), endPlayer: stPlayer[goalIdx]! };
  };

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const startSet = boxSetOf(startBoxes, N);
  const startRegion = floodRegion(room.entry, startSet, room.floor, w, h);
  const startH = heuristic(startBoxes, tables, N);
  const startIdx = addState(
    pack(startBoxes), room.entry, 0, startH, -1, pack(startBoxes) * N + startRegion.canon,
  );
  best.set(stKey[startIdx]!, startIdx);
  heapPush(startIdx);
  let expanded = 0;
  while (heap.length > 0 && expanded < budget && total.used < TOTAL_BUDGET) {
    const s = heapPop();
    if (best.get(stKey[s]!) !== s) continue;
    const boxes = unpack(stBox[s]!);
    if (boxes.every((b) => room.goals.includes(b))) {
      if (!requireExit) return finish(s);
      const region = floodRegion(stPlayer[s]!, boxSetOf(boxes, N), room.floor, w, h);
      if (region.seen[room.door]) return finish(s);
      continue; // solved but the player cannot leave: no way forward from here
    }
    expanded++;
    total.used++;
    const boxSet = boxSetOf(boxes, N);
    const region = floodRegion(stPlayer[s]!, boxSet, room.floor, w, h);
    for (let bi = 0; bi < k; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (const d of DIRS) {
        const behindX = bx - d.dx;
        const behindY = by - d.dy;
        const tx = bx + d.dx;
        const ty = by + d.dy;
        if (behindX < 0 || behindX >= w || behindY < 0 || behindY >= h) continue;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        const behind = behindY * w + behindX;
        const target = ty * w + tx;
        if (!region.seen[behind]) continue;
        if (!room.inRoom[target] || boxSet[target]) continue;
        const nb = [...boxes];
        nb[bi] = target;
        nb.sort((a, b) => a - b);
        if (isDead(nb, level, room, tables)) continue;
        const hh = heuristic(nb, tables, N);
        if (hh >= tables.INF) continue;
        const g2 = stG[s]! + 1;
        const childRegion = floodRegion(b, boxSetOf(nb, N), room.floor, w, h);
        const key = pack(nb) * N + childRegion.canon;
        const prevIdx = best.get(key);
        if (prevIdx !== undefined) {
          if (greedy) continue;
          if (stG[prevIdx]! <= g2) continue;
        }
        const idx = addState(pack(nb), b, g2, hh, s, key);
        best.set(key, idx);
        heapPush(idx);
      }
    }
  }
  return null;
}

// Solve one level: walk to each room's door, solve the room, walk on. Only
// pushes count for the score, so the walks between rooms are free.
function solveLevel(text: string, total: { used: number }): string {
  const level = parseLevel(text);
  const rooms = findRooms(level);
  const N = level.w * level.h;
  const allFloor = new Uint8Array(N);
  for (let s = 0; s < N; s++) if (!level.wall[s]) allFloor[s] = 1;
  const curBoxes = new Set<number>(level.boxes);
  let player = level.player;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri]!;
    const requireExit = ri < rooms.length - 1;
    const boxSet = new Uint8Array(N);
    for (const b of curBoxes) boxSet[b] = 1;
    const walk = walkPath(player, room.entry, boxSet, allFloor, level.w, level.h);
    if (walk === null) return '';
    moves += walk;
    player = room.entry;
    const tables = buildRoomTables(level, room);
    const res = solveRoom(level, room, tables, requireExit, total);
    if (res === null) return '';
    moves += res.moves;
    for (const b of room.boxes) curBoxes.delete(b);
    for (const g of room.goals) curBoxes.add(g);
    player = res.endPlayer;
  }
  return moves;
}

// One run answers every instance under the input dir, writing
// <output>/<id>/solution.txt for each. An instance that cannot be solved
// still gets a file — an empty answer is valid and worth no points, while a
// missing file would leave the instance unanswered. The output directory
// itself is never removed (in the grader it is a mounted directory).
const ids = readdirSync(INPUT_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const total = { used: 0 };
for (const id of ids) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'), total);
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
}
