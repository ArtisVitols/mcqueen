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
- SwiftShader runs at single-digit fps. Waits in the test scripts are generous
  on purpose; don't tighten them.
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
  five-year-old, and it makes spinning out and facing backwards *structurally*
  impossible rather than merely unlikely.
- AI lane changes, drafting and overtakes are one number moving.
- The inside line is genuinely shorter: the arc-length scale `1 + n·κ` is
  integrated in `Car.step`, so the low line pays like it does in real NASCAR.

Consequences to respect:

- A car's heading `psi` is clamped to ±50°. Do not remove the clamp.
- Track limits are a soft clamp plus a speed scrub, never a crash.
- **The chase camera must be positioned in track space**, not by lerping a
  world position. Smoothing towards a target moving at 50 m/s leaves the camera
  a fixed `v·τ` behind — about 8 m — which is far enough for rivals to slot in
  between it and the player. `placeCamera` anchors at `car.s - back` and only
  smooths the lateral offset.

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
- **Untextured renders are not enough to judge which way a car faces.** Reading
  a grey silhouette wrong had Chick Hicks racing backwards for a release. These
  characters have eyes on the windscreen — render textured and look.

## Verifying

Nothing here needs a GPU. Run these before any deploy; each proves something
different.

```bash
export PATH="$HOME/.local/node/bin:$PATH"

node tools/simulate.mjs all        # every track x difficulty, no renderer
node tools/verify_track.mjs        # shipped models vs physics data
node tools/shots.mjs               # full game flow in headless Chrome
node tools/shots_tracks.mjs        # ... on each circuit
node tools/check_ride_height.mjs   # gap between each car and the road
node tools/diag_cars.mjs <track>   # car facing + wheels on a reference plane
python3 tools/stamp_version.py --check
```

`tools/smoke.html` (served, then opened via `tools/browser.py`) checks every
asset loads and each car normalises to its real size.

What "good" looks like right now:

- `simulate.mjs all` — 9 OK. Easy is P1 on every circuit, Hard beats a
  throttle-pinned player on every circuit. If Easy stops being a win, that is a
  regression regardless of what else improved.
- `verify_track.mjs` — median height error 35 mm / 0 mm / 36 mm. The **median**
  is the signal that catches systemic drift; the tail is per-track in
  `tracks.json` because Motor Speedway has a real step in its source mesh at
  the pit merge.
- A session downloads ~3.5 MB and reaches the menu in about 5 s, because only
  the selected circuit loads. `assets/` totals ~9 MB across all three; the
  420k-triangle Yoyleland model is 5.9 MB of that and only arrives if picked.
  `loadTrackById` disposes the previous track — do not start caching all three
  on a phone.

**Look at the screenshots.** Every bug the owner reported was visible in an
image and invisible in the numbers. When checking geometry, put a reference
plane in the scene rather than eyeballing a gap — `diag_cars.mjs` does this.

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
