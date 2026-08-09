# McQueen Speedway

A 3D oval racing game for a phone browser, built for a five-year-old. Take any
of eighteen cars from *Cars* around one of three NASCAR-style speedways - on
your own, or with up to three other people on their own phones.

**Play: https://artisvitols.github.io/mcqueen/**

Open it on a phone, turn the phone sideways, tap START. To race other people,
tap MULTIPLAYER instead - see below.

## How it plays

- Left thumb: ◀ ▶ steer. Right thumb: ▲ gas, ▼ brake.
- Five red lights, then green, then five laps. Lap counter is top right.
- OPTIONS sets your car, the circuit, handling, laps (2/5/10/15/20),
  difficulty, graphics quality and sound.
- Difficulty is **Easy** by default: holding the throttle down is enough to
  win, whichever handling model is picked. See below for what the other two do.
  Once a rival gets past you it keeps that extra pace for about fifteen seconds
  and then settles back down, so you get another go.
- The wheels turn at road speed, the front pair steers, and the body leans into
  the corners and noses down under braking.
- Turn the phone to landscape and it goes fullscreen; if the browser wants a
  tap first, it asks for one.

## Pit stops

Above the speed there is a **tyre bar**. It starts green and drains to red as
the tyres wear - faster if you lean on them through the corners.

You can come in **whenever you like** - you do not have to wait for the tyres
to go off. Each time you pass the pit entrance the bar shows **PIT ◀**: steer
down to the inside and the car peels off into the pit lane, obeys the speed
limit, and stops on the yellow box. **PIT!** on its own means the tyres have
had it and you should come in at the next entrance. One stop per lap. **Guido** drives out
and goes round all four wheels, then heads back to the wall and you rejoin on
fresh tyres. **Mack** is parked alongside, watching.

On Easy the car takes itself in, so holding the throttle down is still all you
have to do. The other cars pit too, so a stop costs you nothing you do not get
back.

A five-lap race needs no stop. Ten laps needs one, twenty needs three - which
is what the longer race lengths are for. Staying out on dead tyres is not a
free option: they lose grip *and* top speed, so the car that skips its stop
comes back to you.

## How it looks

Clouds drift over the grandstands, there are people in them, cars that are
being thrown about smoke their tyres, and a car that has crashed out sits at
the roadside with its engine smoking. None of it is a downloaded file - the sky and the smoke are drawn by
the game as it starts, the same way the engines are synthesised rather than
sampled. On **Low** graphics there is less of it, on purpose.

## Incidents

Now and then a rival gets it wrong, runs off the racing line and stops at the
side of the road - against the wall or down on the apron - and takes no
further part. It never happens right next to you, and there are never more
than two in a race. They still appear on the results sheet, marked **OUT**.

## Difficulty

**Easy** drives most of the car for you: it lifts for the corners, holds a
lane, overtakes and takes itself into the pits. Holding the throttle down wins.

**Normal** races you exactly as hard as Hard does - the same pace, the same
aggression, the same grudge - with one promise: **on the last lap nobody is
quicker than you, and they move over.** Whatever has happened up to then, the
race comes back to you at the end. (There is a limit: a rival more than about
150 m up the road when the last lap starts is too far away to be caught by
lifting.)

**Hard** makes you no promises at all.

## The field

Eighteen cars race, and you can drive any of them. They are not all as quick as
each other: Mater is the slowest by a clear margin, Fillmore and Sarge are next,
and the racers at the sharp end are within a per cent of one another. Each race
draws slightly different form for every car, so the order is never quite the
same twice.

**Whichever car you pick is the fastest thing out there** - a rival's cruising
pace is always below yours. What they can do is come back at you: get past one
on Hard and it will hunt you down for about fifteen seconds before settling.

## The museum

**MUSEUM** on the menu opens a showroom: each car on a lit plinth, turning
slowly. Drag to spin it round, pinch to zoom, and use the arrows to step
through all twenty - the eighteen racers plus Guido and Mack, who do not race
but are worth a look.

## Multiplayer

**MULTIPLAYER** on the menu, for **up to four of you on four phones**.

