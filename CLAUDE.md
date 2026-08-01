# CLAUDE.md

Working notes for this repo. README.md is for a human wanting to play or hack
on it; this file is the stuff that will cost you an afternoon if you don't know
it. Most entries here exist because they already went wrong once and shipped.

## What this is

A 3D oval racing game for a phone browser, built for the owner's five-year-old.
Static site, no build step, vanilla ES modules, three.js vendored in `vendor/`.
Deployed to GitHub Pages at https://artisvitols.github.io/mcqueen/ from `main`.

Source 3D models live in a Google Drive folder the owner controls;
`tools/fetch_assets.sh` pulls them into `raw/` (gitignored). Only the processed
output in `assets/` is committed.

**Audience matters.** Every design call is "would a five-year-old enjoy this?"
Easy difficulty must be winnable by holding the throttle down and nothing else.
Cars must never spin, stall, or face the wrong way. Prefer forgiving over
realistic when they conflict.

## Environment quirks

- **Node is not on PATH.** It lives in `~/.local/node/bin`. Every shell that
  needs it must `export PATH="$HOME/.local/node/bin:$PATH"` first.
- **Node is only for tooling.** The game itself needs no Node, no bundler and
  no npm at runtime. `tools/node/` holds gltf-transform and puppeteer-core and
  is gitignored.
- `node_modules/three` is a symlink to `vendor/three` so `tools/simulate.mjs`
  can import the same copy the browser uses. `vendor/three/package.json` exists
  purely for that.
- **The snap Firefox here cannot do WebGL, headless or not.** Do not waste time
  on prefs; it refuses. Headless Chrome is installed at
  `~/.local/chrome/chrome-headless-shell-linux64/chrome-headless-shell` and
  renders through SwiftShader. Every browser-based tool uses it via
  puppeteer-core.
- SwiftShader runs at single-digit fps - about 1.7 on Yoyleland's 464k
  triangles, so its 5.4 s countdown takes a minute of wall clock. Waits in the
  test scripts are generous on purpose and every puppeteer launch needs
  `protocolTimeout` raised; don't tighten either.
- `tools/browser.py` drives Firefox via geckodriver for non-WebGL pages
  (the smoke test). Fine for DOM work, useless for rendering.
- **Never `pkill -f "http.server 8099"`.** The pattern matches the shell's own
  command line and kills the session. Use a fresh port instead; the tools each
  pick their own.
- Screenshots must be written under `$HOME` (`~/mcqueen-shots/`). Snap
  confinement blocks writes to `/tmp` from Firefox.

## Architecture: everything lives in track space

A car's state is `(s, n)`: distance along the centreline, and metres sideways
from it, positive towards the outside wall. `src/track.js` converts to world.
Nothing raycasts the stadium at runtime.

This is the load-bearing decision. It buys:

- Lap counting and race order are arithmetic on `s`.
- The tangent rotates as `s` advances, so holding the throttle follows the oval
  by itself. Steering only picks a lane. That is what makes it playable for a
  five-year-old, and under the default Arcade model it makes spinning out and
  facing backwards *structurally* impossible rather than merely unlikely.
- AI lane changes, drafting and overtakes are one number moving.
- The inside line is genuinely shorter: the arc-length scale `1 + n·κ` is
  integrated in `Car.step`, so the low line pays like it does in real NASCAR.

Consequences to respect:

- A car's heading `psi` is clamped, to `physics.maxPsi`. Do not remove the
  clamp; the Pro model widens it to ~150° and catches the rest itself with a
  straightening torque past ~80°, so a spin always ends pointing forwards.
- Track limits are a soft clamp plus a speed scrub, never a crash.
- **The chase camera must be positioned in track space**, not by lerping a
  world position. Smoothing towards a target moving at 50 m/s leaves the camera
  a fixed `v·τ` behind — about 8 m — which is far enough for rivals to slot in
  between it and the player. `placeCamera` anchors at `car.s - back` and only
  smooths the lateral offset.

