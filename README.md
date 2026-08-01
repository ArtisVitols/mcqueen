# McQueen Speedway

A 3D oval racing game for a phone browser, built for a five-year-old. Drive
Lightning McQueen against six rivals from *Cars* around one of three
NASCAR-style speedways.

**Play: https://artisvitols.github.io/mcqueen/**

Open it on a phone, turn the phone sideways, tap START.

## How it plays

- Left thumb: ◀ ▶ steer. Right thumb: ▲ gas, ▼ brake.
- Five red lights, then green, then three laps. Lap counter is top right.
- OPTIONS sets your car, the circuit, handling, laps (1/3/5), difficulty,
  graphics quality and sound.
- Difficulty is **Easy** by default: holding the throttle down is enough to
  win, whichever handling model is picked. Normal is close, Hard beats a
  flat-out player.
- The wheels turn at road speed, the front pair steers, and the body leans into
  the corners and noses down under braking.

## Handling

Three models, switchable in OPTIONS and mid-race from the pause menu. Everyone
on track drives whichever you choose.

| | |
|---|---|
| **Arcade** | The default. Hold the gas and the car follows the track; cornering costs nothing and you cannot spin. Built for a five-year-old. |
| **Sport** | Real grip. Carry too much speed in and the car washes wide with the tyres howling; the high line grips, the low line is shorter. Still cannot spin. |
| **Pro** | The rear steps out under power and you have to catch it. You *can* spin — though never so badly that you end up parked facing a wall. |

Sport and Pro add a six-speed gearbox, so the engine steps through the ratios
and the gear shows under the speed.

## The circuits

| Track | Lap | Notes |
|---|---|---|
| Motor Speedway of the South | 2381 m | The Piston Cup stadium from the first film |
| Palm Mile Speedway | 1507 m | Short oval, infield lake, beach behind the stands |
| Yoyleland Speedway | 2817 m | Big banked superspeedway, 18° in the turns |

The two smaller circuits are modelled at roughly 1:15, so the game scales the
model and the extracted racing line by the same factor - every road ends up
about 18 m wide with life-sized cars.

## How it works

The biggest stadium mesh is 420k triangles, and nothing in the game raycasts
against it. Instead each circuit is read once, offline, into a data file: the
oval as 1200 centreline stations with per-station width, surface height and
banking.

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

Finding the road is the hard part, and it differs per circuit. Yoyleland names
its materials `Asphalt`; the other two export 90-odd materials all called
`Material.nnn`, and classifying pixels by colour fails because infields contain
grey tarmac and grandstands contain green seats. What works is
`tools/topdown.mjs`: render the model from directly overhead three times -
colour, world height, and a material-ID pass where each material gets a unique
flat colour. Name the road's materials once (`tools/probe_points.mjs` finds
them) and the mask is exact. Watch out for pit lanes sharing the road's
material - including one put the entire field under the pit awnings.

One trap worth knowing about if you touch the asset pipeline: Sketchfab stored
the speedway in a local space spanning about ±3,000,000 units, scaled down to
~660 m by the node hierarchy. Any quantising compressor lays its grid over
those millions of units and wrecks the model — meshopt at its default 14 bits
collapsed the banked asphalt onto the flat apron, put the infield grass on top
of the racing line, and left every car floating a metre above the road while
the physics carried on regardless. `tools/bake_transforms.py` bakes the
transforms into the vertices first so local coordinates are metres, and
`tools/verify_track.mjs` raycasts the *shipped* asset afterwards to prove the
rendered surface still matches the physics. Run it after any pipeline change.

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
bash  tools/optimize.sh            # bake + recompress every model into assets/
python3 tools/render_cars.py       # contact sheets to check model orientation

# Racing lines. Yoyleland has its own extractor (its materials are named);
# the other two go through the overhead-render route.
python3 tools/extract_track.py             # -> assets/track-data.json
node  tools/topdown.mjs raw/x.glb palm     # -> build/palm_{colour,height,id}.png
python3 tools/extract_oval.py palm         # -> assets/track-palm.json
node  tools/refine_track.mjs palm          # heights/banking by raycasting the asset

python3 tools/inspect_track.py raw/x.glb   # materials, scale, overhead map
node  tools/probe_points.mjs raw/x.glb 1,2 # what is actually at a world point

node  tools/simulate.mjs all       # headless races: physics x track x difficulty
node  tools/trace_lap.mjs msots sport   # why a lap was slow, half-second by half-second
node  tools/verify_track.mjs       # shipped tracks vs physics data - run this!
node  tools/check_ride_height.mjs  # gap between each car and the road
node  tools/check_wheels.mjs       # four wheels per car, and proof they turn
node  tools/check_steering.mjs     # does it steer, and does the field weave?
node  tools/shots.mjs              # drive the real game in headless Chrome
node  tools/shots_tracks.mjs       # ... on every circuit
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
- **Motor Speedway of the South** and **Palm Mile Speedway** are likewise
  Sketchfab community uploads of the Cars circuits
- Chick Hicks, The King, Francesco Bernoulli, Jackson Storm, Mater and Doc
  Hudson are likewise Sketchfab community uploads.

*Cars* and its characters are trademarks of Disney/Pixar. This is a fan project
made for one kid, not affiliated with or endorsed by Disney or Pixar.

three.js is MIT licensed — see `vendor/three/LICENSE`.
