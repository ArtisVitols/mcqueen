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

**Audience matters, and it has moved.** Every design call used to be "would a
five-year-old enjoy this?", and the rule that fell out of it was that Easy had
to be winnable by holding the throttle down and nothing else. The owner has
since taken the difficulty picker away and pinned the game to Hard on Sport -
they race it themselves - so that rule now only survives where a child can
still reach it: the multiplayer HELP setting, which is the same `driverAid`
under a different name. Read `## One difficulty, two handling models` before
concluding that a section below describes something you can select.

What has not moved: cars must never spin, stall, or face the wrong way, and
forgiving beats realistic when the two conflict. That is why contact is a fifth
of what it was and why the heading is clamped in every model.

Where it has got to: eighteen cars race, up to four of them people, on three
circuits, with pit stops, tyre wear, incidents and a lobby. Read `## The field`
and `## The lobby` before touching either - both grew from much smaller
versions and most of the traps below are the seams where they did.

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
  five-year-old, and under Arcade it makes spinning out and facing backwards
  *structurally* impossible rather than merely unlikely. Sport, the default
  now, cannot spin either; only Pro can.
- AI lane changes, drafting and overtakes are one number moving.
- The inside line is genuinely shorter: the arc-length scale `1 + n·κ` is
  integrated in `Car.step`, so the low line pays like it does in real NASCAR.

Consequences to respect:

- A car's heading `psi` is clamped, to `physics.maxPsi`. Do not remove the
  clamp; the Pro model widens it to ~150° and catches the rest itself with a
  straightening torque past ~80°, so a spin always ends pointing forwards.
- Track limits are a soft clamp plus a speed scrub, never a crash.
- **The chase camera must be positioned in track space**, not by lerping a
  world position, **and it has to be told when the ribbon changes.** The
  anchor is `car.s - back`, and eight metres behind a car at the mouth of the
  pit lane is a completely different place on the two roads - measured at 12 m
  turning in and 6 m coming out, in a single frame, while the car itself moved
  0.8 m. `car.n` changes meaning at the same instant. The car crossing cleanly
  is not enough; the *view* is what the owner sees. `placeCamera` carries the
  discontinuity as an offset and decays it with the same frame-rate-independent
  blend the camera already uses for lane changes, so the handover frame moves
  the camera by nothing at all and it slides onto the new anchor over the next
  fraction of a second. `shots_pits` asserts it. Smoothing towards a target moving at 50 m/s leaves the camera
  a fixed `v·τ` behind — about 8 m — which is far enough for rivals to slot in
  between it and the player. `placeCamera` anchors at `car.s - back` and only
  smooths the lateral offset.

## Handling models

`src/physics.js` holds three: **Arcade** (the original), **Sport** (real grip
limits, still cannot spin) and **Pro** (yaw dynamics, no assists of any kind).
Rivals drive whichever is selected.

**Only Sport and Pro are offered**, and Sport is the default - see
`PHYSICS_CHOICES`. Arcade stays because it is still the fallback in `Race` and
because `simulate.mjs` races it: it is the one model with no grip limit at all,
which makes it the control when a handling change looks wrong. Nothing in the
menus can reach it.

**Pro was rewritten once, and the reason is worth keeping.** The first version
was a slip-angle bicycle model - cornering stiffnesses, a friction ellipse,
self-aligning torque. It was chaotic to drive, and structurally so: slip angle
depends on lateral velocity, lateral velocity on tyre force, tyre force on slip
angle. That is a lightly damped second-order loop, so every input rings and at
speed the ringing saturates an axle. It is also singular at a standstill.

The model now runs the other way round and every quantity in it is bounded:
the buttons command a **yaw rate**, kinematically; the tyres pay for it if they
can, and if they cannot the car simply turns less - it **understeers and runs
wide**, which is a thing you can feel; the grip they could not find is charged
as scrub, squared, so a little understeer is quick and arriving far too fast is
ruinous; and power beyond the rear's share rotates the car further into the
corner. `check_steering` is the test that matters: full lock for 1.2 s at
250 km/h now settles back to about 0 degrees instead of spinning.

- **The rack commands a rate, not an angle, and that is a steering *ratio*
  rather than an aid.** A driver with a wheel turns it less at speed without
  thinking; with two buttons the game has to make that choice. A fixed 0.30 rad
  lock asks for 4 rad/s of yaw at 60 m/s when the tyres hold 0.6, so one tap
  wiped the car's speed out and the AI could not steer without scrubbing a
  second a lap away. Nothing in it limits the car to what the tyres have.
- **Retune the AI's gains when the rack changes.** `steerGain` went from 9 to
  3.2 for exactly this reason - the controller output is a *rate* now, and the
  old gain saturated it at full lock 60% of the time.
- **Known, and not yet solved: Pro's AI is slower than Sport's** - about 127 s
  against 111 s over three laps at Motor Speedway - so a throttle-pinned car
  beats it. The model is stable and driveable, which is what it was rewritten
  for; the pace is a separate tuning job. It got a little worse when the
  grudge was made to last, and for a reason worth knowing: under Pro a lane
  change is *charged*, in scrub, so a field that races harder laps slower.
  A throttle-pinned player now wins Pro Hard on all three circuits.

**Pro has `assisted: false`, and that is load-bearing.** No corner braking, no
lane holding, no automatic overtake, a fixed-ratio steering rack and no
traction control - the buttons move the front wheels and the tyres decide the
rest. Two consequences to keep in mind before "fixing" them:
- A player holding no buttons has nothing keeping it in a lane, so it wanders.
  That is the definition of no aid, not a defect; `check_steering` measures
  weaving only on cars that are being driven.
- **The full aid is not a guaranteed win under Pro**, unlike every other model.
  The aid is what delivered that, and Pro is the one without one. It stays
  driveable - a car with no steering input still follows the road in track
  space - but you have to actually drive to win. `simulate.mjs` asserts the
  win for the aided models and only "not hopeless" for Pro. This matters for
  the multiplayer HELP setting: a child given "Lots" on Pro is still not being
  driven around.

`Car.step` keeps everything the rest of the game depends on - integration in
track space, the `psi` clamp, the rev limiter, track limits, lap counting - and
delegates only the forces. That split is the point: a handling change can never
become a lap-counting bug or put a car outside the corridor. Arcade's `drive()`
is the old code moved verbatim, so its race pacing is unchanged and the
"the full aid is P1 everywhere" baseline still means something.

- **The grip numbers are tuned, not looked up.** These are short ovals: 63 m
  corner radius on Motor Speedway, 99 m on Palm Mile, 255 m on Yoyleland. An
  honest slicks figure has the first two crawling; a textbook banked-corner
  limit at Yoyleland's 18° goes to *infinity* (`mu·tan θ` reaches 1), which is
  why `gripLimit` is capped. What the numbers buy is the right shape - the one
  real superspeedway stays flat out, the two short tracks need a lift.
- **The aid has to make holding the throttle down enough, under every model.**
  That was the rule when Easy was a difficulty; it is now what the multiplayer
  HELP setting promises, and the code is the same. Grip alone does not deliver
  it. Under Sport the car arrives at a 63 m
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
- **A person's slipstream has to reach the *limiter*, not the drag.** The AI
  has had a tow since the beginning - `ai.js` scales its target speed by 7% of
  how deep in the wake it is - and it can spend it because it cruises below its
  rev limiter and has headroom. A human holding the throttle down sits *at* the
  limiter, so the drag reduction the Sport and Pro models apply changes how
  fast they reach the same ceiling and not where they end up: the car runs into
  the identical wall either way. Under Arcade it was worse still, because that
  model has no drag term to reduce - `car.draft` was computed for the player
  every step and read by nothing, and Arcade was the default at the time.
  `draftSpeed` sits
  beside `tyreSpeed` in `Car.step`, the one line every model shares, and is
  worth up to 9 km/h. Same shape as the worn-tyre penalty, and for the same
  reason. It **only reaches humans**, because `Race.updateDraft` is only called
  for them, so no AI pacing moved. Measured: passes on Arcade went 22 to 27 on
  Normal and 13 to 20 on Hard, and the time to convert a duel fell about a
  fifth. **The guest computes its own**, or it predicts a slower car than the
  host is running and is corrected forwards on every straight.
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

## The field

**Eighteen cars, and every one of them races.** The owner asked for the whole
Drive folder on the grid, so `cars.json` carries eighteen racers plus Guido and
Mack, who are still `"racer": false` - the pit crew and the parked transporter.

- **Pace is a ladder in `cars.json`, plus a draw.** `spec.pace` is the car's
  *character* - Mater is slow every time - and `Driver` multiplies it by
  `1 +/- PACE_JITTER` drawn once per race, so the order the field settles into
  is not identical every time. Mater sits at 0.84 with the next slowest at
  0.90, deliberately clear: a jitter that could lift the slowest car past
  somebody would make "the tow truck is the slowest" merely usually true.