## Handling models

`src/physics.js` holds three, chosen in OPTIONS: **Arcade** (the original, and
the default), **Sport** (real grip limits, still cannot spin) and **Pro** (yaw
dynamics, can genuinely spin). Rivals drive whichever is selected.

`Car.step` keeps everything the rest of the game depends on - integration in
track space, the `psi` clamp, the rev limiter, track limits, lap counting - and
delegates only the forces. That split is the point: a handling change can never
become a lap-counting bug or put a car outside the corridor. Arcade's `drive()`
is the old code moved verbatim, so its race pacing is unchanged and the
"9 OK, Easy P1 everywhere" baseline still means something.

- **The grip numbers are tuned, not looked up.** These are short ovals: 63 m
  corner radius on Motor Speedway, 99 m on Palm Mile, 255 m on Yoyleland. An
  honest slicks figure has the first two crawling; a textbook banked-corner
  limit at Yoyleland's 18° goes to *infinity* (`mu·tan θ` reaches 1), which is
  why `gripLimit` is capped. What the numbers buy is the right shape - the one
  real superspeedway stays flat out, the two short tracks need a lift.
- **Easy has to be winnable by holding the throttle down, under every model.**
  Grip alone does not deliver that. Under Sport the car arrives at a 63 m
  corner doing 280 and scrubs along the wall; under Pro it is worse, because
  with tyre forces driving the heading a car with no steering input cannot
  generate the inward force a corner needs *at all* - holding the throttle is
  not a slow way round, it is not a way round. So `driverAid` in `physics.js`
  lifts, brakes and steers on Easy, and the buttons move the lane it holds.
  Normal gets a third of it, Hard none.
- **Under a grip model the AI's pace comes from `aiCorner`, not `aiSpeed`.**
  Cornering sets lap time, so that is the knob difficulty has to turn - and the
  rubber band has to reach it too (`car.paceScale`), or Easy quietly stops
  reeling anybody in.
- The AI's steering is proportional on `psi`, which works when the heading *is*
  the command. Under Pro it is a state with inertia behind it, so the same gain
  oscillates and then spins the car; `ai.js` damps on `yawRate` when
  `physics.yawModel` is set.
- A bicycle model is singular at `v = 0`: slip angle is lateral over forward
  speed. Pro floors the reference speed and fades the tyres in, or the cars sit
  on the grid sawing sideways with the friction circle leaving nothing to drive
  with, and no race ever finishes.

## Wheels

`src/wheels.js` splits four wheels out of every car at load, spins them at road
speed, steers the front pair and leans the body. Nothing re-exports a GLB -
`optimize.sh` is the most trap-laden part of this repo and is left alone.

- None of the models ship usable wheel nodes. Six are Sketchfab OBJ exports
  merged **by material**, so all four wheels sit in one mesh; McQueen is skinned
  with a 3ds Max biped whose `Bip01_wheel_*` bones are already right. Hence two
  routes, `fromSplit` and `fromBones`.
- **Weld before splitting.** OBJ exports repeat each corner per face, so
  without welding every triangle is its own island.
- **Give each wheel a compact geometry.** Sharing the vertex buffer and handing
  each wheel a narrower index is cheaper and looks fine - but every bounding box
  then still spans the whole car, and `check_ride_height` reported the split
  cars sitting three metres under the road.
- **Spin direction is derived, never assumed.** McQueen's left-hand wheelbase
  bones carry a rotation that flips their local X, so one shared angle
  counter-rotates a side. Every axle is signed against the car's lateral axis.
- **The body leans, the wheels do not.** Wheels hang off the car pivot; only
  the body group rolls and dives, about an axis at axle height, and it rises by
  `|roll|·halfWidth` so the outside sill does not plough through the asphalt.
  The contact shadow stays flat.
