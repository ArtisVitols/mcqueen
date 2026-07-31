# McQueen Speedway

A 3D oval racing game for a phone browser, built for a five-year-old. Drive
Lightning McQueen against six rivals from *Cars* around a NASCAR-style
superspeedway.

**Play: https://artisvitols.github.io/mcqueen/**

Open it on a phone, turn the phone sideways, tap START.

## How it plays

- Left thumb: ◀ ▶ steer. Right thumb: ▲ gas, ▼ brake.
- Five red lights, then green, then three laps. Lap counter is top right.
- OPTIONS sets your car, laps (1/3/5), difficulty, graphics quality and sound.
- Difficulty is **Easy** by default: holding the throttle down is enough to
  win. Normal is close, Hard beats a flat-out player.

## How it works

The stadium mesh is 420k triangles, and nothing in the game raycasts against
it. Instead `tools/extract_track.py` reads the speedway once, offline, and
writes `assets/track-data.json`: the oval as 1200 centreline stations with
per-station width, surface height and banking.

Every car then lives in **track space** as `(s, n)` - distance along the
centreline, and metres sideways from it. That one decision buys a lot:

- Lap counting and race positions are integer arithmetic on `s`.
- The tangent rotates as `s` advances, so a player who only holds the throttle
  follows the oval by themselves. Steering just picks a lane. A five-year-old
  can drive it, and spinning out or facing the wrong way is impossible by
  construction.
- The AI can dive to the inside or swing wide by moving one number.
- The inside line is genuinely shorter, because the arc-length scale factor
  `1 + n·κ` is baked into the integration - so the low line pays, like it does
  in real NASCAR.

Everything else is a static site: vanilla ES modules, three.js vendored into
`vendor/`, no build step, no runtime dependencies.

Sound is synthesised with WebAudio - engines, tyre squeal, crowd and the start
lights are all oscillators and filtered noise. No audio files are downloaded.

## Layout

```
index.html  styles.css          the whole app shell
src/track.js                    centreline spline, track space <-> world
src/car.js                      arcade physics in track space
src/ai.js                       opponent drivers: lanes, drafting, overtakes
src/race.js                     grid, countdown, running order, finish
src/main.js                     renderer, camera, menus, game loop
src/{input,hud,audio,models,settings}.js
assets/                         compressed models + extracted track data
tools/                          asset pipeline and tests (not shipped)
```

## Working on it

Needs Node only for the offline asset pipeline and the tests; the game itself
needs neither.

```bash
python3 -m http.server 8000        # then open http://localhost:8000

bash  tools/fetch_assets.sh        # re-download the source models into raw/
python3 tools/extract_track.py     # rebuild assets/track-data.json (+ validates)
bash  tools/optimize.sh            # recompress models into assets/
python3 tools/render_cars.py       # contact sheets to check model orientation

node  tools/simulate.mjs all       # headless race: laps, limits, difficulty
node  tools/shots.mjs              # drive the real game in headless Chrome
```

`tools/simulate.mjs` runs the actual `Track`/`Car`/`Driver`/`Race` code with no
renderer and asserts that every car completes the right number of laps, nobody
leaves the racing surface, overtakes happen, and each difficulty lands where it
should. `tools/smoke.html` checks every asset loads and each car normalises to
its real-world size.

## Credits

3D models are CC-BY from Sketchfab and used here for a private, non-commercial
family project:

- **Lightning McQueen** — [Guilherme Navarro](https://sketchfab.com/3d-models/lightning-mcqueen-cars-987dfeaab6e84bc094b707e77c96f45d)
- **Yoyleland International Speedway** — [RedUnLuckyBlockOSC](https://sketchfab.com/3d-models/yoyleland-international-speedway-nascar-x-bfdi-c6aa0b11a789415b8fe7b2ac8a122db1)
- Chick Hicks, The King, Francesco Bernoulli, Jackson Storm, Mater and Doc
  Hudson are likewise Sketchfab community uploads.

*Cars* and its characters are trademarks of Disney/Pixar. This is a fan project
made for one kid, not affiliated with or endorsed by Disney or Pixar.

three.js is MIT licensed — see `vendor/three/LICENSE`.
