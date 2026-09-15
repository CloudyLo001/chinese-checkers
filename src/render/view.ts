/**
 * The three.js layer: board, marbles, camera, animation and picking.
 *
 * It renders whatever state it is handed and reports hole indices back through
 * callbacks. It never decides whether a move is legal — that is `game/rules`.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BOARD_RADIUS,
  CORNER_CENTROID,
  CORNER_HOLES,
  HOLES,
  HOLE_COUNT,
  NEIGHBORS,
  cornerFacingRotation,
} from '../game/board';
import type { AnimationSpeed, CornerName, MoveKind, Seat } from '../game/types';
import { PLAYER_COLORS } from '../game/types';
import { backgroundTexture, disposeGlyphs, glyphTexture } from './glyphs';

const MARBLE_RADIUS = 0.42;
/** Radius of the drilled hole. Smaller than a marble, so marbles rest in the rim. */
const HOLE_RADIUS = 0.3;
/**
 * How far below the surface the bottom of each hole sits. Deep enough to read
 * as a crevice from the play camera, shallow enough that the key light still
 * reaches the floor — any deeper and the holes look like voids, not dimples.
 */
const HOLE_DEPTH = 0.14;
/** Unlit colour of a hole floor, tinted per corner in `setSeats`. */
const SOCKET_BASE = 0xf2a8ca;
const PLATE_COLOR = 0xfff4fa;
const LATTICE_COLOR = 0xf0a0c4;
const PLATE_THICKNESS = 0.55;
const PLATE_TOP = PLATE_THICKNESS / 2;
/** Marbles nestle into their dimple rather than floating on the surface. */
const MARBLE_Y = PLATE_TOP + MARBLE_RADIUS * 0.56;
const MARKER_Y = PLATE_TOP + 0.035;
/** Outward offset of the plate edge from the outermost holes. */
const PLATE_MARGIN = 0.55;
/**
 * How far the six star tips are rounded off, as a fraction of the edges either
 * side of them. Enough to take the needle off a 60-degree point so it reads as
 * a moulded board rather than a cut-out, and not so much that the star softens
 * into a flower.
 */
const PLATE_TIP_ROUNDING = 0.14;
/** How much of the viewport the board fills. */
const FRAMING = 0.97;

/**
 * Camera tilt, as the polar angle away from straight down.
 *
 * `ANGLED` is the default three-quarter view. `FLAT` looks the board square in
 * the face, which turns it back into the flat star you get on a printed board.
 * It stops just short of zero because a camera directly overhead is parallel to
 * its own up vector, and `lookAt` has no rotation to give for that.
 */
const POLAR_ANGLED = 0.72;
const POLAR_FLAT = 0.02;
/**
 * Field of view, narrowed as the camera flattens. Straight down at a wide angle
 * the outer marbles are still seen from the side, which reads as a dome; a long
 * lens flattens that out and approaches the look of an orthographic view.
 */
const FOV_ANGLED = 42;
const FOV_FLAT = 24;
/** Tilt at which the lens has fully widened back out. */
const FOV_BLEND_POLAR = 0.38;

const SEGMENT_MS: Record<AnimationSpeed, number> = {
  slow: 320,
  normal: 185,
  fast: 105,
  instant: 0,
};

/**
 * `step` and `hop` are the moves on offer right now. `alternate` is the rest of
 * the turn's destinations, shown once a move is on the board so the other
 * options stay visible while it is still unconfirmed.
 */
export type MarkerKind = MoveKind | 'alternate';

const MARKER_COLORS: Record<MarkerKind, number> = {
  step: 0x1fa2ff,
  hop: 0xff8a1f,
  alternate: 0x1fa2ff,
};

export interface Marker {
  hole: number;
  kind: MarkerKind;
}

interface MoveAnimation {
  marble: THREE.Object3D;
  path: number[];
  kind: MoveKind;
  segment: number;
  elapsed: number;
  done: () => void;
}

const tmpVector = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const tmpColor = new THREE.Color();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3(1, 1, 1);