- **`setFromObject` needs the `precise` flag near a rotated wheel.** The cheap
  path measures each mesh's own AABB and then rotates *that*; for a wheel at 45°
  it is 40% too tall, and `check_ride_height` reported every car 17 cm into the
  road when nothing had moved. Same flag McQueen already needed.

## The asset pipeline, and the trap in it

`tools/optimize.sh` is the whole pipeline. Run it after changing any model.

```
bake_transforms.py → weld → simplify → webp → meshopt --quantize-position 16
```

**Bake first, always.** Sketchfab stored the Yoyleland speedway in a local
space spanning ±3,000,000 units, scaled down to ~660 m by the node hierarchy.
Point any quantising compressor at that and it lays its grid over millions of
units: meshopt at its default 14 bits collapsed the banked asphalt onto the
flat apron, put the infield grass on top of the racing line, and left every car
floating a metre above the road — while the physics data, measured off the raw
mesh, carried on being correct. `tools/bake_transforms.py` rewrites the GLB
with transforms baked into the vertices so local coordinates are metres.

**`simplify --error` is a fraction of the mesh radius, not metres.** On an
800 m-radius stadium `--error 0.005` means 3 m of licence. The current values
(0.00007 for Yoyleland, 0.00006 for the small circuits) are about 5 cm.

## Track extraction: two routes

Every circuit ends up as `assets/track-<id>.json` — 1200 centreline stations
with per-station width, surface height and banking — plus an entry in
`assets/tracks.json`. The game does not care which tool produced one.

**Yoyleland** names its materials (`Asphalt`, `Asphalt_Line_2`, …), so
`tools/extract_track.py` works directly on the mesh in Python.

**Motor Speedway and Palm Mile** export 90-odd materials all called
`Material.nnn`. Classifying pixels by colour fails too: their infields contain
grey tarmac and their grandstands contain green seats. The working route is:

```
node tools/topdown.mjs raw/x.glb <id>   # colour + world-height + material-ID passes
python3 tools/extract_oval.py <id>      # trace the ring off the ID mask
node tools/refine_track.mjs <id>        # heights/banking/width by raycasting the shipped asset
```

The material-ID pass renders each material as a unique flat colour from
overhead, so once the road's materials are named the mask is exact. Find them
with `tools/probe_points.mjs` (raycast a world XZ and report what is there) or
by scanning a transect of the ID image. `tools/inspect_track.py` gives scale,
materials and an overhead ASCII map; `tools/material_colours.py` gives each
material's mean rendered colour.

`refine_track.mjs` exists because heights taken from the overhead render are a
pixel wide once a 1:15 model is scaled up — that left the physics surface up to
2 m off the road. It re-derives height, banking and width by raycasting the
asset the game actually loads, fits the cross-slope by least squares across the
lanes cars use, and **narrows the racing surface wherever the real
cross-section curves away from that plane**. A track that pinches at a pit
entry is correct; a car floating over the gap is not.

## Traps that have already bitten

- **An invisible collision shell.** Yoyleland ships `material_0` with
  `alphaMode: BLEND` and alpha 0, a banked shell floating above the road. Any
  raycast or height extraction must skip fully transparent meshes or it locks
  onto the shell instead of the asphalt.
- **Pit lanes share the road's material.** Palm Mile's `Material.219` is the
  pit lane, immediately inside the asphalt. Including it in the road mask
  dragged the centreline sideways and ran the whole field under the pit
  awnings. Check a race screenshot, not just the numbers.
- **McQueen is the only skinned car.** `Box3.setFromObject(obj)` measures his
  bind pose; you need the `precise` flag (`setFromObject(obj, true)`), which
  applies bone transforms. Same for measuring vertices by hand — use
  `mesh.getVertexPosition(i, v)`, not the raw position attribute. And a skinned
  mesh cannot be lifted into a scratch scene and repositioned; it binds to the
  world matrix it had at load. Check it in place.