- **A human is always the quickest thing on the circuit, at cruising pace.**
  That falls out of `aiSpeed` being below `playerSpeed` on every difficulty -
  5% on Normal and Hard, 12% on Easy - and it holds whichever car is picked,
  because a human's speed comes from the difficulty and never from `spec.pace`.
  Both humans in a two-player race get the same. `PACE_CEILING` only stops a
  `pace` typed above 1 in the data from quietly taking that margin away; the
  *chase* pace is still allowed above the player, which is the whole point of
  Hard.
- **The download roughly doubled**, and that is the price of the ask: cars are
  1.6 MB no longer, they are 3.9 MB, so a session is about 5.2 MB on Motor
  Speedway. Every car is loaded before the menu appears, because every car is
  on the grid. If that ever needs to come down, the shape of the fix is to
  show the menu after the player's own car and load the rest during the
  countdown - not to compress the textures further, which the museum would
  show up immediately.
- **Eighteen of anything does not fit a phone.** The car picker and the
  finishing order each scroll *inside their own box*, never by growing the
  panel: BACK, RACE AGAIN and MENU have to stay on screen, and the results
  screen scrolls the player's own line into view because being told you came
  seventeenth and having to hunt for yourself is a puzzle, not a result.
- **A wheel is a place, not a mesh.** Cruz Ramirez and Shu Todoroki carry the
  tyre and the rim as separate materials, so clustering islands *within* one
  mesh gave each car eight wheels and four steered ones; Finn McMissile's split
  across meshes left too few in each to reach `MIN_WHEELS` and he got none at
  all. `fromSplit` now gathers every wheel-shaped island from every mesh first
  and only then decides which of them are the same wheel.
- **Finn McMissile lies along X**, so his `yaw` is -pi/2 - and it is *minus*,
  which only the textured render says. At +pi/2 he showed the camera his boot,
  which is exactly how Chick Hicks shipped backwards. `diag_cars.mjs` takes a
  list of car ids now, because eighteen in one frame are too small to read.

## One difficulty, two handling models

**The difficulty picker is gone and so is Arcade.** The owner races Hard on
Sport and asked for the choices to stop existing: `Settings.load` pins
`difficulty` to `hard` and coerces any saved `arcade`, so a phone that played
the old build is moved rather than left on a setting it can no longer see.
`PHYSICS_CHOICES` is what the two pickers offer.

- **Nothing was deleted from the tables.** `DIFFICULTY.easy` and `.normal` are
  still live, because the multiplayer HELP control maps onto their
  `assist`/`lift` - that is how a child gets a hand on the same grid. Their AI
  fields (aggression, aiSpeed, the concede rule) are now dead, so **the section
  below describes a mode nothing can select.** It is kept because it is the
  record of why Hard's numbers are what they are.
- **Arcade is still in `PHYSICS`** and is still the fallback in `Race`, still
  raced by `simulate.mjs`. It is the only model with no grip limit, which makes
  it a useful control when a handling change looks wrong.
- **The consequence to remember: single-player now has no driver aid at all.**
  `lift` is 0 on Hard, so the corner braking, lane holding and auto-overtake
  that made "hold the throttle down and win" true are only reachable through a
  multiplayer race's HELP setting. If that ever needs undoing, the shape is to
  put HELP in OPTIONS as its own row - it is a different question from how hard
  the AI races.
- The specialised tests were moved to `sport`/`hard` with it: they were all
  running `arcade`/`normal`, which is now a configuration nobody can pick.

## Normal is Hard, and then it lets you win

Every AI number in `DIFFICULTY.normal` is Hard's - aggression, band, fight,
defend, grudge, both paces. The only difference is a rule: **on the final lap
no rival may be quicker than the person**, and they move off the line as well.
That is the owner's specification, and it is why the two settings cannot be
told apart by reading the tuning table.

- **`lift` is not one of the copied numbers**, because it is not an AI number:
  it is the corner-braking aid on the *player's* own car. Taking it away too
  would have made Normal harder to *drive* than Hard under Sport and Pro,
  which is the opposite of the point.
- **Twenty km/h slower than the person, not than its own pace.** Measured
  against its own pace, a rival that was already quicker than you stays
  quicker than you and the lift changes the gap rather than closing it.
  Measured against yours, you close at exactly 20 km/h.
- **Everybody, not only whoever is in front at that instant.** Capping just
  the cars ahead leaks: one that concedes, drops behind and is no longer
  "in front" is released, and with Hard's chase pace it comes straight back
  past at the flag. Nine races of it produced six photo finishes lost by
  hundredths.
- **Lifting is not enough on its own - they have to move.** A car that lifts
  and then sits on the racing line has not let anybody past, it has become a
  slower obstacle. A conceding rival with a human within `LET_RANGE` behind
  also steers off the line, away from the side they are on, and stops
  defending.
- **The promise has a reach, and it is worth knowing.** Twenty km/h over one
  lap buys 116 m at Palm Mile and 215 m at Yoyleland; a rival further up the
  road than that cannot be caught by lifting, and one *exactly* at that
  distance is caught and not passed - which is a photo finish lost, and is the
  mechanism working. `check_racing` asserts the player beats everything within
  four fifths of that distance, and prints where they finished.
- There is a floor (`CONCEDE_FLOOR`) and the pits are excluded, or a player
  held to the pit limit - or sat still in their box being serviced - would
  have the whole field waiting for them.

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
- **... and "close enough to be worth chasing" is half a lap, not a number of
  metres.** This was raised twice for the same reason - 60 m, then 240 m - and
  both times a player who got clear simply drove out of range and the whole
  field relaxed. At Motor Speedway 240 m is a tenth of a lap, so on Hard the
  owner could pass everybody, pull away, and never see them again: `check_racing`
  reported *one duel in five laps* there while every other circuit looked fine.
  `FIGHT_FORGET` is now a fraction of `lapLength`, and the cap only exists so a
  car being lapped does not chase the leader in its mirrors.
- **A car that has completed its move is not stuck behind anybody.** The lift
  that stops a rival driving through the back of the car in front used the same
  3.6 m window that spots traffic, and a move aims 3.4 m to the side - so a
  driver that had pulled fully alongside still counted the other car as being
  in front of it and went on lifting to 92% of its speed. It could draw level
  every lap and never get by. `SAME_LANE` is the narrower window: seeing
  somebody is not the same as being behind them.
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
- **The grudge is a duration, not a halflife.** Half a grudge is still most of
  the pace, so a rival that had passed you kept its extra 20 km/h for the best
  part of a minute and simply left. `tuning.grudge` is now *seconds*, wound
  down linearly to nothing - go past, hold it for about fifteen seconds, come
  back to me - and each driver draws its own fraction of that at the start, or
  the whole field stands down on the same frame and it reads as a switch being
  thrown. Note it can look longer than it is from the cockpit: while you are
  still trading places, being behind you winds it straight back up, which is
  the point.
- **Defending concedes.** One move to cover the inside, held a couple of
  seconds, then a cooldown - and dropped the moment the challenger is
  alongside. Easy sets `defend: 0` outright; a five-year-old holding the
  throttle down has to be able to get past, and that outranks the racing.
- **A finished car keeps rolling and moves to the outside** (`Race.coolDown`).
  Braking to a stop is fine when the field finishes within seconds of each
  other and a race-stopper when it does not: over five laps the leaders parked
  on the racing line, the last car would not drive through them, and the race
  never ended.

## Incidents

A rival occasionally gets it wrong, runs off the racing line and stops. It is
there to be watched - a wreck is the best thing that happens in an oval race
to a five-year-old - and `Race.maybeCrash` / `stepCrash` / `retire` is all of
it. `check_crashes.mjs` proves it is safe and `shots_crash.mjs` proves it looks
right.

- **Not a spin.** Under Arcade a car *cannot* spin, and that is the rule the
  whole game rests on, so this is what getting it wrong looks like here: off
  the power, wide, speed scrubbed off, parked. The aim is past the edge of the
  corridor so the car commits all the way there; `Car.step` clamps it to the
  road, which is where it has to stop anyway.
- **It stops inside the corridor.** Past that edge is wherever `refine_track`
  found a drop or a barrier - precisely the place not to leave a car nobody is
  driving. `retire` parks it half a metre inside the limit, because a car at
  20 degrees is wider than the half-car-width `Track.limit` reserves and the
  rest of it would be through the wall.
- **Never within `CRASH_CLEAR` of a human, including one that has finished.**
  A car that spears off in front of you and cannot be avoided is not a
  spectacle, it is the game crashing *you*. They are still on the road after
  the flag, so the guard does not care whether they are still racing.
- **A retired car is classified, not deleted.** Its `progress` is frozen, so
  sorting by progress alone would have it drift down the order all race
  instead of simply being out of it; `updateOrder` puts `out` last outright.
  It also never crosses the line, so the race-over test cannot be "everybody
  finished" - `accountedFor` counts finished *or* out, and the retirements are
  appended to `results` at the end so the results screen lists everybody. This
  is the same trap as `coolDown`: a race that waits for a car that will never
  arrive does not end.
- **It pushes, it does not get pushed.** `separate` moves the other car by the
  whole overlap rather than half, and never moves a wreck - letting contact
  shift it walks it back onto the racing line one nudge at a time.