One taps **HOST A RACE** and gets a room; the others tap **JOIN A RACE** and
the games it finds are listed - there is no code to type. Tap one and you are
all in the same lobby, on the same screen: who is in, what each of you is
driving, and who has pressed READY.

Everybody picks their own car and nobody can take one that is already taken.
The **host** chooses the circuit, the laps, the difficulty, the handling, how
much help the cars give and how many AI cars fill the grid - changing any of it
asks everybody to press READY again. When all of them are green the host's
**RACE** button lights up.

It goes phone to phone over WebRTC and only uses a free public broker to
introduce the devices, so it needs the internet rather than just the same wifi.
There are eight rooms; if they are all busy, wait a minute.

If a phone drops out, that car is taken over by the AI and the race carries on
for everybody else.

## Handling

Three models, switchable in OPTIONS and mid-race from the pause menu. Everyone
on track drives whichever you choose.

| | |
|---|---|
| **Arcade** | The default. Hold the gas and the car follows the track; cornering costs nothing and you cannot spin. Built for a five-year-old. |
| **Sport** | Real grip. Carry too much speed in and the car washes wide with the tyres howling; the high line grips, the low line is shorter. Still cannot spin. |
| **Pro** | **No assists at all.** Nothing brakes for the corner, nothing holds your lane, nothing meters the throttle. Overdrive a bend and the car washes wide and scrubs speed off; get greedy on the power and the tail steps out. Predictable, and unforgiving of being clumsy. |

Sport and Pro add a six-speed gearbox, so the engine steps through the ratios
and the gear shows under the speed.

## The circuits

| Track | Lap | Notes |
|---|---|---|
| Motor Speedway of the South | 2381 m | The Piston Cup stadium from the first film |
| Palm Mile Speedway | 1507 m | Short oval, infield lake, beach behind the stands |
| Yoyleland Speedway | 2817 m | Big banked superspeedway, 18° in the turns |

The two smaller circuits are modelled at roughly 1:15, so the game scales the
model and the extracted racing line by the same factor until the racing surface
is a chosen width - which is what sets each circuit's real size, and why Motor
Speedway is 2.4 km rather than 1.5.

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
  can drive it, and under the default Arcade model spinning out or facing the
  wrong way is impossible by construction.
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
lights are all oscillators and filtered noise. No audio files are downloaded,
and the same rule holds for the pictures: the clouds, the tyre smoke, the
spectators, the shadows under the cars and the yellow pit boxes are all drawn
by the game as it starts rather than shipped as files.

Where the spectators *sit*, though, is measured rather than guessed -
`tools/extract_crowd.mjs` raycasts the stadium model and writes the seats into
the track data, because a band of people placed by eye ends up in mid-air on
one circuit and inside the concrete on another.

## Layout

