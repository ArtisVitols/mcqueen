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
- **Raycasting a whole circuit needs `tools/chunk.js` first.** Yoyleland's
  catch fence, grandstands and concrete each *ring the stadium* - 180k to 230k
  triangles apiece with a bounding box covering everything - so three.js
  rejects nothing and every ray brute-forces the lot. `refine_track` fires
  ~400,000 of them: hours became four minutes, and `check_barriers` twenty
  minutes became thirty seconds. Chunking gives each piece a tight box; the
  boxes are accumulated by hand because `computeBoundingBox()` measures the
  whole position attribute rather than the triangles a chunk indexes, which
  would reproduce the bug exactly.
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
dynamics, no assists of any kind). Rivals drive whichever is selected.

**Pro has `assisted: false`, and that is load-bearing.** No corner braking, no
lane holding, no automatic overtake, a fixed-ratio steering rack and no
traction control - the buttons move the front wheels and the tyres decide the
rest. Two consequences to keep in mind before "fixing" them:
- A player holding no buttons has nothing keeping it in a lane, so it wanders.
  That is the definition of no aid, not a defect; `check_steering` measures
  weaving only on cars that are being driven.
- **Easy is not a guaranteed win under Pro**, unlike every other model. The
  aid is what delivered that, and Pro is the one without one. It stays
  driveable - a car with no steering input still follows the road in track
  space - but you have to actually drive to win. `simulate.mjs` asserts the
  win for the aided models and only "not hopeless" for Pro.

`Car.step` keeps everything the rest of the game depends on - integration in
track space, the `psi` clamp, the rev limiter, track limits, lap counting - and
delegates only the forces. That split is the point: a handling change can never
become a lap-counting bug or put a car outside the corridor. Arcade's `drive()`
is the old code moved verbatim, so its race pacing is unchanged and the
"Easy is P1 everywhere" baseline still means something.

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
- **A difficulty has two paces, and Hard is the reason.** `aiSpeed`/`aiCorner`
  are how a rival drives when nobody is racing it; `chaseSpeed`/`chaseCorner`
  are how it drives with a grudge. Hard cruises at Normal's pace so you can
  always reel them in and get by, and only shows its real speed once you are
  ahead - which is what the owner asked for, and better racing than a rival
  that is simply faster than you everywhere and therefore gone.
- **`car.baseSpeed` and `car.topSpeed` are different numbers.** The first is
  what the AI aims at and scales by its grudge; the second is the rev limiter
  in `Car.step`, which clamps whatever anybody asked for. Setting the limiter
  from the cruising pace meant a rival with a grudge aimed at 1.12 and was
  held to 0.95 - the fight-back computed and thrown away one line later.
  Raising them together instead just makes the whole field faster all race.
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
- **Pro's yaw dynamics are written in track yaw, not world yaw.** In world yaw
  a car with no steering input carries straight on while the road turns away,
  the slip angles run away, both axles saturate - and at that point the
  restoring moment is *zero*, because a balanced car has `a·Wf = b·Wr` - so it
  spins on the spot for the rest of the lap. In track yaw a car left alone
  follows the road exactly as it does under Arcade, and the tyre forces are
  what let it deviate. The corner is still paid for through `vy`.
- **The engine is power-limited (`S_POWER / v`) and traction-limited
  (`P_TRACTION` of the rear grip).** Neither is decoration. A flat force figure
  is a full g at 200 km/h, and under Pro that comes straight out of the rear
  tyres through the friction ellipse: it left them a third of their grip and
  the car spun off the grid with no input at all.
- **`P_ALIGN` is what makes Pro driveable.** Self-aligning torque pulls the car
  round to point where it is actually travelling. Without it, moderate slip is
  divergent - the car keeps rotating after the driver lets go, which is exactly
  what "chaotic" feels like. It does not stop you spinning it; it stops the
  spin being unrecoverable.
- **A spun car must be able to drive away.** Below about 10 m/s the tyres have
  faded out and cannot straighten the car themselves, so the recovery net has a
  floor under its unwinding rate and stops scrubbing speed once the car is
  slow. Without both, three cars once sat spinning for a 900-second race.