- **`out` is on the wire.** The guest sorts its own running order, so without
  it the two ends disagree about a place. That is what `SNAP_STRIDE` went to 13
  for.
- **Tests that measure something else turn it off.** `race.crashRate = 0` in
  `check_pits` (which asserts every car takes a stop, and a car in the wall
  cannot) and in `check_racing` (a stationary car would count as a duel drawn
  and won). `simulate.mjs` leaves it *on* and exempts a retired car from its
  per-car assertions, because what has to stay true is that the race still
  ends.

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
- **A wheel is a disc, so the adoption test has to be disc-shaped.** A box
  around the seed admits whatever is in the *corners* of it, and that is
  exactly where a suspension arm, a diffuser and a wheel arch live: Shu
  Todoroki's wheels came out 1.32 m long against 0.88 tall, and Ivy's grew half
  a metre of upright which then turned with them. Two shapes belong to a wheel
  and nothing else does - a rim, which is nearly as big as the wheel but
  *centred on the axle*, and a tread block, which is out at the rim but
  *small*. Bodywork is the third case, big and off-centre, and it is the one to
  refuse. Sizing alone cannot separate them: a rim is most of the wheel, and a
  monster truck's tread sticks out past the tyre by a third.
- **Every wheel on a car is the same wheel.** `check_wheels` asserts the
  diameter matches across all of them, in both directions, to within 20% -
  width is exempt because Mater's twinned rears are genuinely double. That is
  the only signal that survives a bad adoption: the count is right, the render
  looks busy, and what is turning with the wheel is obvious only to somebody
  watching it go round.
- **A tread block is not wheel-shaped, and is still part of the wheel.** Ivy's
  monster-truck tyres are a smooth carcass, a ring of separate lugs and a rim,
  each its own island and only the carcass round enough to pass `isWheel` - so
  only the carcass turned, and the carcass is the one part with no features on
  it. The wheels were rotating perfectly and the truck looked exactly as though
  they were not. Wheel-shaped islands *seed* a cluster; everything else is then
  offered to them and `adopt`ed on containment rather than shape.
- **An adopted piece has to *touch* the tyre.** A tread block is stuck on the
  circumference, so part of it is inside the disc; a wheel arch floats clear
  above the crown. Nothing about being small and near the rim separates them,
  and Shu Todoroki's fronts took a piece of arch sitting 5 cm above the tyre:
  it turned with the wheel and swept through the bodywork, which is what
  "flickering" was.
- **The axle comes from the seed too, not from the grown box.** The radius
  already did; the centre was the last thing still reading the union, and it is
  the one that decides what the wheel *turns about*. Adoption is not symmetric -
  an arch above the tyre has nothing below it to balance - so the centre drifts.
  Shu's fronts pivoted 10 cm above their own tyres and orbited rather than
  spun. The same pollution made the cluster half a tyre taller, giving a rolling
  radius of 0.474 m against a real tyre of 0.375, so they turned 26% too slowly
  for the road as well. Both symptoms, one cause.
- **Adoption is tested against the seed, never the growing box.** Testing
  against what a cluster has become is a runaway: each piece taken makes the
  box bigger, which admits a bigger piece next time. Sarge's front wheel
  reached a 1.2 m radius and 2,548 triangles that way.
- **`size()` hands back a shared vector**, so measuring two boxes with it gives
  you the second box twice - which is exactly the sort of bug that makes an
  adoption test behave at random.
- **A mesh with no wheel-shaped island still has to be read**, because it may
  hold only the *pieces* of one. Bailing out on it is what left Ivy's treads
  and rims behind.
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

## Clouds and smoke

Three cosmetic things, all generated rather than loaded - the same rule the
audio has, and for the same reasons: zero bytes and zero licensing.
`src/sky.js`, `src/smoke.js`, checked by `check_effects.mjs`.

- **The sky is a canvas texture used as `scene.background`.** One full-screen
  pass and *nothing* per frame: no geometry, no draw call per cloud, no sorting
  against the fog. Billboards would have been the obvious answer and would cost
  more than the cars do on the circuit that needs it most. The clouds sit in
  the band the chase camera actually looks at - low, near the horizon - because
  a cloud at the zenith is a cloud nobody sees, and they are drawn twice near
  the seam because an equirectangular map wraps.
- **A cloud needs a body and a soft rim, not a gradient from the middle.** One
  radial stop reads as haze on the glass; three read as something with a shape.
- **Smoke is one pooled `THREE.Points`** with a shader that works out a puff's
  whole life from its birth time, so the per-frame cost is a single uniform and
  a race where nobody is sliding costs nothing at all. Spawning writes four
  numbers into a ring buffer; when it is full the oldest puff is overwritten,
  which is right at a glance - what you notice is the smoke being made now.
  `frustumCulled` is off and the bounding sphere is enormous, because the pool
  is scattered over the whole circuit and a fitted sphere would blink the lot
  in and out as one.
- **The rate is per second, carried as a fractional debt on the car** - the
  same rule as contact and tyre wear, so how much smoke there is does not
  depend on the frame rate.
- **It is drawn from state the cars already carry.** `car.slip` is the number
  the tyre squeal is mixed from, so what you hear and what you see are the same
  event, and `car.out` marks a wreck - both are already on the wire, so a guest
  sees a rival's slide and a rival's engine without anything extra being sent.
- **A dead engine's smoke is lighter than it "should" be**, because the thing
  it has to be seen against is asphalt. Dark grey against dark grey is nothing.
- **Photographing smoke needs the render loop stopped.** A puff lives about a
  second and a SwiftShader frame *is* a second or three, so a screenshot taken
  with the loop running catches an empty pool - which says nothing about how it
  looks at 60 fps. `check_effects` pauses, spawns, draws one frame by hand and
  shoots that.
- Low quality halves the pool *and* the rate: it is the setting for a phone
  that is already working, and smoke is the first thing that should give way.

## The crowd

People in the grandstands, measured off the model by `tools/extract_crowd.mjs`
and drawn by `src/crowd.js` as one `THREE.Points` - one draw call for a
stadium, two triangles each, and a shader that sways them from the clock so
the per-frame cost is one uniform. They are only ever seen from tens of metres
away through a catch fence.

- **Where they sit is raycast, not guessed.** A band placed by eye in track
  space puts a crowd in mid-air on one circuit and inside the concrete on
  another - the same reason the racing line and the pit road are measured.
- **Fire the ray from the sky and take *every* hit.** A stand has a roof, and
  a downward ray finds it first. Starting the ray under the roof does not work
  either, because the roofs are at different heights round the lap: the first
  attempt found seating along one straight and nowhere else. From above, a
  stand is roof, then seats, then ground - so collect the lot and keep the
  upward-facing surfaces that are clearly above the road.
- **The top of a retaining wall is a level surface a few metres above the
  road**, right beside the circuit, and it collected a tidy row of spectators
  perched over the racing line. `OUT_FROM` and `FLOOR` are what keep them off
  it - and Yoyleland needs its own figures entirely (`crowdScan` in
  `tracks.json`), because its seating is a bare concrete bowl a long way out
  and well up, not a tiered stand.
- **Keep every qualifying tier, not the lowest.** One row per column gave a
  crowd that was all front row with an empty bowl behind it.
- `check_effects` asserts none of them is within two metres of the corridor or
  at road level, which is what "measured onto the wrong thing" looks like in
  numbers, and then photographs the stands.

## Pictures of the cars

The picker draws each car from **the model that is already loaded**, in
`src/thumbs.js` - no images ship, which is the same rule the sky, the smoke and
the crowd follow. Every car is in memory before the menu appears, so a portrait
costs one small draw and nothing on the wire.

- **Each car is drawn where it stands.** Lifting one into a scratch scene is
  the obvious approach and it is the skinning trap: McQueen binds to the world
  matrix he had at load. So the scene is left alone, everything else in it is
  hidden for a single frame, and a throwaway camera is pointed at the car.
  What was visible goes back - and *what was hidden stays hidden*, or the idle
  camera ends up looking at eighteen cars in a heap on the start line.
- **Front three-quarter.** These characters have their eyes on the windscreen,
  so a rear view is unidentifiable at 132x84: the face and the nose are what
  say which car it is.
- **A few per frame.** Eighteen renders in one go is a hitch you can feel, and
  a card without its picture yet is still a perfectly good button. The card
  reserves the space either way, or the list reflows as they arrive.

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
- **All twenty cars are on show, including the two that never race.** Guido and
  Mack carry `"racer": false` in `cars.json`, which keeps them off the grid and
  out of the car picker; the showroom is for looking at cars, and they are
  cars. Everything that builds a field uses `racerSpecs`, and the headless sim
  tools filter the same way — a grid with an artic on it is not the race any of
  them assert anything about.
- A wide flat plinth lit from a sharp angle is the classic recipe for shadow
  acne - it showed as radial banding following the cylinder's triangulation,
  and wants a much bigger `normalBias` than the outdoor sun does.