```
index.html  styles.css          the whole app shell
src/track.js                    centreline spline, track space <-> world
src/car.js                      a car in track space; owns the invariants
src/physics.js                  the three handling models, and the driver aid
src/wheels.js                   splits the wheels out of each car, spins them
src/pits.js                     the pit road, as a second ribbon
src/pitstop.js                  driving in, stopping, being serviced, leaving
src/pitcrew.js                  Guido going round the wheels, and Mack parked
src/museum.js                   the showroom
src/ai.js                       opponent drivers: lanes, drafting, grudges
src/race.js                     grid, countdown, running order, incidents, finish
src/sky.js                      the clouds, drawn into a canvas at startup
src/smoke.js                    tyre smoke and a wreck's engine, one Points pool
src/crowd.js                    the spectators, one Points pool per circuit
src/net.js, src/net/            the protocol, the lobby and three transports
src/main.js                     renderer, camera, menus, game loop
src/{input,hud,audio,models,settings}.js
assets/                         compressed models + extracted track data
vendor/three, vendor/peerjs     the only two libraries, both vendored
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
node  tools/extract_pits.mjs palm          # ... and its pit road, as a second ribbon
node  tools/extract_crowd.mjs palm         # ... and where its spectators sit

python3 tools/inspect_track.py raw/x.glb   # materials, scale, overhead map
node  tools/probe_points.mjs raw/x.glb 1,2 # what is actually at a world point

node  tools/simulate.mjs all       # headless races: physics x track x difficulty
node  tools/trace_lap.mjs msots sport   # why a lap was slow, half-second by half-second
node  tools/verify_track.mjs       # shipped tracks vs physics data - run this!
node  tools/check_ride_height.mjs  # gap between each car and the road
node  tools/check_wheels.mjs       # every wheel found, and proof they turn
node  tools/check_steering.mjs     # does it steer, and does the field weave?
node  tools/check_racing.mjs       # how hard is it actually to overtake?
node  tools/check_museum.mjs       # every car on the plinth, and the race after
node  tools/check_effects.mjs      # clouds, crowd, tyre smoke, a wreck cooking
node  tools/check_crashes.mjs      # rivals have incidents, and they are safe
node  tools/check_pits.mjs         # pit roads on asphalt, and a stop end to end
node  tools/shots_pits.mjs yoyle   # ... and a picture of Guido doing it
node  tools/check_grid.mjs         # what surface each starting slot sits on
node  tools/check_barriers.mjs     # walls inside the corridor, holes under a wheel
node  tools/test_pause.mjs         # the pause menu, and panels that fit a phone
node  tools/check_fullscreen.mjs   # rotate to landscape, and the tap fallback
node  tools/check_netplay.mjs      # a host and two guests agree, at four latencies
node  tools/check_lobby.mjs        # four in a lobby, in one process
node  tools/check_twoplayer.mjs    # three real tabs through the real menus
node  tools/shots.mjs              # drive the real game in headless Chrome
node  tools/shots_tracks.mjs       # ... on every circuit
```

`tools/simulate.mjs` runs the actual `Track`/`Car`/`Driver`/`Race` code with no
renderer - every handling model against every circuit at every difficulty, plus
a two-player grid - and asserts that every car completes the right number of
laps, nobody leaves the racing surface, overtakes happen, and each difficulty
lands where it should. Easy has to be a win on all of them.

The network stack is tested the same way. `check_lobby.mjs` runs a host and
three guests in one process over fake links; `check_netplay.mjs` races a host
and two guests at four latencies and packet-loss rates; `check_twoplayer.mjs`
drives three real browser tabs through the real menus. All of them use the
loopback or in-process transports, so a green run says nothing about the public
broker - only real phones can test that.

`tools/smoke.html` checks every asset loads and each car normalises to its
real-world size.

## Credits

3D models are CC-BY from Sketchfab and used here for a private, non-commercial
family project:

- **Lightning McQueen** — [Guilherme Navarro](https://sketchfab.com/3d-models/lightning-mcqueen-cars-987dfeaab6e84bc094b707e77c96f45d)
- **Yoyleland International Speedway** — [RedUnLuckyBlockOSC](https://sketchfab.com/3d-models/yoyleland-international-speedway-nascar-x-bfdi-c6aa0b11a789415b8fe7b2ac8a122db1)
- **Motor Speedway of the South** and **Palm Mile Speedway** are likewise
  Sketchfab community uploads of the Cars circuits.
- The rest of the grid is likewise Sketchfab community uploads: Chick Hicks,
  The King, Francesco Bernoulli, Jackson Storm, Mater, Doc Hudson, Cruz
  Ramirez, Sally Carrera, Shu Todoroki, Carla Veloso, Claude Scruggs, Darrell
  Cartrip, Michael Schumacher, Finn McMissile, Sarge, Fillmore and Ivy - plus
  Guido and Mack, who work in the pits rather than race.

Every one of them is pulled from a Google Drive folder by
`tools/fetch_assets.sh`; the file ids are in there, and `raw/` is gitignored,
so only the compressed output in `assets/` is committed.

*Cars* and its characters are trademarks of Disney/Pixar. This is a fan project
made for one kid, not affiliated with or endorsed by Disney or Pixar.

three.js is MIT licensed — see `vendor/three/LICENSE`, and PeerJS likewise —
see `vendor/peerjs/README.md`.