- **Anything a controller feeds is not allowed a discontinuity.** Sport's
  self-centring used to switch on below `|steer| < 0.05`; a closed-loop
  controller settles *exactly* there and chatters across it, and that half-metre
  limit cycle cost the player 15% of top speed on Yoyleland. Fade, do not
  switch. For the same reason `psiDot` in the friction circle is low-passed: a
  raw per-step difference of a thousandth of a radian reads as 0.6 rad/s, which
  at racing speed is 40 m/s^2 of cornering load that is not there.

## Rivals that fight back

`Driver.fight` is 0..1 and the rule is one line: **a rival chases while a
human is ahead of it.** It winds up over a second and a half, buys that driver
pace, corner commitment, a better tow and more appetite for a move, and winds
down again once it is back in front. `tuning.defend` is separate - how far they
will move to cover the inside line before you commit. Both are per-difficulty.

- **Sustained, not a timer.** It used to be "for ten seconds after being
  passed", which faded whether or not you were still ahead: get by the whole
  field and they all quietly gave up and you cruised to the flag unopposed.
  Being ahead of them is what switches it off, so passing everybody switches
  everybody on.
- **The floor belongs to the decay, not the rise.** `if (fight < 0.01) fight = 0`
  applied to a value winding *up* eats the first increment of every step -
  which is smaller than the floor - and the grudge never leaves zero. It cost
  an hour of looking at a chase that was correctly computed and never applied.
- **Hard's chase pace is a fraction of the player's own limiter.** 1.10 lands
  about 20 km/h above what the player actually reaches once drag is paid,
  which is enough to hunt a leader down and not enough to drive away.
- **The rubber band has to stand down for a car that is chasing.** `rubberBand`
  reels in any AI that gets ahead, which is precisely the car coming back at
  you, so `Race.rubberBand` scales its reeling-in by `1 - car.fight`. The
  handicap comes off while they hunt and returns once they are past you, which
  *is* the "they get harder, then they get weaker again" the owner asked for.
- **A car directly behind the one that just passed it can never be closing**,
  because the same AI lifts rather than driving through the back of anybody. So
  requiring closing speed before attempting a move locked a rival into second
  place the instant it lost first. A grudge lets it pull out regardless.
- **A committed move needs a brisk closing rate.** Under Pro the lane-holding
  gain crosses 1.4 m in about three seconds, which is longer than an overtake
  or a defensive move lasts, so every move was abandoned half-finished.
  `COMMITTED_CLOSE` is used while `commit` or `defend` is up, and the ordinary
  gain for drifting back to the line afterwards.
- **Defending concedes.** One move to cover the inside, held a couple of
  seconds, then a cooldown - and dropped the moment the challenger is
  alongside. Easy sets `defend: 0` outright; a five-year-old holding the
  throttle down has to be able to get past, and that outranks the racing.
- **A finished car keeps rolling and moves to the outside** (`Race.coolDown`).
  Braking to a stop is fine when the field finishes within seconds of each
  other and a race-stopper when it does not: over five laps the leaders parked
  on the racing line, the last car would not drive through them, and the race
  never ended.

## Steering, and why it is one function

Every car - AI, player, all three models - steers through `laneSteer` /
`rateSteer` in `physics.js`. That is deliberate: the same two bugs kept
appearing at both ends.

- **Gain.** At 70 m/s, crossing the track at 4 m/s is 0.06 rad of heading. A
  proportional gain of 1.5 on that asks for 9% of full lock, which is why Sport
  and Pro appeared to have no steering at all on every difficulty except Hard.
- **Damping.** A proportional term on lateral error alone is an undamped
  second-order system, because the heading lags the command. That is what had
  the whole field weaving across Palm Mile's straights in waves. The error
  becomes a *bounded closing rate*, and the damping is on the yaw rate.
- **The slide.** A car at the limit is sliding metres a second, and a
  controller that ignores `vy` holds a fine line all through a corner and then
  slams to full lock the moment the corner ends.
- **The driver's command is its own field.** `car.steerCmd` is what the buttons
  ask for; `car.steer` is what the tyres get. Ramping the input on top of the
  aid's own output fed the controller back on itself and the car stopped
  responding to the buttons entirely.