- **... and when the banding came back, it was not the shadows.** The floor is
  a 64-segment disc at y = 0 and the plinth's top face sits *flush* at y = 0,
  so the two fought over the same depth - which draws as bright and dark
  wedges radiating from the centre, following the triangulation exactly like
  acne does, and crawls as the camera moves. It reads as the plinth having the
  wrong material. The floor sits at the plinth's base now. Worth remembering
  the shape of this one: two explanations predict the same picture, and the
  cheap test is to move one surface rather than to tune the shadow.
- **A metallic surface with nothing to reflect is not a material.** The plinth
  was `metalness: 0.35` in a room with no environment map, so it had nothing to
  be metallic *with*: it went dark and lit only through specular highlights
  that swam about as the turntable turned. Matte, and it behaves.

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
- **... and the map is *measured*, not shared out in proportion.** `mapOnto`
  projects every station onto the circuit once, at load, and `lapAt`
  interpolates that. In proportion the two disagree by several metres inside
  the tapers, which puts a car's place in the race a few metres from where the
  car can be seen to be - so a rival could be passed on the road and still be
  ahead on the timing screen. The table is forced to increase (a station
  projecting behind its neighbour would show as a car going backwards) and
  rescaled to span exactly `lapSpan`, which is what keeps the lane worth
  neither more nor less than the arc. `check_pits` asserts the two agree to
  within a metre for every car, all race.
- **Entry and exit are handovers, not teleports - so ask the geometry where
  the car is.** The ribbon's ends taper onto the racing line, so the two
  overlap in space wherever a handover is allowed; `check_pits` asserts that
  overlap is under a car's length. What it does *not* give you is a
  correspondence between the two distance coordinates: a chord and an arc at
  the same fraction of their length are tens of metres apart on the ground.
  Handing over by proportion moved a rival **46 m in one frame** at
  Yoyleland's entry, and dropped every car 5 m sideways at the exit.
  `Track.project` finds the station the car is actually at; `rejoinAt` waits
  for the first place the projection lands inside the circuit's own corridor,
  which also covers Yoyleland, where that corridor pinches at the very last
  station of the ribbon.
- **`psi` is measured from *this* ribbon's tangent, so carrying the number
  across turns the car on the spot.** The two meet at 4 degrees at Motor
  Speedway and 20 at Yoyleland, and 20 degrees in one frame at pit-exit speed
  is exactly the shake the owner reported on rejoining. `Car.useRoad` converts
  it, preserving the *world* heading - the car rejoins pointing across the
  road, which is what a pit exit looks like, and steers straight. The guest
  applies the host's `psi` **after** the handover for the same reason, or it
  is turned twice.
- **A car has to start moving over long before the entrance.** `laneSteer`
  asks for a crossing *rate*, and at Yoyleland the pit entry is thirteen
  metres in from the racing line - four and a half seconds of crossing, 320 m
  at racing speed. Aiming only once inside the entry window had four of six
  rivals arrive still out on the line, unable to turn in, driving the last
  laps of a race on dead tyres wanting a stop they could never take.
  `PIT_APPROACH` is that distance and it is sized by the widest circuit.
- **Anything measured forward of the entry must use `track.delta`.** These pit
  roads run *through* the start/finish - Yoyleland's enters at s = 2394 of a
  2817 m lap - so subtracting raw `s` values goes negative the moment the car
  crosses the line and drops it back to the pit entry mid-lane.
- **A pit ribbon needs the same smoothing a circuit gets, and then some.**
  Its offsets come from a 0.5 m raycast scan, and fed straight into a
  centreline they were 2.2 degrees of yaw per station with peaks over 30 -
  against a ride-quality bar of 0.1 - which is a car that visibly shakes the
  whole way down the lane. Three passes, and *what* is filtered matters:
  - Smooth the **band offsets** before building anything from them.
  - Smooth the ribbon's **lateral offset**, never its world x/z. A filter on
    world positions cuts corners, the only corner is the entry taper, and that
    is exactly where the ribbon has to stay on the road - it took Palm Mile's
    taper through 170 samples of apron.
  - Smooth the **tangents separately** from the positions, and renormalise.
    Where a car sits and which way it points are different requirements: one
    has to be on the asphalt, the other has to be smooth. Filtering them
    together fails both. Apart, they disagree by a fraction of a degree, which
    on a 4.4 m car is invisible.
  - Do **not** pin the ends to their raw values. It kinks the last segment -
    21 degrees in one station at the pit exit - and buys nothing, because the
    end only has to overlap the racing line and `check_pits` allows six metres
    for that.
- **Leaving is *driving* out, which means aiming at a lane that lands on the
  road.** The ribbon does not end on the racing line, it ends near it: Motor
  Speedway's last station projects to lap n = -4.60 against a corridor edge at
  -4.89, so a car anywhere on the pit-wall side of the lane has nowhere legal
  to be handed over to and gets *put* on the road rather than driving onto it.
  The run out therefore aims at `exitN` - measured once from the geometry, the
  offset whose projection sits `EXIT_MARGIN` inside the corridor - and holds it
  firmly, because whatever lateral error is left when the ribbon runs out is
  exactly the size of the jump. That took the exit from 2.1 m on a third of all
  stops to 0.03 m on most and 0.8 m at worst.
- **Turning *in* is a different problem and is not solved.** Yoyleland's entry
  taper is 1.2 m wide and the two roads are further apart than that where they
  meet, so a car diving in at 240 km/h is clamped into the ribbon and moves
  about 1.5 m doing it. That is the data, not the handover; `check_pits`
  measures it separately from everything else so the two cannot hide each
  other.
- **Stop by braking on the distance remaining**, `sqrt(2·a·left)`, so the car
  arrives at rest on the mark. "Close enough, then brake" left it up to 3.5 m
  short of a painted rectangle you can see; the curve puts it within 2 cm.
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
- **A person may pit whenever they like; `shouldPit` is the AI's.** Gating a
  human on tyre wear made the pit entrance ignore them for most of a race,
  which is not a decision, it is a locked door. Coming in early is allowed to
  be a bad idea.
- **... but turning in means *asking*, never merely being near the edge.** On
  Easy the aid parks the car on the low line, so a proximity test pitted a
  five-year-old every single lap without them touching anything, and Easy
  stopped being a win - P1 to P7 at Motor Speedway. The test is
  `car.steerCmd < -0.2`, or the aid deciding for them.
- **The guest handles the pits *before* its hard-reset test.** That test
  measures `track.delta(car.s, truth.s)`, and on the pit ribbon `s` is a
  distance down a different road - so the moment either end is in the pits it
  compares two coordinate systems, decides the guest is 300 m out, and "fixes"
  it by writing a pit distance onto a car still on the circuit. `check_netplay`
  measures drift in the *world* for the same reason, and the corridor check
  asks `car.road`, or every car reads as off the road for the length of a
  stop.
- **The chase camera follows `car.road`.** Anchored on the circuit while the
  car is in the pits it sits eighty metres away pointing down an empty
  straight, and the car is simply not in shot. `separate`, `room`,
  `clampLateral` and `coolDown` are road-aware for the same reason - two cars
  at the same lap position on different ribbons are seventy metres apart.
- **`arcScale` is clamped.** The expression is singular at `n·κ = -1`. An oval
  never gets near it, but the entry taper sweeps across the infield in a short
  distance and there a car three metres off the ribbon advanced *five metres
  of lap in one 1/120 s step*.
- **Worn tyres lose grip**, fading to `0.75` through the same multiplier as
  `car.assist` so it reaches all three models through the one function they
  share and can introduce no discontinuity. Under Arcade the car still cannot
  spin: a five-year-old on worn tyres is slower and never in trouble.
- **... and grip alone is not a cost, because grip is not what sets the pace
  here.** Arcade has no tyre forces in it at all, so `tyreGrip` reaches
  *nothing* under the default model and a dead set cost exactly zero - which
  makes a stop pure loss and hands the race to whoever skips it. That is the
  whole strategy inverted, and it is what the owner hit: they pitted from the
  lead, Mater never came in, Mater won. The same hole exists at Yoyleland
  under every model, because a superspeedway never asks the tyres for a
  corner. So worn tyres also cost top speed - `tyreSpeed`, applied in
  `Car.step`'s rev limiter, which every model already shares, so no handling
  model changes and the rule still reads "worn tyres only ever make a car
  slower".
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
- **A pit road has ends, so `delta` is a subtraction.** `PitRoad` inherits
  `Track.delta`, which wraps its answer into half a lap *through `wrap`* - and
  `wrap` here clamps. So `delta(458, 215)` came back as **0**: every car behind
  another read as being in exactly the same place. `Race.separate` reads this,
  so sixteen cars strung down a 500 m lane were all treated as touching, shoved
  sideways into each other and charged the contact penalty until the queue was
  crawling sideways at walking pace with the player in it. One missing override,
  and it is the single worst bug this feature has had.
- **The contact speed penalty is charged once per car, not once per pair.**
  A car in a queue is behind several others at once, and 0.6 per second each
  compounded to 97% of its speed gone in a second. `separate` records the
  harshest contact per car and applies it after the pair loop.
