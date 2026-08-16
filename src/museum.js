import * as THREE from 'three';

/**
 * The showroom.
 *
 * A place to just look at the cars: one on a lit plinth, drag to turn it,
 * pinch to zoom, tap through the field.
 *
 * It borrows the game's scene and renderer rather than building its own. That
 * is not only thrift - **McQueen is a skinned mesh, and a skinned mesh binds
 * to the world matrix it had when it loaded**, so lifting the cars into a
 * scratch scene is exactly the trap `CLAUDE.md` warns about. Instead the
 * circuit is hidden, a room is switched on around the same cars, and
 * everything is put back on the way out.
 */

const PLINTH_R = 3.4;
const MIN_DIST = 3.2;         // how close a pinch may get
const MAX_DIST = 12;          // ... and how far, for a car-sized exhibit
const CAR_REACH = 4.6;        // what the room was proportioned for
const MIN_PITCH = 0.04;       // radians above the floor
const MAX_PITCH = 1.15;       // ... and short of straight down
const SPIN = 0.12;            // idle turntable, rad/s
const FOG_DENSITY = 0.022;    // at k = 1; thinned for a bigger room

export class Museum {
  /**
   * @param {THREE.Scene} scene    the game's scene
   * @param {THREE.Camera} camera  ... and its camera
   */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.group = this.build();
    this.group.visible = false;
    scene.add(this.group);