- **The aid must not swallow the steering.** Pressing left means "go left", at
  a rate the driver can feel - the same thing Arcade does. Only letting go
  means "hold this lane". Blending the player's command away with the
  assistance level is what made steering work on Hard and nowhere else.
- **On Easy the aid also overtakes.** Holding the throttle down has to be
  enough to win, and it is not if the car spends the race nose to tail behind
  someone slower; the field runs in a queue and a player who never touches the
  buttons joins the back of it.

## Wheels

`src/wheels.js` splits four wheels out of every car at load, spins them at road
speed, steers the front pair and leans the body. Nothing re-exports a GLB -
`optimize.sh` is the most trap-laden part of this repo and is left alone.

- None of the models ship usable wheel nodes. Most are Sketchfab OBJ exports
  merged **by material**, so all the wheels sit in one mesh; McQueen and Guido
  are skinned, with bones already in the right places. Hence two routes,
  `fromSplit` and `fromBones`.
- **The count is not four.** Guido is a three-wheeled forklift and Mack a
  ten-wheeled artic, so both routes accept 3..12 and only the *frontmost axle*
  steers - a midpoint test would have Mack steering with his drive axles and
  half his trailer.
- **A bone name ends with `(_|$)`, never `\b`.** These names carry a numeric
  suffix (`Bip01_wheel_front_L_050`), and `\b` between the `R` and the `_`
  matches nothing at all because both are word characters. Tightening the regex
  that way silently took every wheel off the player's car and nothing else's.
  It is also what excludes the `wheelbase_*` bones, which sit in the same
  places and would double the count.
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

## The museum

**MUSEUM** on the main menu: a car on a lit plinth, drag to turn, pinch to
zoom, arrows to step through the field. `src/museum.js`.

- **It borrows the game's scene, camera, fog and background rather than making
  its own.** McQueen is skinned and binds to the world matrix he had at load,
  so lifting the cars into a scratch scene is the trap the skinning note
  warns about. The circuit is hidden, a room is switched on around the same
  cars, and `close()` puts every borrowed thing back - which is why
  `check_museum.mjs` spends half its length racing *after* a visit.
- **Only the controls may take a touch.** `#museum > * { pointer-events: auto }`
  is an ID selector and beats `.mus-hint { pointer-events: none }`, so the
  "drag to turn" caption sat in the middle of the screen and swallowed the one
  gesture it was describing. Enable the controls by name instead.
- Framing comes from each car's measured size. Mater is a metre longer and
  half a metre taller than McQueen; one fixed distance either crops him or
  leaves the low cars tiny. **The room is scaled with it** - `frame()` moves
  the plinth, the lights and the fog, because a rig placed for a 4.4 m car sits
  *inside* an 18 m truck and lights one wheel arch. Intensity rises with the
  square of the distance, since the falloff is inverse-square.
- **All nine cars are on show, including the two that never race.** Guido and
  Mack carry `"racer": false` in `cars.json`, which keeps them off the grid and
  out of the car picker; the showroom is for looking at cars, and they are
  cars. Everything that builds a field uses `racerSpecs`, and the headless sim
  tools filter the same way — a nine-car grid with an artic on it is not the
  race any of them assert anything about.
- A wide flat plinth lit from a sharp angle is the classic recipe for shadow
  acne - it showed as radial banding following the cylinder's triangulation,
  and wants a much bigger `normalBias` than the outdoor sun does.

## Pit stops

A tyre bar drains green to red; steer down to the inside as you pass the pit
entrance and the car peels off, stops on a yellow box, and **Guido** drives
round the four wheels before you rejoin. **Mack** is parked by the wall.
`src/pits.js` is the geometry, `src/pitstop.js` the state machine,
`src/pitcrew.js` the visuals, and `tools/extract_pits.mjs` builds the data.

- **A pit lane cannot be "more `n`".** Track space is one ribbon and the
  arc-length scale `1 + n·κ` degenerates a long way off the centreline, so a
  road 90 m inboard is not somewhere the lap coordinate can reach. `PitRoad`
  is a **second ribbon** that *extends `Track`* and inherits all of it, so
  `Car.step` does not change: a car drives `car.road`, and `car.track` keeps
  owning laps and race order. That split is what stops a pit stop from ever
  becoming a lap-counting bug, exactly as the model/`Car` split stops a
  handling change from becoming one.