- **The entry rules are what decide whether the field gets in, and they cost
  four attempts to get right.** Refusing entry unless the lane ahead was clear
  by `speed x 1.2` - the room to stop in from *racing* speed - meant two or
  three cars a lap got in and the other fifteen drove round and asked again,
  lap after lap. That is the owner's report, and it was mine: the gate was
  written when cars still arrived at the entrance flat out.
  - **Brake on the approach instead** (`Race.aimForPits` sets `car.pitCap`).
    Eighteen cars strung over two hundred metres at 250 km/h become eighteen
    cars in sixty-five metres of pit lane at the limit, and no queueing *inside* the
    lane can undo a threefold compression that has already happened.
  - **The entry window is per car**, because it depends on where that car's box
    is. One window has to be short enough for whoever stops first, and a window
    is a *place*: it admits however many cars can drive through it, which at a
    safe following distance was eight of eighteen.
  - **`ENTRY_CLEAR` is the following distance the queue then holds**, not more.
    Below it a car joins already too close and closes the rest itself; well
    above it, everybody waits a lap.
  - What that buys: thirteen to eighteen of eighteen turn in *on the same
    lap*, and any that are left on the next. `check_pits` asserts it, because
    the failure was invisible in every other number - the race finished,
    everybody stopped, nothing overlapped. (It was nine to thirteen until the
    queue stopped crawling: a lane that runs at its limit clears faster, so
    more of the field fits through the same window.)
- **A brush is the price of letting the field in.** The 0.1 m overlap bar was
  met by turning almost everybody away at the entrance. It is 1.3 m now, and
  that is the right way round.
- **A pit lane is a queue, and nothing in it knew that.** The AI's "do not
  drive through the back of anybody" lives in `ai.js`, and a car in the lane
  never reaches it - the state machine takes the controls and returns first. So
  every car aimed at the speed limit regardless of what was in front.
  `queueSpeed` brakes on the gap, and on a *firmer* figure than the stop uses:
  `STOP_DECEL` places a car gently on a painted rectangle, which is a different
  job from not hitting the one in front.
- **... and the car in front of you is usually *moving*.** The first version of
  `queueSpeed` asked "how fast could I be going and still stop in this gap",
  which is the right question about a parked car and the wrong one about a
  queue: to run at the limit a car needed a 47 m gap, in a lane 500 m long, so
  eighteen cars in it crawled at a third of the limit for the whole stop. That
  is the owner's "when going in pits all cars drives really slow". The leader's
  own speed goes into the sum - the standard following rule - and when the
  leader really is stopped it degenerates to exactly the old formula. Evaluate
  it for *every* car ahead and take the lowest, not for the nearest: a stopped
  car thirty metres up binds harder than a moving one at ten.
- **A cap that is written in a branch must be cleared in one that always
  runs.** `car.pitCap` is the AI's pit-approach speed limit, read by
  `Driver.update` every step and written only by `Race.aimForPits` - which was
  only *called* while a car wanted to come in. So the last value it wrote
  stood: a rival that had pitted has `tyre = 1`, `shouldPit` goes false,
  nothing clears the cap, and it aims at 22 m/s - the pit limit of the day -
  of a possible 87, from its stop to the flag. Eighteen of them. The race still finished, everybody still got
  served, nothing left the road - **not one existing assertion moved.**
  `aimForPits` now takes a `want` flag and is called unconditionally, the way
  `concede` always was, and `PitLane.leave` clears the cap beside
  `pit = Pit.OUT`. If you add another per-car cap, give it the same shape.
- **Release it on the car's *own* entry window.** `pits.entryWindow` is the
  widest window anybody has - it is for sizing the approach - while whether a
  given car may still turn in is `windowFor(car.gridIndex)`, a third of it for
  the first box: 105 m against 354 m at Motor Speedway, 209 against 635 at
  Yoyleland. Releasing on the wide one left a car that could no longer possibly
  pit driving at the pit limit on the racing line for another quarter of a lap.
  Ask `canEnter`, which is the rule itself.
- **The limit is 30 m/s, and it is not a realism figure.** Real pit road is
  about 22, and at 22 a stop cost 33 s at Motor Speedway and 47 s at Yoyleland,
  whose lane is 816 m long - most of a racing lap at walking pace, for a
  five-year-old. 30 m/s with `STOP_DECEL` at 4.5 makes it 26 s and 37 s. The
  two go together: at 2.6 m/s^2 a car needs 173 m to stop from 30, and Motor
  Speedway's first box is 150 m down the lane, so the whole benefit went into a
  longer braking zone instead of the clock. `pitSpeed` in `tracks.json`
  overrides it per circuit; nothing needs one today.
- **Turning in used to need room to *stop* in, and that rule is gone.** The
  reasoning was sound while cars arrived at the entrance flat out: a lane with
  a stationary queue thirty metres in is a collision however hard you then
  brake, so `tryEnter` refused unless the car's own stopping distance was
  clear. It is what turned fifteen of eighteen away every lap. They are braked
  on the approach now (`Race.aimForPits`), so they arrive at the pit limit and
  the gate is a following distance - `ENTRY_CLEAR`, a flat nine metres. There
  is no `ENTRY_SECONDS`; if you find one in a comment it predates this.
- **"It has stopped" is not "it has arrived".** The anti-deadlock rule that
  services a car which cannot creep the last metre onto its mark also serviced
  one the queue had halted a hundred metres short - frozen mid-road with the
  whole lane behind it. It is bounded by `BOX_STALL` now.
- **The whole field pitting on one lap is a test, not a hypothetical.** It is
  what the owner hit. `check_pits` forces it on every circuit and asserts no
  two cars ever occupy the same place, everybody still gets served, and the
  player is never stuck. `car.pitAt` also scatters the AI's threshold, because
  a field that all wears at one rate all comes in on one lap.
- **The pit lane has a through-lane, and it is not the row of boxes.** The
  boxes are against the wall, so aiming at one from the entry drives the whole
  length of the pits over every other car's box - which is where a rival being
  serviced is parked. Cars run the outer side and peel in over the last 26 m;
  `PEEL` is that distance, and it has to be long enough to cross the lane
  while still rolling, because `laneSteer` asks for a crossing *rate* and a
  stopped car cannot steer.
- **Guido is a vehicle, not a point.** Clearing the bodywork by his standoff
  keeps his *centre* outside the car and swings his nose straight through it
  at every corner of the route - which is what it looked like, and why a
  clearance test written against his centre passed while he was visibly
  clipping. The ring is offset by the standoff **plus his own radius**, and
  the test measures against his footprint. That is also why `STANDOFF` is only
  0.30 m: it is the gap you *see*, on top of a radius that is already there,
  and at 0.85 he looked like he was doing the job from the next parking space.
- **Guido drives round a ring, not from wheel to wheel.** Straight lines
  between corners go through the car. The route is built on a rectangle
  enclosing the bodywork: every waypoint sits on its perimeter, every move
  follows that perimeter and turns its corners, and he joins and leaves at the
  point nearest his spot. A ring is convex and contains the car, so a path
  that stays on it cannot enter the car - bridging only the changes of *side*
  still clipped a rear corner on the way home.
- **Wrap those angles into [0, 2π), do not just force them positive.** A ring
  corner one whole turn "ahead" reads as 6.65 rad against a span of 2.31 and is
  skipped, which put a leg straight across the back of the car.
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

## Landscape, and giving the phone back

Turning the phone sideways asks for fullscreen *and* locks the orientation, so
a player who wants their phone back has to undo both. Back is the button they
reach for, and by default it leaves the site and throws the race away.

- **The Back gesture is borrowed with a history entry**, pushed by `guardBack`
  on the way into fullscreen and popped instead of navigating. There is nothing
  else to go back to in a single-page game, so that entry can only ever mean
  "let go of the screen": `dropFullscreen` unlocks the orientation, exits
  fullscreen and **pauses** - a race left running is a car driving into a wall
  while its driver reads a message.
- **Spend the entry if fullscreen ends some other way**, or the next Back is
  swallowed doing nothing. `history.state?.mcqueen` is how it knows the entry
  on top is the one it pushed and not somebody else's.
- **RESUME takes the screen back.** Leaving fullscreen sets `offer = false` in
  `watchOrientation` - deliberately, so dismissing the panel does not nag -
  which means nothing would ask again until the phone is turned twice. A tap
  on RESUME is a user gesture, so unlike a rotation it is allowed to succeed.
- **Phones only, and `isPhone()` is the one test for it.** Every browser tool
  in `tools/` drives a desktop viewport; a page that borrows history entries
  under a test is a page one of them will eventually navigate away from
  mid-race. Same guard the rotate overlay already used.

## The lobby

**MULTIPLAYER** on the main menu, then HOST or JOIN. Up to **four people**
share a grid; `src/net/lobby.js` is the whole of it and `check_lobby.mjs`
drives it in one process.