export class BoardView {
  onPointerDownHole: ((hole: number | null) => void) | null = null;
  onPointerUpHole: ((hole: number | null) => void) | null = null;
  /**
   * Where the tracked corner has moved to on screen, in normalised device
   * coordinates (-1..1, y up). Fires whenever it shifts enough to matter, so
   * anything pinned to a player's side follows the board as it turns.
   */
  onCornerAnchorMove: ((point: { x: number; y: number }) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly boardGroup = new THREE.Group();
  private readonly marbleGroup = new THREE.Group();

  private readonly marbleGeometry: THREE.SphereGeometry;
  private readonly glyphGeometry: THREE.PlaneGeometry;
  private readonly marbleMaterials: THREE.MeshPhysicalMaterial[] = [];
  private readonly glyphMaterials: THREE.MeshBasicMaterial[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  private sockets!: THREE.InstancedMesh;
  private markerMesh!: THREE.InstancedMesh;
  private selectionRing!: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private pickPlane!: THREE.Mesh;
  /** Brightened copies of the marble materials, built on first use. */
  private readonly highlightMaterials: (THREE.MeshPhysicalMaterial | undefined)[] = [];

  /** Marble meshes keyed by the hole they occupy. */
  private marbles = new Map<number, THREE.Mesh>();
  private markers: Marker[] = [];
  private selected: number | null = null;
  private animation: MoveAnimation | null = null;
  private speed: AnimationSpeed = 'normal';
  private reducedMotion = false;

  private trackedCorner: CornerName | null = null;
  private lastAnchor = { x: Number.NaN, y: Number.NaN };

  private orbit = { azimuth: 0, polar: POLAR_ANGLED, distance: 24, zoom: 1 };
  /** Tilt the camera eases towards; a drag retargets it so the two never fight. */
  private polarTarget = POLAR_ANGLED;
  /** Tilt the current framing was measured at, so it is only redone when it moves. */
  private fittedPolar = Number.NaN;
  private flatBoard = false;
  private boardRotation = 0;
  private boardRotationTarget = 0;
  private idleSpin = false;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private pointers = new Map<number, { x: number; y: number }>();
  private gesture: 'none' | 'tap' | 'camera' = 'none';
  private downHole: number | null = null;
  private pinchStart = 0;
  private orbitStart = { x: 0, y: 0, azimuth: 0, polar: 0 };
  private lastTapAt = 0;

  private running = false;
  private frame = 0;
  private lastTime = 0;
  private readonly resizeObserver: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Neutral over ACES: the filmic curve desaturates exactly the vivid
    // candy colours this theme is built on.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(FOV_ANGLED, 1, 0.5, 120);

    const background = backgroundTexture();
    this.scene.background = background;
    this.disposables.push(background);

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.marbleGeometry = new THREE.SphereGeometry(MARBLE_RADIUS, 24, 16);
    this.glyphGeometry = new THREE.PlaneGeometry(MARBLE_RADIUS * 1.25, MARBLE_RADIUS * 1.25);
    this.glyphGeometry.rotateX(-Math.PI / 2);
    this.disposables.push(this.marbleGeometry, this.glyphGeometry);

    this.buildEnvironment();
    this.buildLights();
    this.buildBoard();
    this.buildMaterials();

    this.scene.add(this.boardGroup);
    this.boardGroup.add(this.marbleGroup);

    this.bindPointerEvents();
    // A ResizeObserver catches everything window.resize misses: iOS Safari
    // hiding its URL bar, orientation changes, and layout-driven resizes.
    this.resizeObserver = new ResizeObserver(this.handleResize);
    this.resizeObserver.observe(canvas);
    window.addEventListener('resize', this.handleResize);
    window.addEventListener('orientationchange', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.handleResize();
  }

  // --- construction --------------------------------------------------------

  private buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = environment.texture;
    this.scene.environmentIntensity = 0.4;
    this.disposables.push(environment.texture);
    pmrem.dispose();
  }

  private buildLights(): void {
    // Bright but not blown out: too much white fill washes the candy colours
    // straight out of the marbles.
    const hemi = new THREE.HemisphereLight(0xffffff, 0xffc2dd, 0.7);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff6f2, 1.5);
    key.position.set(6, 15, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 4;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -12;
    key.shadow.camera.right = 12;
    key.shadow.camera.top = 12;
    key.shadow.camera.bottom = -12;
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xffe3f2, 0.65);
    fill.position.set(-8, 6, -6);
    this.scene.add(fill);
  }

  /**
   * 12-point hexagram outline, outset so every hole sits comfortably inside.
   * The six outward tips are rounded; the inner notches stay crisp, which is
   * what keeps the silhouette reading as a star.
   */
  private plateShape(): THREE.Shape {
    // Outsetting each of the two triangles by d pushes its tips out by 2d.
    const outer = BOARD_RADIUS + 2 * PLATE_MARGIN;
    const inner = outer / Math.sqrt(3);
    const points: THREE.Vector2[] = [];
    for (let i = 0; i < 12; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = (-90 + i * 30) * (Math.PI / 180);
      points.push(new THREE.Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius));
    }