- **Two stacked surfaces per cell.** Yoyleland's asphalt has a deck and an
  underside about 6 m apart sharing one material. Averaging heights per cell
  flattens the banking to zero; take the max.
- **Left/right convention.** With Y up, `(t × o).y = tz·ox − tx·oz`, and it is
  *negative* when the outward normal is on the driver's right. NASCAR turns
  left, so the infield is on the left and that value must be negative. Getting
  this backwards sends the whole field round clockwise.
- **The lap counter is not off by one.** Cars line up behind the line, so a
  3-lap race shows two increments (1→2, 2→3) plus the finish. `Car.lap` is
  clamped to `totalLaps`.
- **Cache mismatch looks exactly like a physics bug.** GitHub Pages serves
  everything `max-age=600` with no content hashing, so a phone can hold a new
  `track-data.json` beside the previous `track.glb` — cars on banking the model
  no longer has. `index.html` carries a build id and `assetUrl()` stamps every
  request with it. **Run `python3 tools/stamp_version.py` before every deploy.**
  The menu shows the build id; ask for it before debugging a phone report.
- **Never screenshot a page to get a coordinate system.** `tools/topdown.mjs`
  renders inside `tools/smoke.html`, whose CSS sets `body { padding: 14px }`.
  Every overhead pass came out shifted by 14 px - about 6 m once a 1:15 model
  is scaled up, most of a road width - so the extracted racing line ran along
  the grass verge on two circuits while every image-space check said it was
  perfectly centred. It now reads `renderer.domElement.toDataURL()` instead.
  If an image is a coordinate system, take it from the canvas.
- **A radial trace plus a low-pass is only a starting guess.** A rounded
  rectangle's radius function has real high-frequency content; 12 harmonics of
  it wanders metres off a 12 m road. `extract_oval.py` snaps the line onto the
  road mask afterwards, sliding each station to the middle of the strip it
  sits in. Do not remove that pass.
- **A road is not a plane.** These circuits are low-poly and scaled up 15-23x,
  so the surface curves between facets and no single cross-slope fits it. The
  data carries a measured cross-section (`profOffsets` + `profile`, five
  heights across the road) and `Track.rise`/`slope` interpolate it. Forcing a
  plane instead cost 11 cm of typical height error and forced the road to be
  trimmed so narrow the field could not fit; the profile brought it to 3 mm at
  full width. Yoyleland has no profile and falls back to `bank` - which is why
  `sample()` must *clear* `out.prof` when a track has none. Station objects are
  reused across circuits, and a leftover profile crashed the game loop when
  switching from a profiled track to Yoyleland.
- **Raycast samples of a faceted mesh need heavy smoothing.** Unfiltered they
  gave Palm Mile 20 g of vertical jitter and 6 degrees per station of yaw
  wobble - the car visibly shook. `refine_track.mjs` smooths heights and the
  profile with three passes of a wide window, and `extract_oval.py` low-passes
  the snapped centreline, because snapping quantises it to the pixel grid and
  one pixel is over a metre once scaled. Check with the numbers in
  "Verifying", not by eye.
- **`refine_track.mjs` is not idempotent.** It reads the file it writes, so
  running it twice compounds the width trimming. Always run `extract_oval.py`
  first.
- **The grid is laid out in track space**, so it lands wherever the racing
  line's lateral offsets put it. Motor Speedway's start straight is the pit
  straight: the racing surface there runs roughly `n = -6.8 .. +0.8`, with the
  pit wall at `+1.1` and the pit lane beyond it, so a symmetric grid started
  half the field in the pits. `Race.fitGridLanes` measures the corridor across
  every grid row and centres the two columns in what is actually there;
  `gridLanes` in `tracks.json` is only an override for when that is not the
  look you want, and no circuit needs one today. `Track.limit` also reserves a
  full half-car-width (1.6 m), or the bodywork hangs over the edge even though
  the car's centre is legal. `tools/simulate.mjs` builds its `Race` the same
  way the game does — if it ever stops doing that it will pass on a grid
  nobody races.
