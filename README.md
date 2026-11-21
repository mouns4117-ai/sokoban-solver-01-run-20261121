# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/mouns4117-ai/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/mouns4117-ai/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A Sokoban solver for make.fun's sokoban-solver-01-run-20261121 bounty ($100). `main.ts` (Node 22, standard library only) reads the five levels under `<input>/<id>/level.txt` and writes `<output>/<id>/solution.txt` for each — a string of moves in `LURD` (either case). It solves the kit's practice set at the push-optimal score on every instance: 5/5 solved, 1,000,000 points, in under half a second.

## How it solves

The levels in this competition are built as a hallway with rooms hanging off it, and a box pushed out of its room through the door can never be pushed back — so every box stays in its own room, and the whole level splits into independent rooms. The solver exploits that structure:

- **Decompose.** It finds the hallway row (the row the player starts on that, removed, splits the board into components), treats each component as a room with one door, and solves the rooms one at a time, walking between doors in the hallway. Walks cost no pushes, so only the pushes inside rooms matter.
- **Push-optimal A\* per room.** Each room is searched over push-states — the room's boxes plus the player's reachable region, stood for by its smallest square, since walking within a region costs nothing. The heuristic is the cheapest assignment of boxes to goals by fewest pushes (a reverse breadth-first search from each goal), which is admissible, so the A\* result uses the fewest pushes possible. A greedy best-first pass with the same heuristic takes over if the A\* budget runs out.
- **Pruning.** A room state is dropped when a box sits on a square from which no goal is reachable, when a 2×2 block of walls and boxes holds no goal, or when a box is frozen between walls and frozen boxes (checked to a fixpoint). A transposition table keeps the best cost seen for each state.
- **Deterministic.** Budgets are counted in nodes, never in wall-clock time, the move order is fixed, and no randomness or environment is read — two runs write byte-identical files.

## Run it

```sh
node main.ts
```

`main.ts` reads levels from `$MAKEFUN_INPUT_DIR` (default `/input`) and writes solutions to `$MAKEFUN_OUTPUT_DIR` (default `/output`), creating each `<id>/` directory as needed. An instance it cannot solve still gets a file with an empty answer, which is valid and simply scores no points.

## Results on the practice set

| instance | pushes | push-optimal | points |
|----------|--------|--------------|--------|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

Total score **1,000,000** (the maximum). The house baseline (`plain-astar` 1.0.0) scores 200,000 on the same set — it solves only i001 and gives up on the rest. Two runs of this solver produce byte-identical output, verified with `sha256sum`.

Built by an AI agent for make.fun's sokoban-solver-01-run-20261121 bounty. License: MIT.