- **A browser cannot scan a local network.** No mDNS, no UDP, no sockets, and
  this is a static site with no server behind it. The owner asked for JOIN to
  *find* the games, so rooms are **eight numbered slots on the broker**: a host
  takes the first free one, and JOIN knocks on all eight and lists whoever
  answers. It behaves like discovery and needs nothing running - but it is the
  public broker, so it needs internet rather than only wifi, and the slots are
  global. The room number is on screen for exactly that reason.
- **Probing is joining.** A free slot rejects a connection at once; a held one
  opens, and the host greets every new connection with its lobby *before*
  deciding whether to seat it. So the advert a room shows in the list is the
  lobby state, there is no second protocol for browsing, and the connection to
  the room you pick is the one you play on.
- **A PeerJS `error` is not a failure, and taking it for one broke JOIN
  entirely.** `peer-unavailable` - nobody is holding that id - is how a *free
  slot* answers, and PeerJS raises it through `emitError`, which only emits;
  the fatal path is `_abort`. `openPeer` bound a handler that destroyed the
  peer and never unbound it once the peer was open, so a guest knocking on
  eight rooms destroyed its own peer on the first empty one and took the probe
  of the live room down with it. The broker says "nobody there" in one round
  trip while a real host needs a whole ICE handshake, so the empty slots always
  answered first: **no games found, every time, with a host sitting right
  there.** Unbind on settle; treat `peer-unavailable` as data.
- **A free slot answers on the *peer*, not on the connection.** There is no
  `conn.on('error')` for "that id does not exist", which is why the empty slots
  used to sit out the full probe timeout. The id is named in the message
  (`Could not connect to peer mcqueen-speedway-room-3`), and that is the only
  way to tell which probe just failed. If it cannot be read, give up on
  *nothing* and let the per-probe timeout do it - cancelling them all is the
  original bug wearing a hat.
- **A room that accepts a connection is a live room, advert or no advert.** The
  lobby channel is `reliable: false`, because it becomes the race link, so
  hanging the listing on one packet arriving is a game that intermittently
  cannot be found. `ADVERT_GRACE` waits a moment for the lobby message and then
  lists the room without it; `roomRow` already draws a nameless room.
- **`check_rooms.mjs` is the only test of any of this.** `check_lobby` drives
  fake links and `check_twoplayer` loopback, and both start *after* a
  connection exists - so every line of `net/peer.js` was unexercised, and it
  shipped broken. It fakes PeerJS closely enough to matter: errors land on the
  peer, `peer-unavailable` is non-fatal, and a live room answers slower than a
  dead one. It still says nothing about the real broker.
- **The host owns the lobby exactly as it owns the race.** Guests send intents
  - pick this car, I am ready - and draw whatever the last `MSG.LOBBY` said.
  Asking for a car somebody has taken is *refused*, and the refusal arrives as
  the next broadcast rather than as an error a guest has to handle.
- **`MSG.START` carries the field, not just the settings.** With an AI count
  the grid is no longer every car, so "both devices lay out the same grid"
  needs the *list* to travel - otherwise two phones pick two different sets of
  AI and the race differs from the lights out.
- **Changing anything un-readies everybody.** Agreeing to a race and then being
  taken to a different circuit is the same class of surprise as the grid
  disagreeing, and it is cheaper to prevent than to explain.
- **`onGuest` is a callback, not a promise.** One line, and it is the whole
  difference between two players and four: the old transport resolved
  `waitForGuest` on the first connection and dropped every later one.
- **A short field is now possible** - the host can ask for two cars - and
  nothing had raced fewer than seven since the grid work. `check_lobby` runs a
  two-car and a four-car race on every circuit for that reason.
- Loopback addresses every message (`{to, from, msg}`) so three tabs can share
  one BroadcastChannel; `fake.js` needs nothing, since a test makes one link
  per guest.

## Up to four players, four devices

START is still single-player and unchanged. Everything below is what happens
once the lobby above has sent `MSG.START`.