- **The corridor has to stop at drops and walls, not at the road mask.**
  `extract_oval.py` marks anything that looks like road, which included the lip
  of a 0.7 m drop on Palm Mile's outside line (the bodywork hung over it) and
  the pit lane past Motor Speedway's wall (cars drove straight through it).
  `refine_track.mjs` now walks outward from the centreline in 0.25 m steps and
  stops at a step in height, a missing surface, or anything standing at bumper
  height, then sweeps the finished corridor edge to edge as a check.
  `tools/check_barriers.mjs` is the independent verification: it must report
  zero barriers and zero holes.
- **Nothing in `refine_track.mjs` may take a height from `track.position()`.**
  The `Track` it loads still holds the overhead extraction's surface — the very
  thing the script exists to replace — and on Palm Mile that sits up to a metre
  under the road. The barrier rays were fired off it, so they ran *inside* the
  asphalt, reported the start straight as walled off on both sides, and
  collapsed a 13 m road to the 3.6 m minimum. Every ray takes its Y from the
  downward raycast; the final sweep builds a fresh `Track` from the refined
  arrays. Symptom to watch for: widths pinned at `MIN_HALF` over long stretches
  of a road that verify_track says is perfectly flat.
- **Smoothing a corridor must never widen it.** A moving average over the
  measured widths bulges back over a wall at the few stations either side of
  it, which is enough to clip through. Take `Math.min(smoothed, measured)`.
- **One missing raycast sample is not a hole.** Palm Mile has a single 5 cm
  ray miss on the seam between its two asphalt materials, with continuous
  surface either side — a ray slipping through a shared triangle edge. A gap a
  car can drop into is metres wide, so `check_barriers.mjs` only counts a miss
  with a missing neighbour.
- **Untextured renders are not enough to judge which way a car faces.** Reading
  a grey silhouette wrong had Chick Hicks racing backwards for a release. These
  characters have eyes on the windscreen — render textured and look.

## Verifying

Nothing here needs a GPU. Run these before any deploy; each proves something
different.

```bash
export PATH="$HOME/.local/node/bin:$PATH"

node tools/simulate.mjs all        # every physics x track x difficulty, no renderer
node tools/verify_track.mjs        # shipped models vs physics data
node tools/shots.mjs               # full game flow in headless Chrome
node tools/shots_tracks.mjs        # ... on each circuit
node tools/check_ride_height.mjs   # gap between each car and the road
node tools/diag_cars.mjs <track>   # car facing + wheels on a reference plane
node tools/lap_tour.mjs <track>    # chase cam all the way round a lap
node tools/check_grid.mjs          # what surface each starting slot sits on
node tools/check_barriers.mjs      # walls inside the corridor, holes under the car
node tools/check_wheels.mjs        # 4 wheels per car, and proof they turn
node tools/trace_lap.mjs <t> <phys> # why a lap was slow, half-second by half-second
node tools/cross_section.mjs <t>   # what surface is under each lane, per station
node tools/test_pause.mjs          # in-race pause menu, controls layout
python3 tools/overlay_line.py <t>  # racing line drawn on the overhead render
python3 tools/stamp_version.py --check
```

`tools/smoke.html` (served, then opened via `tools/browser.py`) checks every
asset loads and each car normalises to its real size.

Supporting bits: `tools/glb.py` is the stdlib-only GLB reader the Python tools
share, `tools/probe_candidates.mjs` compares the surface of several compression
builds when changing `optimize.sh`, and `tools/render_cars.py` renders car
contact sheets without a browser - useful for dimensions, but **not** for
deciding which way a car faces; it is untextured, and that is what got Chick
Hicks shipped backwards.

What "good" looks like right now:

- `simulate.mjs all` — 27 OK, i.e. every handling model x circuit x difficulty.
  Easy is P1 on all nine combinations and Hard beats a throttle-pinned player.
  If Easy stops being a win, that is a regression regardless of what else
  improved. Worst heading seen anywhere is 81° with every car still finishing;
  the run asserts nothing exceeds 172°, which is where `maxPsi` would be
  holding it.
- `check_wheels.mjs` — four wheels on all seven cars, each turning 90° for a
  quarter turn, all the same way. It checks numerically *and* renders, because
  a tyre is nearly symmetric and a spinning one photographs as a still one.
- `verify_track.mjs` — median height error 3 mm / 3 mm / 34 mm, and under
  0.2% of points past 0.5 m on all three. The **median** is the signal that
  catches systemic drift.
- `check_barriers.mjs` — zero barriers and zero holes on Motor Speedway and
  Palm Mile. Yoyleland still reports both: its road genuinely is wide, so
  `refine_track`'s `MAX_HALF` would trim it wrongly, and it came through the
  other extraction route. Nobody has complained about it; fixing it needs a
  per-track `MAX_HALF` first.
- `check_grid.mjs` — every slot on the racing surface: `Material.107` on Motor
  Speedway, `Material.227` on Palm Mile, `Asphalt` on Yoyleland. Anything else
  and somebody is starting in the pits.
- Ride quality: vertical jitter under ~0.5 g at 50 m/s and yaw wobble under
  0.1 deg per station. Above about 1 g the car visibly shakes.
- A session downloads ~3.5 MB and reaches the menu in about 5 s, because only
  the selected circuit loads. `assets/` totals ~9 MB across all three; the
  420k-triangle Yoyleland model is 5.9 MB of that and only arrives if picked.
  `loadTrackById` disposes the previous track — do not start caching all three
  on a phone.

**Look at the screenshots, and look at more than one.** Every bug the owner
reported was visible in an image and invisible in the numbers. Checking one
spot proves nothing either: a racing line can sit perfectly on the asphalt at
the start line and run through the infield in turn three, which is exactly
what happened. `tools/lap_tour.mjs` shoots the chase camera all the way round
a lap and `tools/cross_section.mjs` reports what surface is under each lane -
use both before believing a track is right. When checking geometry, put a
reference plane in the scene rather than eyeballing a gap; `diag_cars.mjs`
does this.

**Cars must look planted.** A shadow map alone does not do it: it is off on
Low quality and barely registers on dark asphalt. Every car carries a contact
shadow quad (`contactShadow` in `models.js`). Yoyleland's tarmac is untextured
and washes out pale under a strong sun, hiding both the banking and the
shadows, so `tracks.json` names its asphalt materials for restyling. And if
you touch the sun's shadow frustum, call `updateProjectionMatrix()` — without
it three.js keeps the constructed ±5 default and shadows silently vanish.

## Deploying

```bash
python3 tools/stamp_version.py
git add -A && git commit && git push
gh api repos/ArtisVitols/mcqueen/pages/builds/latest --jq .status   # until "built"
```

Then load the live URL in headless Chrome at a phone viewport and check the
build id matches, rather than assuming the deploy took.

## Conventions

- Comments explain *why*, especially where the code looks odd because of a
  model quirk. Several of the traps above are duplicated as comments at the
  exact line that would otherwise get "simplified" back into a bug.
- Test at real phone sizes: 667×375, 844×390, 915×412. The options panel must
  fit with no scrolling — it once pushed BACK off the bottom of the screen and
  the owner concluded a feature was missing.
- Touch targets are sized for a small child; the `.ctl` floor is 68 px.
- No audio files. Engines, tyres, crowd and the start lights are synthesised in
  `src/audio.js`. Keep it that way — it is zero bytes and zero licensing.
- Copyright is explicitly not a concern here: private family project, models
  are CC-BY Sketchfab uploads, attribution is in the README.