    const shape = new THREE.Shape();
    for (let i = 0; i < 12; i++) {
      const corner = points[i];
      // Even indices are the outward tips; the odd ones are the notches between.
      if (i % 2 !== 0) {
        shape.lineTo(corner.x, corner.y);
        continue;
      }
      // Stop short of the tip along both edges and curve through it instead.
      const entry = corner.clone().lerp(points[(i + 11) % 12], PLATE_TIP_ROUNDING);
      const exit = corner.clone().lerp(points[(i + 1) % 12], PLATE_TIP_ROUNDING);
      if (i === 0) shape.moveTo(entry.x, entry.y);
      else shape.lineTo(entry.x, entry.y);
      shape.quadraticCurveTo(corner.x, corner.y, exit.x, exit.y);
    }
    shape.closePath();
    return shape;
  }

  private buildBoard(): void {
    // Drill a real hole at every position. ExtrudeGeometry turns each hole path
    // into an actual opening with a beveled rim and a wall you can see down,
    // which is what makes the board read as drilled wood rather than printed.
    const shape = this.plateShape();
    for (const hole of HOLES) {
      const bore = new THREE.Path();
      // Shape space is (x, -z): the extrusion is rotated down onto XZ below.
      bore.absarc(hole.x, -hole.z, HOLE_RADIUS, 0, Math.PI * 2, true);
      shape.holes.push(bore);
    }

    const depth = PLATE_THICKNESS * 0.8;
    const bevelThickness = 0.055;
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelThickness,
      bevelSize: 0.05,
      bevelSegments: 2,
      curveSegments: 14,
    });
    geometry.rotateX(-Math.PI / 2);
    // Sit the countersunk rim exactly at the play surface.
    geometry.translate(0, PLATE_TOP - (depth + bevelThickness), 0);
    const material = new THREE.MeshStandardMaterial({
      color: PLATE_COLOR,
      roughness: 0.62,
      metalness: 0.02,
    });
    const plate = new THREE.Mesh(geometry, material);
    plate.receiveShadow = true;
    plate.castShadow = true;
    this.boardGroup.add(plate);
    this.disposables.push(geometry, material);

    this.buildLattice();

    // The floor of each hole, sunk below the surface so every hole reads as a
    // crevice. Its colour also shows which corners are in play.
    const socketGeometry = new THREE.CylinderGeometry(HOLE_RADIUS * 0.99, HOLE_RADIUS * 0.7, 0.09, 16);
    const socketMaterial = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 });
    this.sockets = new THREE.InstancedMesh(socketGeometry, socketMaterial, HOLE_COUNT);
    this.sockets.receiveShadow = true;
    this.sockets.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    for (let i = 0; i < HOLE_COUNT; i++) {
      const hole = HOLES[i];
      tmpMatrix.compose(
        tmpVector.set(hole.x, PLATE_TOP - HOLE_DEPTH, hole.z),
        tmpQuaternion.identity(),
        tmpScale.set(1, 1, 1),
      );
      this.sockets.setMatrixAt(i, tmpMatrix);
      this.sockets.setColorAt(i, tmpColor.setHex(SOCKET_BASE));
    }
    this.sockets.instanceMatrix.needsUpdate = true;
    this.boardGroup.add(this.sockets);
    this.disposables.push(socketGeometry, socketMaterial);

    // Legal-move markers, shown a few at a time.
    const markerGeometry = new THREE.TorusGeometry(HOLE_RADIUS + 0.1, 0.045, 8, 26);
    markerGeometry.rotateX(-Math.PI / 2);
    const markerMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });
    this.markerMesh = new THREE.InstancedMesh(markerGeometry, markerMaterial, HOLE_COUNT);
    this.markerMesh.count = 0;
    this.markerMesh.frustumCulled = false;
    this.boardGroup.add(this.markerMesh);
    this.disposables.push(markerGeometry, markerMaterial);

    // Ring around the selected marble. A lift alone is nearly invisible looking
    // straight down at a flat board, so the signal has to live on the surface.
    const ringGeometry = new THREE.TorusGeometry(MARBLE_RADIUS + 0.18, 0.075, 10, 34);
    ringGeometry.rotateX(-Math.PI / 2);
    const ringMaterial = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 1,
      depthWrite: false,
      toneMapped: false,
    });
    this.selectionRing = new THREE.Mesh(ringGeometry, ringMaterial);
    this.selectionRing.visible = false;
    this.selectionRing.frustumCulled = false;
    this.boardGroup.add(this.selectionRing);
    this.disposables.push(ringGeometry, ringMaterial);

    // Invisible pick plane: one raycast, then nearest-hole lookup in board space.
    const planeGeometry = new THREE.PlaneGeometry(80, 80);
    planeGeometry.rotateX(-Math.PI / 2);
    const planeMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
    });
    this.pickPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    this.pickPlane.position.y = MARBLE_Y;
    this.pickPlane.renderOrder = -1;
    this.scene.add(this.pickPlane);
    this.disposables.push(planeGeometry, planeMaterial);
  }

  /**
   * The engraved lattice linking neighbouring holes, as on a printed board.
   * Segments stop at each rim rather than crossing the openings, and the whole
   * grid is one LineSegments — a single draw call for ~330 lines.
   */
  private buildLattice(): void {
    const y = PLATE_TOP + 0.006;
    const inset = HOLE_RADIUS + 0.06;
    const positions: number[] = [];

    for (const hole of HOLES) {
      // Three of the six directions covers every edge exactly once.
      for (let d = 0; d < 3; d++) {
        const index = NEIGHBORS[hole.index * 6 + d];
        if (index < 0) continue;
        const other = HOLES[index];
        const dx = other.x - hole.x;
        const dz = other.z - hole.z;
        const length = Math.hypot(dx, dz);
        const ux = (dx / length) * inset;
        const uz = (dz / length) * inset;
        positions.push(hole.x + ux, y, hole.z + uz, other.x - ux, y, other.z - uz);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: LATTICE_COLOR,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    this.boardGroup.add(new THREE.LineSegments(geometry, material));
    this.disposables.push(geometry, material);
  }

  private buildMaterials(): void {
    for (let i = 0; i < PLAYER_COLORS.length; i++) {
      const material = new THREE.MeshPhysicalMaterial({
        color: PLAYER_COLORS[i].hex,
        roughness: 0.22,
        metalness: 0.0,
        // Enough gloss to read as a glass marble, not so much that the
        // highlight swamps the colour underneath.
        clearcoat: 0.7,
        clearcoatRoughness: 0.12,
      });
      this.marbleMaterials.push(material);
      this.disposables.push(material);

      const glyph = new THREE.MeshBasicMaterial({
        map: glyphTexture(i),
        transparent: true,
        depthWrite: false,
        opacity: 0.85,
        toneMapped: false,
      });
      this.glyphMaterials.push(glyph);
      this.disposables.push(glyph);
    }
  }

  // --- public API ----------------------------------------------------------

  /** Tints the corners that are in play. Drives the setup-screen preview. */
  setSeats(seats: readonly Seat[]): void {
    const base = new THREE.Color(SOCKET_BASE);
    for (let i = 0; i < HOLE_COUNT; i++) {
      this.sockets.setColorAt(i, base);
    }
    for (const seat of seats) {
      const color = new THREE.Color(PLAYER_COLORS[seat.colorIndex].hex);
      const home = base.clone().lerp(color, 0.62);
      const dest = base.clone().lerp(color, 0.3);
      for (const hole of CORNER_HOLES[seat.corner]) this.sockets.setColorAt(hole, home);
      for (const hole of CORNER_HOLES[seat.dest]) this.sockets.setColorAt(hole, dest);
    }
    if (this.sockets.instanceColor) this.sockets.instanceColor.needsUpdate = true;
  }

  /** Rebuilds every marble from an occupancy array. Used on load, undo and reset. */
  syncFromOccupancy(occ: Int8Array, seats: readonly Seat[]): void {
    this.finishAnimation();
    for (const marble of this.marbles.values()) this.marbleGroup.remove(marble);
    this.marbles.clear();

    for (let hole = 0; hole < occ.length; hole++) {
      const seatId = occ[hole];
      if (seatId < 0) continue;
      const seat = seats.find((candidate) => candidate.id === seatId);
      if (!seat) continue;
      const marble = this.createMarble(seat.colorIndex);
      marble.position.set(HOLES[hole].x, MARBLE_Y, HOLES[hole].z);
      this.marbleGroup.add(marble);
      this.marbles.set(hole, marble);
    }
    this.setSelection(null);
  }

  private createMarble(colorIndex: number): THREE.Mesh {
    const marble = new THREE.Mesh(this.marbleGeometry, this.marbleMaterials[colorIndex]);
    marble.userData.colorIndex = colorIndex;
    marble.castShadow = true;
    marble.receiveShadow = false;
    const glyph = new THREE.Mesh(this.glyphGeometry, this.glyphMaterials[colorIndex]);
    glyph.position.y = MARBLE_RADIUS + 0.012;
    glyph.renderOrder = 2;
    marble.add(glyph);
    return marble;
  }

  /**
   * Marks a marble as the one in play: a ring on the board around it, the
   * marble itself brightened, and the gentle lift. Used both for a marble the
   * player has picked up and for one they have moved but not confirmed.
   */
  setSelection(hole: number | null): void {
    if (this.selected !== null) {
      const previous = this.marbles.get(this.selected);
      if (previous) {
        previous.position.y = MARBLE_Y;
        previous.material = this.marbleMaterials[previous.userData.colorIndex as number];
      }
    }

    this.selected = hole;
    const marble = hole === null ? undefined : this.marbles.get(hole);
    if (hole === null || !marble) {
      this.selectionRing.visible = false;
      return;
    }

    const colorIndex = marble.userData.colorIndex as number;
    marble.material = this.brightMaterial(colorIndex);
    // Deepened: the ring lies on a near-white board, so the marble's own tint
    // washes out against it. Darkening keeps the player's colour legible while
    // giving it contrast against both the board and the brightened marble.
    this.selectionRing.material.color.setHex(PLAYER_COLORS[colorIndex].hex).multiplyScalar(0.72);
    this.selectionRing.position.set(HOLES[hole].x, MARKER_Y + 0.006, HOLES[hole].z);
    this.selectionRing.visible = true;
  }

  /** The marble's own colour, made to glow. Cached: one per colour, not per pick. */
  private brightMaterial(colorIndex: number): THREE.MeshPhysicalMaterial {
    const cached = this.highlightMaterials[colorIndex];
    if (cached) return cached;
    const material = this.marbleMaterials[colorIndex].clone();
    material.emissive = new THREE.Color(PLAYER_COLORS[colorIndex].hex);
    material.emissiveIntensity = 0.6;
    this.highlightMaterials[colorIndex] = material;
    this.disposables.push(material);
    return material;
  }

  setMarkers(markers: Marker[]): void {
    this.markers = markers;
    this.markerMesh.count = markers.length;
    for (let i = 0; i < markers.length; i++) {
      this.markerMesh.setColorAt(i, tmpColor.setHex(MARKER_COLORS[markers[i].kind]));
    }
    if (this.markerMesh.instanceColor) this.markerMesh.instanceColor.needsUpdate = true;
    this.markerMesh.instanceMatrix.needsUpdate = true;
  }

  /** Animates one marble along a hop chain (or a single step) and then settles it. */
  animateMove(path: number[], kind: MoveKind, done: () => void): void {
    this.finishAnimation();
    const from = path[0];
    const to = path[path.length - 1];
    const marble = this.marbles.get(from);
    if (!marble) {
      done();
      return;
    }
    this.setSelection(null);
    this.marbles.delete(from);
    this.marbles.set(to, marble);

    if (this.segmentDuration() === 0 || path.length < 2) {
      marble.position.set(HOLES[to].x, MARBLE_Y, HOLES[to].z);
      done();
      return;
    }
    this.animation = { marble, path, kind, segment: 0, elapsed: 0, done };
  }

  get isAnimating(): boolean {
    return this.animation !== null;
  }

  private finishAnimation(): void {
    const animation = this.animation;
    if (!animation) return;
    const last = animation.path[animation.path.length - 1];
    animation.marble.position.set(HOLES[last].x, MARBLE_Y, HOLES[last].z);
    this.animation = null;
    animation.done();
  }

  faceCorner(corner: CornerName | null, instant = false): void {
    const target = corner ? cornerFacingRotation(corner) : 0;
    // Take the short way round.
    let delta = target - this.boardRotationTarget;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    this.boardRotationTarget += delta;
    if (instant || this.segmentDuration() === 0) {
      this.boardRotation = this.boardRotationTarget;
      this.boardGroup.rotation.y = this.boardRotation;
    }
  }

  setAnimationSpeed(speed: AnimationSpeed): void {
    this.speed = speed;
  }

  /**
   * Follow a corner's position on screen, reporting it through
   * `onCornerAnchorMove`. Pass null to stop.
   */
  trackCorner(corner: CornerName | null): void {
    this.trackedCorner = corner;
    // Forget the last reading so the new corner is reported straight away.
    this.lastAnchor = { x: Number.NaN, y: Number.NaN };
  }

  /** Slow drift used behind the menus. */
  setIdleSpin(on: boolean): void {
    this.idleSpin = on;
  }

  /**
   * Flat looks straight down at the board, angled is the three-quarter view.
   * Either way the tilt stays draggable — this only moves where it rests.
   */
  setFlatBoard(on: boolean, instant = false): void {
    this.flatBoard = on;
    this.polarTarget = on ? POLAR_FLAT : POLAR_ANGLED;
    if (instant || this.reducedMotion) this.orbit.polar = this.polarTarget;
  }

  /**
   * Scene readout for tests: where every marble ended up and whether it lands
   * inside the viewport once projected. Cheap enough to leave in.
   */
  debugSnapshot(): {
    marbles: { hole: number; x: number; z: number; ndcX: number; ndcY: number }[];
    markers: number;
    selected: number | null;
    drawCalls: number;
    triangles: number;
  } {
    this.camera.updateMatrixWorld();
    const marbles = [...this.marbles.entries()].map(([hole, mesh]) => {
      const projected = mesh.getWorldPosition(new THREE.Vector3()).project(this.camera);
      return {
        hole,
        x: mesh.position.x,
        z: mesh.position.z,
        ndcX: projected.x,
        ndcY: projected.y,
      };
    });
    return {
      marbles,
      markers: this.markerMesh.count,
      selected: this.selected,
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  private segmentDuration(): number {
    if (this.reducedMotion) return 0;
    return SEGMENT_MS[this.speed];
  }

  resetView(): void {
    this.orbit.azimuth = 0;
    this.polarTarget = this.flatBoard ? POLAR_FLAT : POLAR_ANGLED;
    this.orbit.zoom = 1;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  dispose(): void {
    this.stop();
    this.resizeObserver.disconnect();
    window.removeEventListener('resize', this.handleResize);
    window.removeEventListener('orientationchange', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.unbindPointerEvents();
    for (const item of this.disposables) item.dispose();
    disposeGlyphs();
    this.renderer.dispose();
  }

  // --- loop ----------------------------------------------------------------

  private tick = (now: number): void => {
    if (!this.running) return;
    const dt = Math.min(now - this.lastTime, 64);
    this.lastTime = now;

    this.updateAnimation(dt);
    this.updateBoardRotation(dt);
    this.updateTilt(dt);
    this.updateMarkers(now);
    this.updateSelection(now);
    this.updateCamera();
    this.updateCornerAnchor();

    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.tick);
  };

  private updateAnimation(dt: number): void {
    const animation = this.animation;
    if (!animation) return;
    const duration = this.segmentDuration();
    animation.elapsed += dt;

    const from = HOLES[animation.path[animation.segment]];
    const to = HOLES[animation.path[animation.segment + 1]];

    // Super mode jumps span many holes, so the arc and the time in the air both
    // grow with distance — a fixed hop height would skim flat across the board.
    const span = Math.hypot(to.x - from.x, to.z - from.z);
    const stretched = duration * Math.min(1 + span * 0.12, 2);
    const t = Math.min(animation.elapsed / stretched, 1);
    const eased = t * t * (3 - 2 * t);
    const lift = animation.kind === 'hop' ? Math.min(0.55 + span * 0.22, 2) : 0.22;

    animation.marble.position.x = from.x + (to.x - from.x) * eased;
    animation.marble.position.z = from.z + (to.z - from.z) * eased;
    animation.marble.position.y = MARBLE_Y + Math.sin(Math.PI * eased) * lift;

    if (t < 1) return;
    animation.segment++;
    animation.elapsed = 0;
    if (animation.segment >= animation.path.length - 1) {
      animation.marble.position.set(to.x, MARBLE_Y, to.z);
      this.animation = null;
      animation.done();
    }
  }

  private updateBoardRotation(dt: number): void {
    if (this.idleSpin && !this.reducedMotion) this.boardRotationTarget += dt * 0.00014;
    const delta = this.boardRotationTarget - this.boardRotation;
    if (Math.abs(delta) < 0.0005) {
      this.boardRotation = this.boardRotationTarget;
    } else {
      this.boardRotation += delta * Math.min(1, dt / 130);
    }
    this.boardGroup.rotation.y = this.boardRotation;
  }

  private updateMarkers(now: number): void {
    if (this.markers.length === 0) return;
    const pulse = 1 + Math.sin(now / 260) * 0.07;
    for (let i = 0; i < this.markers.length; i++) {
      const hole = HOLES[this.markers[i].hole];
      tmpMatrix.compose(
        tmpVector.set(hole.x, MARKER_Y, hole.z),
        tmpQuaternion.identity(),
        tmpScale.set(pulse, 1, pulse),
      );
      this.markerMesh.setMatrixAt(i, tmpMatrix);
    }
    this.markerMesh.instanceMatrix.needsUpdate = true;
  }

  private updateSelection(now: number): void {
    if (this.selected === null) return;
    const marble = this.marbles.get(this.selected);
    if (!marble) return;
    const beat = Math.sin(now / 220);
    marble.position.y = MARBLE_Y + 0.24 + beat * 0.05;
    if (this.selectionRing.visible) {
      const pulse = 1 + beat * 0.07;
      this.selectionRing.scale.set(pulse, 1, pulse);
      this.selectionRing.material.opacity = 0.86 + beat * 0.14;
    }
  }

  /**
   * Eases the tilt towards its target and reframes as it goes: a board seen flat
   * on covers more of the screen than one seen at an angle, so a fixed distance
   * would let it grow past the edges on the way down.
   */
  private updateTilt(dt: number): void {
    const delta = this.polarTarget - this.orbit.polar;
    if (Math.abs(delta) < 0.0004) this.orbit.polar = this.polarTarget;
    else this.orbit.polar += delta * Math.min(1, dt / 150);

    if (Number.isNaN(this.fittedPolar) || Math.abs(this.orbit.polar - this.fittedPolar) >= 0.002) {
      this.fitCamera();
      this.fittedPolar = this.orbit.polar;
    }
  }

  /** Projects the tracked corner and reports it when it has actually moved. */
  private updateCornerAnchor(): void {
    const corner = this.trackedCorner;
    if (!corner || !this.onCornerAnchorMove) return;

    this.camera.updateMatrixWorld();
    const centroid = CORNER_CENTROID[corner];
    tmpVector.set(centroid.x, PLATE_TOP, centroid.z);
    this.boardGroup.localToWorld(tmpVector);
    tmpVector.project(this.camera);

    // A threshold keeps this from touching the DOM on every single frame while
    // the board eases round to a new player.
    if (
      Math.abs(tmpVector.x - this.lastAnchor.x) < 0.004 &&
      Math.abs(tmpVector.y - this.lastAnchor.y) < 0.004
    ) {
      return;
    }
    this.lastAnchor = { x: tmpVector.x, y: tmpVector.y };
    this.onCornerAnchorMove({ x: tmpVector.x, y: tmpVector.y });
  }

  private updateCamera(): void {
    // Long lens when flat, wide when angled; see FOV_FLAT.
    const flatness = 1 - THREE.MathUtils.smoothstep(this.orbit.polar, POLAR_FLAT, FOV_BLEND_POLAR);
    const fov = FOV_ANGLED + (FOV_FLAT - FOV_ANGLED) * flatness;
    if (Math.abs(fov - this.camera.fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }

    const distance = this.orbit.distance * this.orbit.zoom;
    const sin = Math.sin(this.orbit.polar);
    this.camera.position.set(
      distance * sin * Math.sin(this.orbit.azimuth),
      distance * Math.cos(this.orbit.polar),
      distance * sin * Math.cos(this.orbit.azimuth),
    );
    this.camera.lookAt(0, 0, 0);
  }

  private handleResize = (): void => {
    // Guard against a zero-sized canvas (hidden tab, collapsed pane): an
    // aspect of 0/0 is NaN and would poison the projection matrix.
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fitCamera();
    this.updateCamera();
  };

  /**
   * Frames the board by measuring it rather than by trigonometry: project a
   * ring enclosing the plate, then scale the distance until it fits. A ring is
   * rotation-invariant, so the framing does not breathe as the board turns.
   * Three passes converge because projected size scales with 1/distance.
   */
  private fitCamera(): void {
    const radius = BOARD_RADIUS + 2 * PLATE_MARGIN;
    // The plate's underside matters: at the near edge it projects lower on
    // screen than the play surface, and clips off the bottom if ignored.
    const heights = [PLATE_TOP - PLATE_THICKNESS, PLATE_TOP, MARBLE_Y + MARBLE_RADIUS];
    const points: THREE.Vector3[] = [];
    for (const y of heights) {
      for (let i = 0; i < 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
      }
    }

    const zoom = this.orbit.zoom;
    this.orbit.zoom = 1;
    for (let pass = 0; pass < 3; pass++) {
      this.updateCamera();
      this.camera.updateMatrixWorld();
      let extent = 0;
      for (const point of points) {
        tmpVector.copy(point).project(this.camera);
        extent = Math.max(extent, Math.abs(tmpVector.x), Math.abs(tmpVector.y));
      }
      if (extent <= 0) break;
      this.orbit.distance *= extent / FRAMING;
    }
    this.orbit.zoom = zoom;
  }

  private handleVisibility = (): void => {
    if (document.hidden) this.stop();
    else this.start();
  };

  // --- input ---------------------------------------------------------------

  private bindPointerEvents(): void {
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    this.canvas.addEventListener('pointermove', this.handlePointerMove);
    this.canvas.addEventListener('pointerup', this.handlePointerUp);
    this.canvas.addEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', preventDefault);
  }

  private unbindPointerEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    this.canvas.removeEventListener('pointermove', this.handlePointerMove);
    this.canvas.removeEventListener('pointerup', this.handlePointerUp);
    this.canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', preventDefault);
  }

  /** Nearest hole to a screen position, in board-local space, or null. */
  private holeAtPointer(event: PointerEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObject(this.pickPlane, false);
    if (hits.length === 0) return null;

    const local = this.boardGroup.worldToLocal(hits[0].point.clone());
    let best = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < HOLE_COUNT; i++) {
      const dx = HOLES[i].x - local.x;
      const dz = HOLES[i].z - local.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    // Generous tap radius: fingers are wider than marbles.
    return bestDistance <= 0.62 * 0.62 ? best : null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    this.canvas.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.pointers.size >= 2) {
      this.beginCameraGesture();
      return;
    }

    const orbitModifier = event.button === 2 || event.shiftKey;
    if (orbitModifier) {
      this.gesture = 'camera';
      this.orbitStart = {
        x: event.clientX,
        y: event.clientY,
        azimuth: this.orbit.azimuth,
        polar: this.orbit.polar,
      };
      return;
    }

    this.gesture = 'tap';
    this.downHole = this.holeAtPointer(event);
    this.onPointerDownHole?.(this.downHole);
  };

  private beginCameraGesture(): void {
    this.gesture = 'camera';
    this.downHole = null;
    const [a, b] = [...this.pointers.values()];
    this.pinchStart = Math.hypot(a.x - b.x, a.y - b.y) * this.orbit.zoom;
    this.orbitStart = {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      azimuth: this.orbit.azimuth,
      polar: this.orbit.polar,
    };
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.gesture !== 'camera') return;

    if (this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const spread = Math.hypot(a.x - b.x, a.y - b.y);
      if (spread > 8 && this.pinchStart > 0) {
        this.orbit.zoom = THREE.MathUtils.clamp(this.pinchStart / spread, 0.55, 1.7);
      }
      this.applyOrbitDrag((a.x + b.x) / 2, (a.y + b.y) / 2);
    } else {
      this.applyOrbitDrag(event.clientX, event.clientY);
    }
  };

  private applyOrbitDrag(x: number, y: number): void {
    this.orbit.azimuth = this.orbitStart.azimuth - (x - this.orbitStart.x) * 0.006;

    // With the flat board chosen, flat is the whole point: the vertical part of
    // the drag is dropped so the board cannot be tipped back into a three
    // quarter view by a stray finger. Spinning and pinching still work.
    if (this.flatBoard) return;

    // Otherwise dragging reaches all the way flat, and retargets the rest so
    // the easing in `updateTilt` does not pull the board back to the setting.
    this.orbit.polar = THREE.MathUtils.clamp(
      this.orbitStart.polar + (y - this.orbitStart.y) * 0.004,
      POLAR_FLAT,
      1.05,
    );
    this.polarTarget = this.orbit.polar;
  }

  private handlePointerUp = (event: PointerEvent): void => {
    const wasTap = this.gesture === 'tap';
    const downHole = this.downHole;
    this.pointers.delete(event.pointerId);
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }

    if (this.pointers.size === 0) this.gesture = 'none';
    if (!wasTap) return;

    const upHole = this.holeAtPointer(event);
    const now = performance.now();
    if (upHole === null && downHole === null && now - this.lastTapAt < 320) {
      this.resetView();
    }
    this.lastTapAt = now;
    this.downHole = null;
    this.onPointerUpHole?.(upHole);
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 0) this.gesture = 'none';
    this.downHole = null;
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.orbit.zoom = THREE.MathUtils.clamp(
      this.orbit.zoom * (1 + Math.sign(event.deltaY) * 0.08),
      0.55,
      1.7,
    );
  };
}

function preventDefault(event: Event): void {
  event.preventDefault();
}