`src/net.js` is the protocol, `src/net/guest.js` the guest's view, and there
are three transports behind one `send` / `onMessage` / `close` interface:
`peer.js` (WebRTC through PeerJS's free broker), `loopback.js`
(BroadcastChannel between several tabs, reached with `?net=loopback`) and
`fake.js` (in-process, with latency and loss you choose).
The host runs the real `Race` and owns the result; each guest sends buttons at
30 Hz and gets snapshots at 20 Hz. Everything talks through `send` /
`onMessage` / `close` and nothing else, which is what lets the whole stack be
tested headlessly - see `tools/check_netplay.mjs` and `tools/check_lobby.mjs`.

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
- **The newest packet is authoritative about which *road* a car is on.** The
  guest only moved a rival between ribbons when it could see the change happen
  in the pair it was interpolating - `a.onPit !== b.onPit`. Lose the packet
  where it flips and both snapshots read "on the circuit" while that copy of
  the car is still on the pit ribbon, so its lap position is read as a pit
  distance for the rest of the race: a guest drew a car off the road seventeen
  hundred times on a 5% loss link. Take the newest packet's word every time,
  not only when it changes.
- **Extrapolation past the newest snapshot is clamped to the corridor.**
  Running on is what stops a dropped packet freezing the field, but on a lossy
  link the gaps get long enough to draw a car through the wall.
- **PeerJS is vendored as the UMD build, and loaded on demand.** `bundler.mjs`
  has bare imports only a bundler can resolve; the UMD file is self-contained
  and sets `window.Peer`. It is injected as a `<script>` the first time
  somebody chooses multiplayer, so a single-player session never downloads the
  93 KB.
- **The heartbeat runs on a wall clock, not on frames.** Sending from the
  render loop ties "am I still here" to the frame rate, so a phone struggling
  with a full grid looks exactly like a phone that has been switched off: with
  eighteen cars, two tabs under a software renderer each dropped the other
  mid-race and neither had gone anywhere. `startPump` is a `setInterval`, and
  the drop check sits on it too - in the loop it was as late as the frame rate,
  on the device least able to afford the delay. `DROP_AFTER` went 5 -> 12 s for
  the same reason: five seconds is fine for "gone" and far too tight for
  "having a hard time".
- **The silence clock starts when the pump does, not when the lobby last heard
  from somebody.** A guest says nothing at all between pressing READY and its
  own first input packet, and it cannot send that until it has built the race
  and - on a circuit it did not already have - downloaded and parsed the track.
  That is easily longer than `DROP_AFTER` on a phone, so the host evicted both
  players the instant `startPump` began and handed their cars to the AI before
  the lights went out. `check_twoplayer` caught it as "host with one human,
  guests never started"; on real devices it would look like the other person
  simply never arriving.
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
- **A panel that must be gone for every race is closed in `startRace`, not by
  whoever started it.** `hostStartRace` hid the lobby on its way past, so the
  host was always fine; a guest reaches the race through `beginJoined` and
  nothing closed it at all, so it raced with the lobby sitting over the screen.
  That is the same shape as the pit speed cap: state that has to be true of
  every race belongs in the one function every route goes through. The host's
  own early hide stays, because it answers the tap before the circuit has
  finished loading - and the guest deliberately keeps the panel up until then
  to show "Loading the circuit…".
- **`check_twoplayer` was already collecting `lobbyHidden` and never asserting
  it** - only printing it in the timeout diagnostic. That is exactly why this
  shipped. It is checked on every tab now.
- **`.hint` carries connection status as well as the options blurb.** The
  short-screen rule that hides it is scoped to `#options` for that reason -
  unscoped, the host sees a dead panel instead of "waiting for the other
  player" or an error.
- **The guest interpolates on the *host's* clock, one snapshot behind, and
  every part of that sentence was wrong once.** Playback used to be anchored on
  the arrival time of the newest packet, so `t` was already 1 the instant it
  landed: every frame after that extrapolated, hit the cap, froze, and jumped
  when the next arrived. On the host - which is authoritative and never
  interpolates - it looked perfect, so this only ever showed on the other
  phone, which is exactly how it was reported. Measured as the frame-to-frame
  change in a rival's step: **45 cm before, 0.1 cm after.**
  - **One interval of delay, not two.** Only `prev` and `next` are kept, so the
    buffer *is* one interval; ask for more and playback falls off the back of
    it and freezes. Deeper jitter tolerance needs a deeper history, which is
    not built.
  - **The timeline is `msg.c`, accumulated.** Arrival times jitter, so
    interpolating over them varies the replay rate packet by packet. The
    snapshot *number* is perfectly smooth and wrong: it assumes the host sends
    exactly every 1/SNAPSHOT_HZ, and it does not - `startPump` is a
    `setInterval`, and even a fixed-step test loop lands on 7 frames of 1/120
    rather than 6, because 6/120 is a hair under 1/20. That is a 14% error in
    the replay rate, worse than the fault being fixed. The race clock measures
    what actually elapsed - but it is **reset to zero when the lights go
    green**, so it is accumulated into a monotonic timeline rather than used
    raw, and a backwards step is charged one nominal interval.
  - **The rate is trimmed, the position never is.** The error is measured only
    when a packet arrives, because that is the one instant its right value is
    known - playback should be on the older of the two snapshots, about to
    traverse to the newer. Measuring every frame chases a target that jumps
    once per packet, and the filter lagged half a cycle: `t` ran -0.44..0.42
    instead of 0..1, froze the car for three frames of every six and jumped it
    1.8 m.
  - **Run-on past the newest packet is capped in time, not as a fraction of
    the span.** As a fraction it grew with the gap, so the more a link lost the
    further a car was thrown and the bigger the snap back. One interval of
    run-on costs the same few metres however bad the link gets: mean stutter at
    1% loss went 13 cm to 3 cm.
  - **A packet older than the newest applied is dropped**, on the sequence
    number `n` and never on `c` - see the reset above. Jitter reorders packets,
    and taking one at face value winds the timeline backwards.
- **`car.pit` is on the wire, not just `car.onPit`.** Guido is started by
  `player.pit === 'service'`, so with only "in the pits or not" travelling, a
  guest's own car never reached that state and the crew came out on the host's
  screen and never on theirs.
- **The HUD's lap total is `race.totalLaps`, never `settings.laps`.**
  `hud.update` *clamps* the lap it displays to the total it is handed, so a
  guest whose own OPTIONS said 5 while the host chose 10 watched its counter
  stop at 5 and stay there. Same rule as everything else here: nothing in a
  networked race may read a local setting. `resumeRace` is guarded for the same
  reason - a guest that paused and resumed used to re-cut the race to its own
  lap count.
- **Multiplayer defaults to no driver aid.** `help` is the aid on a *human's*
  car and on Easy it steers, brakes and overtakes for you - right for a
  five-year-old racing the AI, and indistinguishable from "my car is driving
  itself" when two people are racing. The lobby control still offers Lots for a
  race against a child.
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

Two more passes write into the same file afterwards, and both raycast the
*shipped* asset rather than the raw one, so they go last:

```
node tools/extract_pits.mjs <id>        # the pit road, as a second ribbon
node tools/extract_crowd.mjs <id>       # where the spectators sit
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
- **Cars are solid, and until recently they were not.** `separate` only ever
  resolved contact *sideways*: drive into the back of somebody and the lateral
  overlap is at its maximum, so the code squirted the pair apart across the
  road and let the one behind carry straight on. Nothing anywhere stopped two
  cars sharing a place along the road. What hid it for so long was the speed
  penalty - at 40% of your speed per second you stopped dead behind anyone you
  touched and never noticed the wall was missing - and softening that to a
  fifth took the cover off, which is how the owner found it.
  - **Resolve along the axis of least penetration, measured as a *fraction* of
    each dimension.** A car is twice as long as it is wide, so raw depths are
    not comparable: a car sitting squarely behind another has the full 2.3 m of
    lateral overlap and resolves sideways however close it gets, sliding past
    the corner of the car in front. That was the first attempt and it still let
    cars through.
  - **The shunt kills closing speed in the instant it happens.** The positional
    push is capped at `SEPARATE_RATE`, 2 cm a step, while a car closing at
    32 m/s covers 27 cm a step - the shove can never out-run the closing on its
    own. Easing the speed down over 0.15 s is no better: at that rate 0.15 s is
    four and a half metres, the whole car. Kill the closing at once and the
    gentle shove has all the time it needs.
  - **`CREEP_BY` is what keeps a race finishing.** A wreck is immovable and
    doing nothing, so clamping to its speed exactly stops dead every car that
    reaches it, and on a circuit where the AI holds its lane that is the entire
    field queued behind one parked car for ever. `check_crashes` found it
    immediately: not one car finished. A walking-pace floor lets a driver pick
    its way past something stationary, and still nothing can be driven through
    at speed.
  - **The aid gave up on overtaking at exactly the wrong moment.** `blockedBy`
    asks "am I catching that car", and the collision clamps you to its speed -
    so the answer became "no" the instant you arrived behind somebody, and the
    aid stopped trying to pass precisely when passing became the only way
    through. A car you are already touching blocks you whatever the
    speedometer says.
  - **Two assertions were scoped rather than fixed, and that is a judgement
    worth knowing.** With solid cars, Arcade's field runs as one train - it has
    no grip limit, so everybody corners flat out and three laps finish inside
    two seconds - and there is no way through a queue where everyone is going
    the same speed. So the "the full aid wins" rule in `simulate.mjs` and the
    "Easy takes no places back" rule in `check_racing.mjs` now apply to
    **Sport**, which is the model this is actually played on and where both
    still hold. Pro was already exempt: `driverAid` returns immediately under
    it, so its "aided" player has no aid at all. The alternative was to make
    cars passable again, which is the bug this started from.
- **A car that goes off and rejoins must not appear to teleport - and the fix
  is in the *drawing*, not the physics.** Yoyleland's inside corridor has
  twenty notches around the lap: the width drops by up to 6.4 m for exactly
  nine stations and then returns, which is the barrier walk finding something
  at bumper height rather than the road changing. `Car.step` keeps a car inside
  by *setting* `n` to the edge, so ride the apron into a notch and the car is
  moved six metres sideways between two frames. Measured: 1.63 m in a single
  frame, 26 times in one lap.
  - **Two physics fixes were tried and both broke the pit stops**, which is
    the thing to know before trying a third. Tapering the corridor so it cannot
    narrow faster than 0.15 m a station removed the jump completely and cost
    0.24 m of average width - and that was enough to move the inside line away
    from the pit ribbon, so `project` landed outside the pit road and **not one
    car could pit**. Rationing the clamp instead left cars up to 3.16 m outside
    the corridor for 0.2 s, and the handover then moved them 5 m. The corridor
    being exact at the end of every step is load-bearing: the pit handover
    projects between two ribbons against it, the grid is laid out against it,
    contact resolves against it.
  - **So the simulation is untouched and only the model lags.** `sync` already
    writes two things - `car.position`, which contact, the pit projections and
    every test read, and the model's transform, which is what a person sees. A
    clamp correction bigger than the car could have made itself is the corridor
    moving rather than the car, so that amount is carried as `visN` and decays
    over about a third of a second. The car is still clamped exactly; it just
    does not snap on screen. Model movement over a lap of the apron went from
    1.63 m in a frame to 0.06 m of sideways in a frame, and every check that
    measures the physics reads exactly what it read before.
  - The notches are bad extraction data - the same defect behind Yoyleland's
    10 barriers and 20 holes in `check_barriers`. Re-deriving that corridor is
    the real cure and is a separate job; this makes the game handle it.
- **A touch must not end somebody's race.** Contact bled 35-40% of a car's
  speed *per second* and shoved it sideways at 6 m/s, which on an oval - where
  the whole point is running side by side - made close racing something to
  avoid. From the cockpit it read as the car braking and steering by itself
  whenever anyone came near, and that is how it was reported. `CONTACT_BITE`
  scales the penalty to a fifth of that: a brush is a nudge, a rub costs a few
  km/h, and the shape is unchanged so a deeper overlap still costs more.
  - **The shove came down by less, and the numbers say why.** It is what stops
    two cars occupying the same place. Worst overlap over a full race: 1.58 m
    at the old rate of 6, 1.61 m at 2.4, and **2.28 m at 1.2** - which is two
    cars two centimetres apart. Anything from about 2.4 up behaves the same;
    below that it falls off a cliff.
- **Contact between cars is charged per second, not per step - and that goes
  for the *shove* as well as the speed penalty.** `separate()` runs at 120 Hz;
  unscaled, its speed penalty took 14 m/s off a car in half a second of light
  touching, so brushing a rival read as a crash. The lateral correction had
  never had the same treatment: resolving the whole overlap every step is a
  sideways velocity of hundreds of metres a second, and a car between two
  others gets it twice. On the circuit it was invisible; in a pit lane with
  eighteen cars in a corridor a couple of metres wide it threw them four and
  five metres sideways in a single frame and then threw them back, thousands
  of steps a race. It reads exactly like the exit snapping the car onto the
  racing line, which is how it was reported. `SEPARATE_RATE` is metres per
  second.
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
node tools/check_effects.mjs       # clouds, crowd, tyre smoke, a wreck cooking
node tools/check_museum.mjs        # every car on the plinth, and the race after
node tools/check_crashes.mjs       # rivals have incidents, and they are safe
node tools/shots_crash.mjs <track> # ... and a picture of one at the roadside
node tools/check_pits.mjs          # pit roads on asphalt, and a stop end to end
node tools/shots_pits.mjs <track>  # ... and a picture of Guido doing it
node tools/check_fullscreen.mjs    # landscape, the tap fallback, and Back
node tools/check_netplay.mjs       # a host and two guests agree, at four latencies
node tools/check_lobby.mjs         # four in a lobby, in one process
node tools/check_rooms.mjs         # can JOIN actually find a hosted room?
node tools/check_twoplayer.mjs     # three real tabs through the real menus
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

- `simulate.mjs all` — 30 OK: every handling model x circuit x AI tuning, plus
  a two-player grid on each circuit. **It still races Arcade and the two easier
  tunings although neither can be selected**, and that is deliberate: they are
  the controls that say whether a change is in the handling or in the racing.
  The full aid is P1 on all three **Sport** circuits, and if that stops being
  true it is a regression regardless of what else improved - it is the same
  code the multiplayer HELP setting reaches. Arcade and Pro are exempt and the
  reasons differ: Pro has no aid at all, and Arcade's field is one train that
  solid cars cannot be passed through. Worst heading seen
  anywhere is 81° with every car still finishing; the run asserts nothing
  exceeds 172°, which is where `maxPsi` would be holding it.
- `check_wheels.mjs` — the expected count on all twenty models (four for the
  racers, three for Guido, ten for Mack), two steered wheels each, every one
  turning 90° for a quarter turn the same way. Read the *radii* in its output
  as well as the pass: it drives every wheel at one road speed, so a wheel
  whose radius is wrong reports a quarter turn that is not 90° - which is how
  Shu Todoroki's fronts were caught at 77.8°, having adopted a wheel arch that
  made them 26% too big. It checks numerically *and*
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
  **the conversion rate is no longer the difficulty signal, and that is a
  measurement change rather than a regression.** With eighteen cars the player
  is in traffic the whole race, so the rate reads how dense the pack is at
  least as much as how hard it is to pass - it now comes out *higher* on Hard
  than on Normal under two of the three models while every other number says
  Hard is plainly harder. What is asserted is what still tracks: Hard gives
  three to seven times the duels and takes back three to seven times the
  places. Today, across the circuits: Arcade 89 duels and 20 places lost on the
  Normal tuning against 128 and 41 on Hard. Those totals roughly doubled when
  the pit speed cap stopped being left on a car for the rest of the race - a
  field that can drive again after its stop is a field you have to pass again -
  and rose again with the slipstream, which also cut the time to convert a duel
  from 11.6 s to 9.3 s. **It also asserts the tow itself**: a full slipstream
  is worth 19.7 km/h of rev limiter under every model, and a rival is not given
  it twice.
  **Read it per circuit as well as in total.** The totals looked perfectly
  healthy for a release in which Motor Speedway on Hard produced *one duel in
  five laps* - the player pulled clear, went out of `FIGHT_FORGET` range, and
  nobody ever came back at them, which is exactly what the owner reported.
  That circuit alone is now 33 duels and 4 places lost on Hard. The shape
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
  at the boxes, gains no progress at either handover, and every car stops -
  18 of 18 on all three circuits, which is the number that matters, because a
  rival that *cannot* reach the entrance stays out on dead tyres and beats
  everybody who did it properly. It also asserts the two things a stop must
  never disturb: that no handover moves a car more than a car's length or
  turns it more than 20 degrees - the *diving in* figure is measured apart from
  the rest and is 0.56/1.73/1.76 m now the tests run Sport on Hard, because
  nothing brakes for a driver who holds the throttle into the pit entrance;
  braking first avoids it, and the geometry is unchanged - and that every car's `progress` stays within
  a metre of where it actually is on the road. And the invariant that catches
  the rest: **no car in the pit lane may move further in one step than it
  could have driven.** That is what found the contact shove, which no
  handover check could have - it happens between handovers, in the middle of
  the lane, and it was thousands of times worse than the thing being watched.
  And three that ask what a stop *cost*, which nothing here used to: **every
  car is back up to pace afterwards** (the slowest is at 61-66% of its top
  speed; it was 25% for every one of them, and no other assertion moved), **the
  lane flows** at 93-102 km/h of its 108 limit rather than crawling, and
  **nobody is held at the pit limit out on the racing line who cannot come in.**
  The whole field now turns in on one lap - 18, 13 and 18 of 18.
- `check_crashes.mjs` — runs at fifty times the shipped incident rate so every
  race has one, then checks the things a wreck must never do: leave a car
  outside the corridor, get shoved back onto the racing line, start on top of
  the player, be classified ahead of somebody who finished, or stop the race
  ending. Two cars out per race is the cap and it holds.
- `check_effects.mjs` — the crowd is in the stands and none of it is on the
  road; the sky is a texture and not a flat colour; a clean lap
  makes no smoke at all; a slide makes it; it clears afterwards; the pool never
  exceeds its budget; and a wreck cooks on its own. Then the pictures, because
  "there is smoke" and "it looks like smoke" are different claims.
- `check_grid.mjs` — every slot on the racing surface: `Material.105` on Motor
  Speedway, `Material.227` on Palm Mile, `Asphalt` on Yoyleland. Anything else
  and somebody is starting in the pits - `Material.107` in particular *is* the
  pit lane, and reading it here as a pass is how the whole field raced down it
  for a release.
- `check_netplay.mjs` — a host and *two* guests: all three ends agree on the
  finishing order at every latency, no car is ever drawn off the road, and a
  guest's own car sits about 0.5 m from the host's answer in a room, rising to
  9 m at 300 ms. That last figure is `2 x latency x speed` and is not a bug; it
  is what predicting costs, and it is reported apart from the correction peaks
  so neither can hide the other. **A photo finish is allowed to fall either way**: the guest
  predicts its own car, so two cars finishing 0.05 s apart are inside that same
  round trip by an order of magnitude and no correct netcode can resolve them.
  What must never differ is a place that was actually decided.
  It also measures **how smoothly a rival moves on the guest**, as the
  frame-to-frame change in its step: 0.1 cm in a room and 0.2 on wifi, 3.3 cm
  at 1% loss and 16 cm at 5%. The mean is asserted on every link; the worst
  single frame only on a link that loses nothing, because on one that does the
  big numbers are a *stall* rather than stutter - only two snapshots are
  buffered, so a gap longer than one send interval starves playback and no
  interpolator can fill it. It was 45 cm on every link before the playback
  clock was fixed.
- `check_museum.mjs` — every car framed on the plinth, the controls, and then
  a race *after* the visit, which is the real test that `close()` put back
  everything it borrowed. That last one measures **acceleration** (28 -> 60
  km/h), not a fixed speed by a fixed deadline: under a software renderer with
  eighteen cars, twelve seconds of wall clock is a couple of seconds of race,
  and a standing start covers much less of it under Sport with no aid than it
  did under Arcade. A test that fails when the renderer has a bad day is not
  measuring the thing it claims to.
- `check_rooms.mjs` — the only test of `net/peer.js`: a host takes a slot, a
  guest knocking on all eight finds it, seven empty slots answering first do
  not kill the probe, and a stray `peer-unavailable` does not destroy the room.
  It fakes PeerJS, so it says nothing about the real broker - only two phones
  can.
- `check_lobby.mjs` — a host and three guests over fake links: the room fills
  and turns away a fifth, two people cannot take the same car, RACE stays dark
  until every guest is green, a settings change un-readies them, and all four
  devices build a byte-identical grid with a pit box each. Then a two-car and a
  four-car race on every circuit, because the host can now ask for a field
  smaller than anything that has raced since the grid was widened.
- `check_twoplayer.mjs` — three tabs build an identical grid, drive, agree on
  where everybody is to within a few metres, clear the start lights, and
  survive one of them closing, and the lobby fits 667x375, 844x390 and
  915x412 with the buttons on screen. It uses the loopback transport, so a
  green run says nothing about the broker: only real devices can.
- Ride quality: vertical jitter under ~0.5 g at 50 m/s and yaw wobble under
  0.1 deg per station. Above about 1 g the car visibly shakes.
- A session downloads ~5.2 MB on Motor Speedway and reaches the menu in about
  8 s, because only the selected circuit loads - but *every* car does, and
  there are twenty of them at 3.9 MB. `assets/` totals ~14 MB; the
  420k-triangle Yoyleland model is 5.9 MB of that and only arrives if picked.
  PeerJS is another 93 KB and only arrives if somebody taps MULTIPLAYER - keep
  it that way. The crowd rides along in the track data: about 40 KB of the
  circuit's JSON, and only for the circuit being raced.
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
- Test at real phone sizes: 667×375, 844×390, 915×412. **The last button on a
  panel must stay on the screen.** It has been broken three times now - the
  options panel pushed BACK off the bottom and the owner concluded a feature
  was missing; eighteen finishers pushed RACE AGAIN off; and the lobby's six
  host controls pushed RACE off. The answer each time is the same: give the
  list that can grow its own `max-height` and `overflow-y`, and never let the
  panel itself do the scrolling.
- Touch targets are sized for a small child; the `.ctl` floor is 68 px.
- **Nothing is downloaded that can be drawn, synthesised or rendered.**
  Engines, tyres, the crowd noise and the start lights are oscillators in
  `src/audio.js`; the sky, the smoke sprite, the spectators, the contact
  shadows, the pit boxes and the museum plinth are all canvases and generated
  geometry; and the car pictures in the picker are the *models themselves*,
  drawn once at startup by `src/thumbs.js`. Keep it that way — it is zero bytes
  and zero licensing, and it is why a session is 5 MB rather than 15.
- Copyright is explicitly not a concern here: private family project, models
  are CC-BY Sketchfab uploads, attribution is in the README.