- **It has ends, so `wrap` clamps and `span` stops at the last station.**
  Wrapping from the last station back to the first is right for a lap and
  catastrophic for a pit lane.
- **Progress is mapped, not accumulated.** The chord is *shorter* than the arc
  it bypasses - 3.7% at Yoyleland - so paying out its own metres would make
  the pit lane a shortcut. `lapAt` maps distance along the ribbon onto the
  stretch of lap it replaces, which makes the two paths worth exactly the same
  and leaves the cost where it belongs: the speed limit and the stop.
- **Entry and exit are handovers, not teleports.** The ribbon's ends taper
  onto the racing line, so the two overlap in space wherever a handover is
  allowed; `check_pits` asserts that overlap is under a car's length.
- **Anything measured forward of the entry must use `track.delta`.** These pit
  roads run *through* the start/finish - Yoyleland's enters at s = 2394 of a
  2817 m lap - so subtracting raw `s` values goes negative the moment the car
  crosses the line and drops it back to the pit entry mid-lane.
- **Aim at the box from the moment of entry.** `laneSteer` asks for a crossing
  *rate*, so a car that brakes first and moves over second never moves over at
  all: it stopped at n = +3.2 with its box at -3.4, could not steer at zero
  speed, and sat there for the rest of the race. For the same reason the
  STOPPED transition tests only that the car is stationary in the box, never
  stationary *and* aligned - two conditions where the second cannot be fixed
  once the first is true is the definition of a deadlock.
- **The entry window is a place, not a stretch.** Allowing the first half of
  the whole lane let a car turn in level with its own box at racing speed with
  nowhere to brake. It is half the run to the first box, in lap metres.
- **One stop per lap.** A car exits onto the inside lane, which is exactly
  where the entry test is watching, so without `pitDone` the player came
  straight back in - ten times in a twelve-lap race.
- **The chase camera follows `car.road`.** Anchored on the circuit while the
  car is in the pits it sits eighty metres away pointing down an empty
  straight, and the car is simply not in shot. `separate`, `room`,
  `clampLateral` and `coolDown` are road-aware for the same reason - two cars
  at the same lap position on different ribbons are seventy metres apart.
- **`arcScale` is clamped.** The expression is singular at `n·κ = -1`. An oval
  never gets near it, but the entry taper sweeps across the infield in a short
  distance and there a car three metres off the ribbon advanced *five metres
  of lap in one 1/120 s step*.
- **Worn tyres only lose grip**, fading to `0.75` through the same multiplier
  as `car.assist` so it reaches all three models through the one function they
  share and can introduce no discontinuity. Under Arcade the car still cannot
  spin: a five-year-old on worn tyres is slower and never in trouble.
- **Wear is linear in lateral load, not squared.** Squared is more realistic
  and far too sharp - at 2.5 g it wears seven times as fast as cruising, and a
  player at the limit burned a set every other lap. Calibration today: 5 laps
  needs no stop, 10 laps needs one, 20 laps is a three-stopper.
- **The AI pits too**, and **on Easy the aid steers you in** - holding the
  throttle down has to be enough to win, and it is not if the tyres go off and
  nobody ever comes in. Same rule that already makes the aid overtake there.
- **The guest never predicts through a stop**, and takes the host's word for
  where a pitting car is: `s` on the pit ribbon is a distance down a different
  coordinate system, so easing towards it with `track.delta` would interpolate
  between two of them.
- Guido serves the **local player only**. Seven forklifts at once is a car
  park, not a pit stop. His route is driven from the render loop and the stop's
  timing does not wait on it - an animation the simulation waited on would make
  the race depend on the frame rate, and this one renders at 1.7 fps.

## Finding a pit lane in a model

`tools/extract_pits.mjs`, and it is the same class of problem as the road mask.

- **A pit lane shares its material with the inner apron, all the way round.**
  Motor Speedway's `Material.107` is the pit lane along the front straight and
  the apron everywhere else, so asking "where is 107" matched the whole lap and
  produced a 4.8 km pit road. What separates them is **width**: the apron is
  6-7 m, a pit lane 16-17. `pitMinWidth` is that threshold.