    this.car = null;
    this.yaw = Math.PI * 0.22;
    this.pitch = 0.30;
    this.dist = 7.4;
    this.maxDist = MAX_DIST;       // raised for an exhibit bigger than a car
    this.spin = true;              // turns by itself until you touch it
    this.saved = null;
    this._aim = new THREE.Vector3(0, 0.55, 0);
  }

  /** The room: a floor, a plinth, a backdrop and some showroom lighting. */
  build() {
    const g = new THREE.Group();
    g.name = 'museum';

    // A dark polished floor. Big enough that its edge is never in shot -
    // which now has to hold for Mack, who is four car-lengths long and is
    // looked at from four times as far back.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(160, 64),
      new THREE.MeshStandardMaterial({ color: 0x0d1017, roughness: 0.35, metalness: 0.5 }),
    );
    floor.rotation.x = -Math.PI / 2;
    // **Below the plinth, not level with it.** Both are discs of 64 segments
    // and the plinth's top face sits flush at y = 0, so a floor at y = 0 too
    // is two coplanar surfaces fighting over the same depth - which shows as
    // bright and dark wedges radiating from the centre, exactly following the
    // triangulation, and crawls as the camera moves. It reads as the plinth
    // having the wrong material; it is the plinth and the floor being in the
    // same place. Dropping the floor to the plinth's base also makes it look
    // like something standing on the floor rather than inlaid into it.
    floor.position.y = -0.22;
    floor.receiveShadow = true;
    g.add(floor);

    // The plinth, with a bright rim so the car reads against the dark floor.
    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(PLINTH_R, PLINTH_R + 0.18, 0.22, 64),
      // **Matte, and not metal.** `metalness` was 0.35 with no environment map
      // to reflect, so the top face had nothing to be metallic *with*: it went
      // dark and lit only through moving specular highlights, which is what
      // made it look like the wrong material.
      new THREE.MeshStandardMaterial({ color: 0x232a3a, roughness: 0.78, metalness: 0.0 }),
    );
    plinth.position.y = -0.11;          // top face flush with y = 0
    // It still takes the car's shadow. The radial banding here was the floor
    // fighting it for the same depth, not shadow acne - see the note on the
    // floor above - and the generous `normalBias` on the key light is what
    // keeps the acne away.
    plinth.receiveShadow = true;
    g.add(plinth);
    this.plinth = plinth;

    const rim = new THREE.Mesh(
      new THREE.RingGeometry(PLINTH_R - 0.06, PLINTH_R + 0.02, 64),
      new THREE.MeshBasicMaterial({ color: 0xffd66b, side: THREE.DoubleSide,
                                    transparent: true, opacity: 0.55 }),
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.012;
    g.add(rim);
    this.rim = rim;

    // A curved backdrop, lit from below, so there is no horizon line and the
    // room reads as a room rather than a plane in the void.
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(70, 70, 70, 48, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0x151b28, roughness: 0.9, metalness: 0.0, side: THREE.BackSide,
      }),
    );
    wall.position.y = 33;
    g.add(wall);

    // Three-point-ish lighting: a key from the front quarter, a cool rim from
    // behind to pick out the roofline, and a soft fill so the shadowed side is
    // not black.
    const key = new THREE.SpotLight(0xfff4e2, 260, 30, 0.62, 0.45, 1.6);
    key.position.set(5.5, 8.5, 6.5);
    key.target.position.set(0, 0.5, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    // A generous normal bias: the plinth is a wide flat disc lit from a sharp
    // angle, which is the classic recipe for shadow acne - it showed up as
    // radial banding following the cylinder's triangulation.
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.35;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 40;
    g.add(key, key.target);

    const rimLight = new THREE.SpotLight(0x9dc6ff, 150, 30, 0.7, 0.6, 1.6);
    rimLight.position.set(-6, 6, -7.5);
    rimLight.target.position.set(0, 0.6, 0);
    g.add(rimLight, rimLight.target);

    const fill = new THREE.PointLight(0xffd9a8, 40, 24, 1.8);
    fill.position.set(-4.5, 2.4, 5);
    g.add(fill);

    // Kept so `frame()` can move them out with the exhibit. A rig placed for
    // a 4.4 m car sits *inside* an 18 m truck, lighting one wheel arch.
    this.lights = [key, rimLight, fill].map((l) => ({
      light: l,
      pos: l.position.clone(),
      target: l.target ? l.target.position.clone() : null,
      distance: l.distance,
      intensity: l.intensity,
      shadowFar: l.shadow ? l.shadow.camera.far : 0,
      normalBias: l.shadow ? l.shadow.normalBias : 0,
    }));
    this._k = 1;

    g.add(new THREE.HemisphereLight(0x4a5878, 0x0a0c11, 0.55));
    return g;
  }

  /**
   * Switch the room on.
   *
   * The circuit, the sky and the fog all belong to the race; they are put
   * aside here and restored by `close()` exactly as they were.
   */
  open(trackScene) {
    this.saved = {
      track: trackScene ? trackScene.visible : null,
      background: this.scene.background,
      fog: this.scene.fog,
      fov: this.camera.fov,
      up: this.camera.up.clone(),
    };
    if (trackScene) trackScene.visible = false;
    this.trackScene = trackScene;
    this.scene.background = new THREE.Color(0x090c12);
    this.scene.fog = new THREE.FogExp2(0x090c12, FOG_DENSITY / this._k);
    this.camera.fov = 42;
    this.camera.up.set(0, 1, 0);
    this.camera.updateProjectionMatrix();
    this.group.visible = true;
  }

  close() {
    if (!this.saved) return;
    if (this.trackScene) this.trackScene.visible = this.saved.track;
    this.scene.background = this.saved.background;
    this.scene.fog = this.saved.fog;
    this.camera.fov = this.saved.fov;
    this.camera.up.copy(this.saved.up);
    this.camera.updateProjectionMatrix();
    this.group.visible = false;
    if (this.car) this.car.visible = false;
    this.car = null;
    this.saved = null;
  }

  /**
   * Put a car on the plinth.
   * @param {THREE.Object3D} object  a pivot from loadCar, already in the scene
   */
  show(object, size = null) {
    if (this.car === object) return;
    if (this.car) this.car.visible = false;
    this.car = object;
    object.visible = true;
    object.position.set(0, 0, 0);
    object.quaternion.identity();
    object.rotation.y = 0;
    this.spin = true;
    // Frame to the car rather than to a fixed distance: Mater is a metre
    // longer and half a metre taller than McQueen, and one distance either
    // crops him or leaves the low cars tiny.
    if (size) {
      const reach = Math.max(size.x, size.z, size.y * 1.6);
      this.frame(Math.max(1, reach / CAR_REACH));
      // A car-sized exhibit keeps the old limit exactly; Mack needs four
      // times it or the camera cannot get far enough back to see him.
      this.maxDist = Math.max(MAX_DIST, reach * 2.4);
      this.dist = THREE.MathUtils.clamp(reach * 1.55, MIN_DIST, this.maxDist);
      this._aim.y = Math.max(0.45, size.y * 0.45);
    }
  }

  /**
   * Scale the room to the exhibit.
   *
   * The floor and backdrop are already big enough for anything here, so only
   * the plinth and the lighting move - a rig placed for a 4.4 m car sits
   * *inside* an 18 m truck and lights one wheel arch. The car is never scaled.
   */
  frame(k) {
    if (this._k === k) return;
    this._k = k;
    this.plinth.scale.set(k, 1, k);
    this.rim.scale.setScalar(k);
    for (const l of this.lights) {
      l.light.position.copy(l.pos).multiplyScalar(k);
      if (l.target) l.light.target.position.copy(l.target).multiplyScalar(k);
      l.light.distance = l.distance * k;
      // Inverse-square falloff: holding the brightness at the subject while
      // moving the lamp away means raising it with the square of the distance.
      l.light.intensity = l.intensity * k * k;
      if (l.light.shadow) {
        l.light.shadow.camera.far = l.shadowFar * k;
        // A world-space nudge, so it has to grow with the room or the acne
        // the plinth is prone to comes straight back.
        l.light.shadow.normalBias = l.normalBias * k;
      }
    }
    // Only once the fog is ours - `open()` puts the race's aside first, and
    // dimming that one would fog the circuit.
    if (this.saved && this.scene.fog) this.scene.fog.density = FOG_DENSITY / k;
  }

  /** One finger: turn the car. Two: pinch to zoom. */
  drag(dx, dy) {
    this.spin = false;
    this.yaw -= dx * 0.008;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.006, MIN_PITCH, MAX_PITCH);
  }

  pinch(scale) {
    this.spin = false;
    this.dist = THREE.MathUtils.clamp(this.dist / scale, MIN_DIST, this.maxDist);
  }

  update(dt) {
    if (!this.saved) return;
    // Left alone it turns slowly, so the showroom is never a still image.
    if (this.spin) this.yaw += SPIN * dt;

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      Math.sin(this.yaw) * cp * this.dist,
      Math.sin(this.pitch) * this.dist + this._aim.y,
      Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(this._aim);
  }
}