- **Width alone is not enough either** - both straights of an oval have a wide
  apron. `pitBoxMaterials` names what sits *behind* the lane (Motor Speedway's
  `Material.100`, the pit boxes), which is the discriminator CLAUDE.md's radial
  order already implied. Palm Mile has no such material and falls back to
  `pitByWidth`, which is only safe because `check_pits.mjs` then has to agree
  the result is on road, clear of walls and joined to the racing line.
- **A pit wall is vertical, so a downward raycast passes straight over it** and
  the two surfaces look continuous. Yoyleland's lane needs no naming at all: it
  is 80 m of grass away and is found by shape.

## Two players, two devices

**2 PLAYERS** on the main menu; START is still single-player and unchanged.
One phone hosts and shows a four-letter code, the other types it in, and they
race each other plus five AI on the usual grid.

`src/net.js` is the protocol, `src/net/guest.js` the guest's view, and there
are three transports behind one `send` / `onMessage` / `close` interface:
`peer.js` (WebRTC through PeerJS's free broker), `loopback.js`
(BroadcastChannel between two tabs, reached with `?net=loopback`) and
`fake.js` (in-process, with latency and loss you choose).
The host runs the real `Race` and owns the result; the guest sends buttons at
30 Hz and gets snapshots at 20 Hz. Everything talks through `send` /
`onMessage` / `close` and nothing else, which is what lets the whole stack be
tested headlessly - see `tools/check_netplay.mjs`.

- **Both devices must lay out the same grid.** `Race.build(playerId, humanIds)`
  orders the humans by their place in `humanIds`, never by who is local.
  Sorting the local car to the back reads perfectly naturally and puts a
  *different* car on the back row of each device: two machines building two
  different grids, nine metres apart before the lights go out.
- **The guest predicts its own car and interpolates everyone else.** Snapping
  every car onto the newest packet shows 20 Hz motion on a 60 Hz screen and
  puts your own car a round trip behind your thumbs.
- **The guest must not predict through the countdown.** The host holds the grid
  still; a guest that runs its own physics anyway has driven most of a lap
  before the lights go out.
- **Extrapolation past the newest snapshot is clamped to the corridor.**
  Running on is what stops a dropped packet freezing the field, but on a lossy
  link the gaps get long enough to draw a car through the wall.
- **PeerJS is vendored as the UMD build, and loaded on demand.** `bundler.mjs`
  has bare imports only a bundler can resolve; the UMD file is self-contained
  and sets `window.Peer`. It is injected as a `<script>` the first time
  somebody chooses multiplayer, so a single-player session never downloads the
  93 KB.
- **Silence is the only reliable sign the other phone has gone.** A closed tab
  fires no event at all and a sleeping phone fires one far too late, so both
  ends watch a clock (`DROP_AFTER`) instead of trusting the transport. The
  host hands the missing car to an AI (`Race.abandon`); the guest goes back to
  the menu.
- **The guest mirrors the start lights off the snapshot, and has to watch the
  race *state*, not just the bulb count.** The fifth bulb lights while the
  countdown is still running, so keying on the count alone means green never
  arrives and the gantry stays lit over a car doing 210 km/h.
- **Everything about the grid comes off the wire.** Circuit, laps, handling and
  AI difficulty are the host's, sent in one message; only the *assist* level is
  each player's own, which is the setting that matters when a parent and a
  five-year-old share a grid. Nothing in `startRace` may read local settings
  when a `start` message is present.
- **`.hint` carries connection status as well as the options blurb.** The
  short-screen rule that hides it is scoped to `#options` for that reason -
  unscoped, the host sees a dead panel instead of "waiting for the other
  player" or an error.
- **A round trip of position is not a bug.** The guest applies a button now,
  the host applies it one latency later, and the snapshot correcting for it is
  another latency old, so the two versions sit `2 x latency x speed` apart:
  8 cm in a room, 8.5 m at 300 ms. `check_netplay` measures the sustained
  offset and the correction peaks separately, because they fail for different
  reasons and a single number lets one hide the other.

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
- **Pit lanes share the road's material, and they run the whole lap.** Palm
  Mile's `Material.219` and Motor Speedway's `Material.107` are pit lanes;
  including either in the road mask drags the centreline onto the wrong side
  of the pit wall and races the entire field down the pit lane. Neither is
  findable by asking "does this cover the whole ring?" - a pit lane continues
  round the rest of the lap as the inner apron, in the same material. What
  identifies it is the *radial order*: at Motor Speedway, outward from the
  infield, it goes `Material.100` (pit boxes) → `107` (pit lane) → `108` (the
  wall) → `105` (the racing surface). The one outboard of the wall is the road.
  Check a race screenshot, not just the numbers.
- **`TARGET_WIDTH` is what sets a circuit's scale**, so narrowing the road mask
  makes the whole track bigger. Dropping the pit lane from Motor Speedway's
  mask took its lap from 1455 m to 3297 m, because the ribbon it scales to 18 m
  was suddenly a third narrower. `targetWidth` is per-track for that reason;
  Motor Speedway's 13 m is the width the racing surface really is, and gives a
  2381 m lap. Setting it above what `refine_track`'s `MAX_HALF` allows just
  throws road away.
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
- **Contact between cars is charged per second, not per step.** `separate()`
  runs at 120 Hz; unscaled, its speed penalty took 14 m/s off a car in half a
  second of light touching, so brushing a rival read as a crash.
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
- **A cross-section must be walked outward from the centreline**, in both
  directions, carrying each height as the guess for the next. Starting at one
  edge with the *centreline's* height as the prior is fatal on a steep bank: at
  Yoyleland's 18° the deck at the inside edge is 2.5 m below the centre, so the
  flat apron underneath it is nearer to the guess and the ray locks onto that.
  It reported the whole superspeedway as flat, and the final sweep then found
  a "wall" at 1132 of 1200 stations - which was the real banking, rising
  through a corridor that had been told it was level. The same mistake in the
  bumper sweep produced the same 1173.
- **Seed each station's height from the stored data, not from the previous
  station's answer.** A running prior is only as good as its worst sample: one
  ray that slips onto the apron hands 0.01 m to the next station and the whole
  rest of the lap follows it off the road.
- **One duff sample is a seam, not an edge.** These circuits are separate
  meshes for asphalt and painted lines, and a ray on a join slips between them
  onto the apron a metre below. Read as a step, that stopped the corridor walk
  two metres from the centreline at a third of Yoyleland's stations.
- **`profileSamples` is per-track.** Five heights across the road is 4.5 m
  apart on a 1:15 circuit and fine; across Yoyleland's 22 m of 18° banking the
  chord between them cuts far enough below a faceted deck that the bumper ray
  clips the road itself.
- **`widen` is one-way, and so is the default.** Normally the walk may only
  *narrow* the road-mask widths; with `widen` it may only *widen* them. Both
  directions matter: re-deriving a working circuit is how regressions ship
  here, and a trial run bore it out - the material stop alone took Palm Mile's
  narrowest point from 12.0 m to 8.05 m, because its pit lane is deliberately
  absent from `roadMaterials` and the corridor legitimately runs up to it.
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
node tools/check_wheels.mjs        # every wheel found, and proof they turn
node tools/check_steering.mjs      # does it steer, and does the field weave?
node tools/check_racing.mjs        # how hard is it actually to overtake?
node tools/check_museum.mjs        # every car on the plinth, and the race after
node tools/check_pits.mjs          # pit roads on asphalt, and a stop end to end
node tools/shots_pits.mjs <track>  # ... and a picture of Guido doing it
node tools/check_fullscreen.mjs    # rotate to landscape, and the tap fallback
node tools/check_netplay.mjs       # host and guest agree, at four latencies
node tools/check_twoplayer.mjs     # two real tabs through the real menus
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

- `simulate.mjs all` — 30 OK: every handling model x circuit x difficulty,
  plus a two-player grid on each circuit. Easy is P1 on all nine
  model x circuit combinations. Hard beats a throttle-pinned player on eight of
  nine; Pro on Motor Speedway is the exception and wants a look.
  If Easy stops being a win, that is a regression regardless of what else
  improved. Worst heading seen anywhere is 81° with every car still finishing;
  the run asserts nothing exceeds 172°, which is where `maxPsi` would be
  holding it.
- `check_wheels.mjs` — the expected count on all nine models (four for the
  racers, three for Guido, ten for Mack), two steered wheels each, every one
  turning 90° for a quarter turn the same way. It checks numerically *and*
  renders, because a tyre is nearly symmetric and a spinning one photographs
  as a still one. The count is per-model in `EXPECTED`, and asserting the
  exact number still matters — "found some wheels" would pass while quietly
  missing an axle.
- `check_racing.mjs` — the answer to "can I pass them?" as a number. It counts
  *duels* (drawing alongside) and what fraction get converted, over five laps,
  **ignoring the opening lap** — the player starts at the back and goes by most
  of the field while everyone is still accelerating, and counting that gave
  every difficulty an identical six passes and hid the thing being measured.
  Passes alone are ambiguous too: zero means both "dominant, nobody left to
  pass" and "cannot get by". The conversion rate separates them. Today:
  Normal converts 78–88% with nobody taking a place back; Hard converts 10–38%
  from three to five times as many duels and takes 5–8 places back. The shape
  is only asserted for the models with a driver aid: Pro has none, so the
  "player" there is a scripted driver whose own quality would dominate the
  numbers, and all that is required of it is that the field is reachable.
- `check_steering.mjs` — every model at every difficulty moves the car at
  1.5 m/s or more across the road at full lock and settles when released, and
  the field weaves less than six times a lap **on the straights**. Counting
  swings everywhere instead flags a car running wide through a corner and
  coming back, which is what it is supposed to do.
- `verify_track.mjs` — median height error 5 mm / 3 mm / 9 mm, and under
  0.2% of points past 0.5 m on all three. The **median** is the signal that
  catches systemic drift.
- `check_barriers.mjs` — zero barriers and zero holes on Motor Speedway and
  Palm Mile. Yoyleland reports 10 and 20, down from 30 and 32: it came through
  the other extraction route and `refine_track` can only *widen* it (see
  `widen` in `tracks.json`), never re-derive it. Nobody has complained about
  it, and it is now strictly better than the road that shipped.
- `check_pits.mjs` — for each circuit: every lane sample on a road material,
  nothing across the lane at bumper height, the ribbon within 15 cm of the
  surface, entry and exit overlapping the racing line — then a whole race, in
  which the player drives in, is frozen for the service, stays under the limit
  at the boxes, gains no progress at either handover, and every car stops.
- `check_grid.mjs` — every slot on the racing surface: `Material.105` on Motor
  Speedway, `Material.227` on Palm Mile, `Asphalt` on Yoyleland. Anything else
  and somebody is starting in the pits - `Material.107` in particular *is* the
  pit lane, and reading it here as a pass is how the whole field raced down it
  for a release.
- `check_netplay.mjs` — both ends agree on the finishing order at every
  latency, no car is ever drawn off the road, and the guest's own car sits
  0.01 m from the host's answer in a room rising to 8.5 m at 300 ms. That last
  figure is `2 x latency x speed` and is not a bug; it is what predicting
  costs, and it is reported apart from the correction peaks so neither can
  hide the other. **A photo finish is allowed to fall either way**: the guest
  predicts its own car, so two cars finishing 0.05 s apart are inside that same
  round trip by an order of magnitude and no correct netcode can resolve them.
  What must never differ is a place that was actually decided.
- `check_twoplayer.mjs` — two tabs build an identical grid, drive, agree on
  where everybody is to within a few metres, clear the start lights, and
  survive one of them closing. It uses the loopback transport, so a green run
  says nothing about the broker: only two real devices can.
- Ride quality: vertical jitter under ~0.5 g at 50 m/s and yaw wobble under
  0.1 deg per station. Above about 1 g the car visibly shakes.
- A session downloads ~3.5 MB and reaches the menu in about 5 s, because only
  the selected circuit loads. `assets/` totals ~9 MB across all three; the
  420k-triangle Yoyleland model is 5.9 MB of that and only arrives if picked.
  PeerJS is another 93 KB and only arrives if somebody taps 2 PLAYERS - keep it
  that way.
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
