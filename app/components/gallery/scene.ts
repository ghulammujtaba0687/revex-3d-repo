import * as THREE from 'three';
import {Sky} from 'three/examples/jsm/objects/Sky.js';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import {EffectComposer} from 'three/examples/jsm/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/examples/jsm/postprocessing/RenderPass.js';
import {UnrealBloomPass} from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import {OutputPass} from 'three/examples/jsm/postprocessing/OutputPass.js';
import type {Gender, GalleryProduct} from './types';

/** Display mannequins built with MPFB2 (CC0); meshes are named Body, Shirt and Pants. */
const POSES = ['relaxed', 'hand_on_hip', 'pocket'] as const;
type Pose = (typeof POSES)[number];
const mannequinUrl = (gender: Gender, pose: Pose) =>
  `/models/mannequin-${gender === 'women' ? 'female' : 'male'}-${pose}.glb`;

/**
 * How a mannequin's tee maps onto its texture, measured from the mesh itself: for the
 * front and back torso, a linear map from body-space (x, y in metres) to texture pixels,
 * plus where the shoulder line is and how wide the torso is.
 */
interface ShirtFit {
  /** torso triangles facing front / back: per corner [x, y, u, v] (body metres, UV 0..1) */
  front: number[][][];
  back: number[][][];
  /** height of the neckline at the centre of the front / back */
  neckY: {front: number; back: number};
  torsoWidth: number;
}

// ---------- layout (metres) ----------
const R = 14; // rotunda radius
const WALL_H = 7.2;
const SEGMENTS = 12;
const ARCH_HALF = 2.7; // half width of each arched opening
const ARCH_SPRING = 2.6; // height where the arch curve starts
const TERRACE_R = R + 6.5;
const RAIL_R = TERRACE_R - 0.5;
const FOUNTAIN_R = 3.6;
const EYE = 1.65;
const START = new THREE.Vector3(R + 4.6, EYE, 0);
/**
 * Late-afternoon sun, 17° above the horizon. It sits off to the right of the entrance
 * view, so it slants through the arches on that side without glaring over the sign.
 */
const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(73),
  THREE.MathUtils.degToRad(197.5),
);

export const ACCENT = 0xf4a21d;
const CHARCOAL = 0x2d2d2f;

export interface SceneCallbacks {
  onProgress(pct: number): void;
  onReady(): void;
  onHover(product: GalleryProduct | null): void;
  onSelect(product: GalleryProduct): void;
  onTourEnd?(): void;
}

interface Figure {
  product: GalleryProduct;
  root: THREE.Group; // pedestal + body, rotates as a turntable
  body: THREE.Group | null;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshStandardMaterial>;
  hit: THREE.Mesh;
  /** garment colour sampled from the product photo */
  shirtColor: THREE.Color;
  pantsColor: THREE.Color;
  isTrousers: boolean;
  front: HTMLImageElement | null;
  back: HTMLImageElement | null;
  /** per-mannequin shirt textures (the two mannequins have different UV layouts) */
  shirtTextures: Partial<Record<Gender, THREE.Texture>>;
  /** materials owned by the current body, disposed when it is replaced */
  ownMaterials: THREE.Material[];
  print: THREE.Texture | null;
  isModel: boolean;
  pose: Pose;
  facing: number;
}

interface Obstacle {
  x: number;
  z: number;
  r: number;
}

export class GalleryScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private yaw = new THREE.Object3D();
  private pitch = 0;
  private clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;

  private figures: Figure[] = [];
  private templates: Record<Gender, Partial<Record<Pose, THREE.Object3D>>> = {women: {}, men: {}};
  private templateLoads: Partial<Record<Gender, Promise<void>>> = {};
  private shirtFits: Partial<Record<Gender, ShirtFit>> = {};
  private gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private marble = new THREE.MeshStandardMaterial({color: 0xf1eee8, roughness: 0.3});
  private obstacles: Obstacle[] = [];
  private sculpture = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2(0, 0);
  private hovered: Figure | null = null;

  // input
  private enabled = false;
  private keys = new Set<string>();
  private joy = {x: 0, y: 0};
  private look = {dx: 0, dy: 0};
  private velocity = new THREE.Vector3();
  private drag: {id: number; x: number; y: number; moved: number; t: number} | null =
    null;
  private usePointerForHover = true;

  // intro: aerial orbit, then a cinematic tour down to the entrance
  private mode: 'orbit' | 'tour' | 'walk' = 'orbit';
  private orbitAngle = 0.6;
  private tour: {
    curve: THREE.CatmullRomCurve3;
    t: number;
    duration: number;
    endLook: THREE.Vector3;
    endYaw: number;
  } | null = null;
  private signPos = new THREE.Vector3();

  // atmosphere + product spotlight
  private composer: EffectComposer | null = null;
  private shafts: THREE.Mesh[] = [];
  private dust: THREE.Points | null = null;
  private spot = new THREE.SpotLight(0xffe4bf, 0, 9, 0.4, 0.7, 1.4);
  private focused: Figure | null = null;

  private gender: Gender;
  private labelEl: HTMLElement | null;
  private cb: SceneCallbacks;
  private container: HTMLElement;
  private resizeObserver: ResizeObserver;
  private cleanups: Array<() => void> = [];

  constructor(
    container: HTMLElement,
    opts: {
      products: GalleryProduct[];
      logoUrl: string;
      gender: Gender;
      mobile: boolean;
      labelEl: HTMLElement | null;
      callbacks: SceneCallbacks;
    },
  ) {
    this.container = container;
    this.gender = opts.gender;
    this.labelEl = opts.labelEl;
    this.cb = opts.callbacks;
    this.usePointerForHover = !opts.mobile;

    const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: 'high-performance'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.mobile ? 1.5 : 1.75));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.86;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);

    this.camera = new THREE.PerspectiveCamera(
      65,
      container.clientWidth / container.clientHeight,
      0.1,
      2500,
    );
    this.yaw.add(this.camera);
    this.scene.add(this.yaw);
    this.scene.fog = new THREE.Fog(0xead2b4, 70, 400);

    this.buildSkyAndLight(opts.mobile);
    this.buildArchitecture();
    this.buildFountain();
    this.buildTerrace();
    this.buildWelcomeSign(opts.logoUrl);
    this.buildFigures(opts.products);
    this.buildAtmosphere(opts.mobile);
    this.scene.add(this.spot, this.spot.target);

    // a gentle glow on the chandelier, accents and sun glints; skipped on phones
    if (!opts.mobile) {
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      composer.addPass(
        new UnrealBloomPass(
          new THREE.Vector2(container.clientWidth / 2, container.clientHeight / 2),
          0.22,
          0.4,
          2.4,
        ),
      );
      composer.addPass(new OutputPass());
      this.composer = composer;
    }

    this.placeOrbitCamera();
    this.bindInput();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    this.loop();
  }

  // ======================= public API =======================

  /** Sweeps from the aerial view around and down the rotunda to the entrance. */
  enter() {
    const from = this.yaw.position.clone();
    const a0 = Math.atan2(from.z, from.x);
    const sweep = shortestAngle(a0, 0);
    const r0 = Math.hypot(from.x, from.z);
    const pts = [from];
    const steps = 6;
    for (let k = 1; k <= steps; k++) {
      const f = k / steps;
      const a = a0 + sweep * easeInOutCubic(f);
      const r = THREE.MathUtils.lerp(r0, TERRACE_R + 3, 1 - Math.pow(1 - f, 2));
      const y = THREE.MathUtils.lerp(from.y, 2.4, Math.pow(f, 0.8));
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    pts.push(START.clone());

    const endYaw = this.entranceYaw();
    const endLook = START.clone().add(
      new THREE.Vector3(-Math.sin(endYaw), -0.04, -Math.cos(endYaw)).multiplyScalar(8),
    );
    this.tour = {
      curve: new THREE.CatmullRomCurve3(pts, false, 'centripetal'),
      t: 0,
      duration: 7 + Math.abs(sweep) * 1.2,
      endLook,
      endYaw,
    };
    this.mode = 'tour';
  }

  skipTour() {
    if (this.tour) this.tour.t = 1;
  }

  /**
   * Faces the hall but turns just enough that the welcome sign sits inside the left of the
   * frame. On narrow (portrait) screens that turn would hide the hall, so it stays on the hall.
   */
  private entranceYaw() {
    const hall = Math.PI / 2;
    const toSign = Math.atan2(-(this.signPos.x - START.x), -(this.signPos.z - START.z));
    const offset = shortestAngle(hall, toSign);
    const halfFov = Math.atan(
      Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect,
    );
    const turn = Math.max(0, Math.abs(offset) - (halfFov - THREE.MathUtils.degToRad(12)));
    if (turn > 0.45) return hall;
    return hall + Math.sign(offset) * turn;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.joy.x = this.joy.y = 0;
      this.drag = null;
    }
  }

  setGender(gender: Gender) {
    if (gender === this.gender) return;
    this.gender = gender;
    this.loadTemplates(gender).then(() => {
      if (this.disposed || this.gender !== gender) return;
      for (const f of this.figures) this.dress(f);
    });
  }

  /** Loads every pose of one fit's mannequin once; onEach fires as each file settles. */
  private loadTemplates(gender: Gender, onEach?: () => void) {
    this.templateLoads[gender] ??= Promise.all(
      POSES.map(
        (pose) =>
          new Promise<void>((resolve) => {
            this.gltfLoader.load(
              mannequinUrl(gender, pose),
              (gltf) => {
                this.templates[gender][pose] = gltf.scene;
                this.shirtFits[gender] ??= measureShirt(gltf.scene) ?? undefined;
                onEach?.();
                resolve();
              },
              undefined,
              () => {
                onEach?.();
                resolve();
              },
            );
          }),
      ),
    ).then(() => undefined);
    return this.templateLoads[gender];
  }

  /** (Re)builds a figure's body for the current gender, dressed in its product. */
  private dress(f: Figure) {
    if (f.isModel) return;
    if (f.body) {
      f.root.remove(f.body);
      if (f.ownMaterials.length) f.ownMaterials.forEach((m) => m.dispose());
      // procedural bodies own their geometry; mannequin clones share the template's
      else disposeObject(f.body, false);
      f.ownMaterials = [];
    }

    const poses = this.templates[this.gender];
    const template = poses[f.pose] ?? POSES.map((p) => poses[p]).find(Boolean);
    if (!template) {
      f.print ??= f.front ? makePrintTexture(f.front, this.renderer) : null;
      f.body = buildMannequin(this.gender, f.shirtColor, f.print);
      f.root.add(f.body);
      return;
    }

    let map: THREE.Texture | null = null;
    const fit = this.shirtFits[this.gender];
    if (!f.isTrousers && f.front && fit) {
      map = f.shirtTextures[this.gender] ??= makeShirtTexture(
        fit,
        f.front,
        f.back ?? f.front,
        f.shirtColor,
        this.renderer,
      );
    }
    const shirt = new THREE.MeshStandardMaterial({
      color: map ? 0xffffff : f.isTrousers ? 0xf2f0ec : f.shirtColor,
      map,
      roughness: 0.88,
      side: THREE.DoubleSide,
    });
    const pants = new THREE.MeshStandardMaterial({
      color: f.pantsColor,
      roughness: 0.86,
      side: THREE.DoubleSide,
    });
    f.ownMaterials = [shirt, pants];

    const body = template.clone(true);
    const hairMeshes: THREE.Mesh[] = [];
    body.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (mesh.name.startsWith('Shirt')) mesh.material = shirt;
      else if (mesh.name.startsWith('Pants')) mesh.material = pants;
      else if (mesh.name.startsWith('Hair')) hairMeshes.push(mesh);
      else mesh.material = this.marble;
    });
    for (const mesh of hairMeshes) {
      const [strands, mass] = this.hairMaterials(mesh.material as THREE.MeshStandardMaterial);
      mesh.material = strands;
      mesh.receiveShadow = false;
      // a dense underlayer on the same cards hides the scalp between the strands
      const under = new THREE.Mesh(mesh.geometry, mass);
      under.position.copy(mesh.position);
      under.quaternion.copy(mesh.quaternion);
      under.scale.copy(mesh.scale);
      under.renderOrder = -1;
      mesh.parent!.add(under);
    }

    const group = new THREE.Group();
    group.position.y = 0.55; // pedestal top
    group.add(body);
    f.body = group;
    f.root.add(group);
  }

  /** per hairstyle (keyed by its strand texture) */
  private hairMats = new Map<string, [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial]>();

  /** Hair materials shared by every figure with this hairstyle: crisp strands on top of a solid, darker mass. */
  private hairMaterials(source: THREE.MeshStandardMaterial) {
    const key = source.map?.uuid ?? source.uuid;
    let mats = this.hairMats.get(key);
    if (!mats) {
      const strands = new THREE.MeshStandardMaterial({
        map: source.map,
        color: 0xb08a6a,
        roughness: 0.55,
        alphaTest: 0.35,
        alphaToCoverage: true,
        side: THREE.DoubleSide,
      });
      const mass = new THREE.MeshStandardMaterial({
        map: source.map,
        color: 0x5a3b26,
        roughness: 0.8,
        // low enough to fill gaps between strands, high enough that the faint wisps at
        // the hairline don't turn into a ragged dark edge on the forehead
        alphaTest: 0.25,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 2,
        polygonOffsetUnits: 2,
      });
      mats = [strands, mass];
      this.hairMats.set(key, mats);
    }
    return mats;
  }

  setMove(x: number, y: number) {
    this.joy.x = x;
    this.joy.y = y;
  }

  addLook(dx: number, dy: number) {
    this.look.dx += dx;
    this.look.dy += dy;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.cleanups.forEach((fn) => fn());
    disposeObject(this.scene, true);
    this.envTarget?.dispose();
    this.pmrem.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ======================= scene building =======================

  private buildSkyAndLight(mobile: boolean) {
    const sky = new Sky();
    sky.scale.setScalar(2000);
    const u = sky.material.uniforms;
    // golden hour: a low sun in a warm, hazy sky
    u.turbidity.value = 7;
    u.rayleigh.value = 2.4;
    u.mieCoefficient.value = 0.006;
    u.mieDirectionalG.value = 0.86;
    const sun = SUN_DIR.clone();
    u.sunPosition.value.copy(sun);
    // The sun disc is ~19000x brighter than the sky; in the half-float bloom buffer that
    // overflows to Infinity and the blur turns the whole frame black, so cap it.
    sky.material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        'gl_FragColor = vec4( texColor, 1.0 );',
        'gl_FragColor = vec4( min( texColor, vec3( 2.7 ) ), 1.0 );',
      );
    };
    this.scene.add(sky);

    // Image-based lighting from a soft sky-to-sand gradient. (Baking the Sky shader itself
    // overflows half-float targets around the sun disc and turns every lit surface black.)
    const envScene = new THREE.Scene();
    const envGeo = new THREE.SphereGeometry(40, 32, 16);
    const top = new THREE.Color(0x8fb2d4);
    const horizon = new THREE.Color(0xf6d2a2);
    const ground = new THREE.Color(0xb0967a);
    const colors: number[] = [];
    const pos = envGeo.attributes.position;
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const h = pos.getY(i) / 40;
      if (h >= 0) c.copy(horizon).lerp(top, Math.pow(h, 0.6));
      else c.copy(horizon).lerp(ground, Math.min(1, -h * 2.5));
      colors.push(c.r, c.g, c.b);
    }
    envGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const envMat = new THREE.MeshBasicMaterial({vertexColors: true, side: THREE.BackSide});
    envScene.add(new THREE.Mesh(envGeo, envMat));
    this.envTarget = this.pmrem.fromScene(envScene, 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.85;
    envGeo.dispose();
    envMat.dispose();

    const hemi = new THREE.HemisphereLight(0xf0dcc4, 0x8a7360, 0.6);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffc98c, 3.1);
    dir.position.copy(sun).multiplyScalar(60);
    dir.castShadow = true;
    const size = mobile ? 1024 : 2048;
    dir.shadow.mapSize.set(size, size);
    const s = TERRACE_R + 2;
    Object.assign(dir.shadow.camera, {left: -s, right: s, top: s, bottom: -s, near: 1, far: 160});
    dir.shadow.camera.updateProjectionMatrix();
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.03;
    this.scene.add(dir);
  }

  private buildArchitecture() {
    const plasterTex = makePlasterTexture();
    plasterTex.repeat.set(0.32, 0.32);
    const plaster = new THREE.MeshStandardMaterial({
      color: 0xf0ebe3,
      map: plasterTex,
      roughness: 0.93,
    });
    const pierTex = plasterTex.clone();
    pierTex.repeat.set(2.5, 2.2);
    const pierMat = new THREE.MeshStandardMaterial({color: 0xf0ebe3, map: pierTex, roughness: 0.93});
    const marble = new THREE.MeshStandardMaterial({color: 0xf5f2ed, roughness: 0.3});
    const charcoal = new THREE.MeshStandardMaterial({color: CHARCOAL, roughness: 0.4, metalness: 0.35});
    const accent = new THREE.MeshStandardMaterial({
      color: ACCENT,
      roughness: 0.32,
      metalness: 0.65,
      emissive: ACCENT,
      emissiveIntensity: 0.08,
    });

    // inner polished marble floor + accent inlay rings
    const innerFloorTex = makeMarbleFloorTexture();
    innerFloorTex.repeat.set((2 * R) / 3, (2 * R) / 3);
    const innerFloor = new THREE.Mesh(
      new THREE.CircleGeometry(R + 0.4, 96),
      new THREE.MeshStandardMaterial({
        map: innerFloorTex,
        color: 0xd9d2c7,
        roughness: 0.26,
        metalness: 0.05,
      }),
    );
    innerFloor.rotation.x = -Math.PI / 2;
    innerFloor.position.y = 0.004;
    innerFloor.receiveShadow = true;
    this.scene.add(innerFloor);

    for (const [radius, width] of [
      [FOUNTAIN_R + 0.9, 0.08],
      [7.9, 0.06],
      [R - 1.0, 0.1],
    ] as const) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius, radius + width, 160), accent);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.008;
      ring.receiveShadow = true;
      this.scene.add(ring);
    }

    // arched wall panels
    const chord = 2 * R * Math.sin(Math.PI / SEGMENTS);
    const shape = new THREE.Shape();
    shape.moveTo(-chord / 2, 0);
    shape.lineTo(-ARCH_HALF, 0);
    shape.lineTo(-ARCH_HALF, ARCH_SPRING);
    shape.absarc(0, ARCH_SPRING, ARCH_HALF, Math.PI, 0, true);
    shape.lineTo(ARCH_HALF, 0);
    shape.lineTo(chord / 2, 0);
    shape.lineTo(chord / 2, WALL_H);
    shape.lineTo(-chord / 2, WALL_H);
    shape.closePath();
    const panelGeo = new THREE.ExtrudeGeometry(shape, {
      depth: 0.7,
      bevelEnabled: false,
      curveSegments: 28,
    });
    panelGeo.translate(0, 0, -0.35);

    const pierGeo = new THREE.CylinderGeometry(0.82, 0.82, WALL_H, 32);
    const pierBaseGeo = new THREE.CylinderGeometry(1.02, 1.08, 0.38, 32);
    const pierCapGeo = new THREE.CylinderGeometry(1.0, 0.86, 0.3, 32);
    const vaseGeo = makeVaseGeometry();
    const plinthGeo = new THREE.CylinderGeometry(0.42, 0.48, 0.9, 32);
    const bandGeo = new THREE.TorusGeometry(0.3, 0.025, 8, 40);

    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2;
      const panel = new THREE.Mesh(panelGeo, plaster);
      panel.position.set(Math.cos(theta) * R, 0, Math.sin(theta) * R);
      panel.rotation.y = -theta - Math.PI / 2;
      panel.castShadow = panel.receiveShadow = true;
      this.scene.add(panel);

      const pa = theta + Math.PI / SEGMENTS;
      const px = Math.cos(pa) * R;
      const pz = Math.sin(pa) * R;
      const pier = new THREE.Mesh(pierGeo, pierMat);
      pier.position.set(px, WALL_H / 2, pz);
      pier.castShadow = pier.receiveShadow = true;
      this.scene.add(pier);
      const base = new THREE.Mesh(pierBaseGeo, marble);
      base.position.set(px, 0.19, pz);
      base.receiveShadow = true;
      this.scene.add(base);
      const cap = new THREE.Mesh(pierCapGeo, marble);
      cap.position.set(px, WALL_H - 0.15, pz);
      this.scene.add(cap);
      this.obstacles.push({x: px, z: pz, r: 1.1});

      // a vase on a plinth in front of every pier (skip the two flanking the entrance)
      if (i === 0 || i === SEGMENTS - 1) continue;
      const vr = R - 1.9;
      const vx = Math.cos(pa) * vr;
      const vz = Math.sin(pa) * vr;
      const plinth = new THREE.Mesh(plinthGeo, marble);
      plinth.position.set(vx, 0.45, vz);
      plinth.castShadow = plinth.receiveShadow = true;
      this.scene.add(plinth);
      const vase = new THREE.Mesh(vaseGeo, i % 2 ? charcoal : marble);
      vase.position.set(vx, 0.9, vz);
      vase.castShadow = true;
      this.scene.add(vase);
      const band = new THREE.Mesh(bandGeo, accent);
      band.rotation.x = Math.PI / 2;
      band.position.set(vx, 1.38, vz);
      this.scene.add(band);
      this.obstacles.push({x: vx, z: vz, r: 0.75});
    }

    // cornice + accent band
    const cornice = new THREE.Mesh(new THREE.TorusGeometry(R, 0.5, 12, 128), plaster);
    cornice.rotation.x = Math.PI / 2;
    cornice.position.y = WALL_H;
    cornice.castShadow = true;
    this.scene.add(cornice);
    const band = new THREE.Mesh(new THREE.TorusGeometry(R - 0.42, 0.05, 8, 160), accent);
    band.rotation.x = Math.PI / 2;
    band.position.y = WALL_H - 0.55;
    this.scene.add(band);

    // glass dome with charcoal ribs
    const domeR = R + 0.25;
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(domeR, 64, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xdfeaf3,
        transparent: true,
        opacity: 0.14,
        roughness: 0.05,
        metalness: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    dome.scale.y = 0.58;
    dome.position.y = WALL_H;
    this.scene.add(dome);
    const ribs = new THREE.Group();
    const ribGeo = new THREE.TorusGeometry(domeR, 0.08, 6, 64, Math.PI);
    for (let i = 0; i < SEGMENTS / 2; i++) {
      const rib = new THREE.Mesh(ribGeo, charcoal);
      rib.rotation.y = (i / (SEGMENTS / 2)) * Math.PI;
      ribs.add(rib);
    }
    for (const t of [0.35, 0.7]) {
      const lat = new THREE.Mesh(
        new THREE.TorusGeometry(domeR * Math.cos(Math.asin(t)), 0.06, 6, 128),
        charcoal,
      );
      lat.rotation.x = Math.PI / 2;
      lat.position.y = domeR * t;
      ribs.add(lat);
    }
    ribs.scale.y = 0.58;
    ribs.position.y = WALL_H;
    this.scene.add(ribs);

    // chandelier hanging from the crown of the dome
    const crown = WALL_H + domeR * 0.58;
    const chand = new THREE.Group();
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, crown - 11.6, 8), charcoal);
    rod.position.y = (crown + 11.6) / 2;
    chand.add(rod);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(1.9, 0.06, 8, 64), accent);
    hoop.rotation.x = Math.PI / 2;
    hoop.position.y = 11.6;
    chand.add(hoop);
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff3dc,
      emissive: 0xffd9a0,
      emissiveIntensity: 5,
    });
    const bulbGeo = new THREE.SphereGeometry(0.11, 12, 8);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const b = new THREE.Mesh(bulbGeo, bulbMat);
      b.position.set(Math.cos(a) * 1.9, 11.45, Math.sin(a) * 1.9);
      chand.add(b);
    }
    const glow = new THREE.PointLight(0xffd9a0, 60, 26, 2);
    glow.position.y = 11.2;
    chand.add(glow);
    this.scene.add(chand);
  }

  private buildFountain() {
    const charcoal = new THREE.MeshStandardMaterial({color: CHARCOAL, roughness: 0.45, metalness: 0.3});
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(FOUNTAIN_R, FOUNTAIN_R + 0.15, 0.5, 64), charcoal);
    basin.position.y = 0.25;
    basin.castShadow = basin.receiveShadow = true;
    this.scene.add(basin);
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(FOUNTAIN_R - 0.22, 64),
      new THREE.MeshStandardMaterial({color: 0x24617c, roughness: 0.06, metalness: 0.15}),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.46;
    this.scene.add(water);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(FOUNTAIN_R - 0.08, 0.07, 8, 96),
      new THREE.MeshStandardMaterial({color: ACCENT, metalness: 0.7, roughness: 0.3}),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.51;
    this.scene.add(rim);

    const plinth = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.7, 1.1, 32),
      new THREE.MeshStandardMaterial({color: 0xf5f2ed, roughness: 0.3}),
    );
    plinth.position.y = 0.95;
    plinth.castShadow = true;
    this.scene.add(plinth);

    // faceted monolith with glowing accent seams
    const geo = new THREE.IcosahedronGeometry(1.45, 1);
    const stone = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({color: 0x232326, roughness: 0.28, metalness: 0.7, flatShading: true}),
    );
    stone.castShadow = true;
    const seams = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({color: ACCENT}),
    );
    seams.scale.setScalar(1.002);
    this.sculpture.add(stone, seams);
    this.sculpture.scale.set(1, 1.38, 1);
    this.sculpture.position.y = 3.35;
    this.scene.add(this.sculpture);
    this.obstacles.push({x: 0, z: 0, r: FOUNTAIN_R + 0.2});
  }

  private buildTerrace() {
    const travTex = makeTravertineTexture();
    travTex.repeat.set((2 * TERRACE_R) / 4, (2 * TERRACE_R) / 4);
    const terrace = new THREE.Mesh(
      new THREE.RingGeometry(R - 0.2, TERRACE_R, 128, 1),
      new THREE.MeshStandardMaterial({map: travTex, roughness: 0.8}),
    );
    terrace.rotation.x = -Math.PI / 2;
    terrace.receiveShadow = true;
    this.scene.add(terrace);

    // entrance path (along +x)
    const path = new THREE.Mesh(
      new THREE.PlaneGeometry(TERRACE_R - R + 1.2, 3),
      new THREE.MeshStandardMaterial({color: 0x4a4a4e, roughness: 0.55, metalness: 0.1}),
    );
    path.rotation.x = -Math.PI / 2;
    path.position.set((TERRACE_R + R) / 2 - 0.4, 0.014, 0);
    path.receiveShadow = true;
    this.scene.add(path);

    const cliff = new THREE.Mesh(
      new THREE.CylinderGeometry(TERRACE_R + 0.05, TERRACE_R + 2.5, 4, 96, 1, true),
      new THREE.MeshStandardMaterial({color: 0xcdbfa8, roughness: 0.95}),
    );
    cliff.position.y = -2;
    this.scene.add(cliff);

    const sea = new THREE.Mesh(
      new THREE.CircleGeometry(1500, 64),
      new THREE.MeshStandardMaterial({color: 0x2f6f8d, roughness: 0.14, metalness: 0.08}),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -3.6;
    this.scene.add(sea);

    // balustrade
    const balusterGeo = makeBalusterGeometry();
    const count = Math.floor((2 * Math.PI * RAIL_R) / 0.36);
    const balusters = new THREE.InstancedMesh(
      balusterGeo,
      new THREE.MeshStandardMaterial({color: 0xf2ede5, roughness: 0.6}),
      count,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * RAIL_R, 0, Math.sin(a) * RAIL_R);
      balusters.setMatrixAt(i, m);
    }
    balusters.castShadow = true;
    this.scene.add(balusters);
    const rail = new THREE.Mesh(
      new THREE.TorusGeometry(RAIL_R, 0.13, 8, 200),
      new THREE.MeshStandardMaterial({color: CHARCOAL, roughness: 0.4, metalness: 0.3}),
    );
    rail.rotation.x = Math.PI / 2;
    rail.position.y = 1.05;
    rail.castShadow = true;
    this.scene.add(rail);
    const plinth = new THREE.Mesh(
      new THREE.TorusGeometry(RAIL_R, 0.12, 6, 200),
      new THREE.MeshStandardMaterial({color: 0xe6dfd4, roughness: 0.8}),
    );
    plinth.rotation.x = Math.PI / 2;
    plinth.position.y = 0.06;
    this.scene.add(plinth);
  }

  /** Shafts of low sun through the arches that face it, and dust drifting in the light. */
  private buildAtmosphere(mobile: boolean) {
    const travel = SUN_DIR.clone().negate(); // the direction sunlight travels
    const sunAz = Math.atan2(SUN_DIR.z, SUN_DIR.x);
    const mat = new THREE.MeshBasicMaterial({
      map: makeShaftTexture(),
      color: 0xffd6a0,
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const length = 12;
    const flat = new THREE.PlaneGeometry(ARCH_HALF * 1.9, length).rotateX(-Math.PI / 2);
    flat.translate(0, 0, length / 2);
    const upright = new THREE.PlaneGeometry(ARCH_HALF * 1.9, length)
      .rotateX(-Math.PI / 2)
      .rotateZ(Math.PI / 2)
      .translate(0, 0, length / 2);
    for (let i = 0; i < SEGMENTS; i++) {
      const theta = (i / SEGMENTS) * Math.PI * 2;
      if (Math.abs(shortestAngle(theta, sunAz)) > 0.7) continue;
      const shaft = new THREE.Group();
      shaft.position.set(Math.cos(theta) * (R + 0.4), 2.7, Math.sin(theta) * (R + 0.4));
      shaft.lookAt(shaft.position.clone().add(travel));
      for (const geo of [flat, upright]) {
        const m = new THREE.Mesh(geo, mat.clone());
        m.renderOrder = 2;
        shaft.add(m);
        this.shafts.push(m);
      }
      this.scene.add(shaft);
    }
    mat.dispose();

    const count = mobile ? 220 : 520;
    const pos = new Float32Array(count * 3);
    const rand = rng(11);
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * (R - 1.5);
      pos.set([Math.cos(a) * r, 0.3 + rand() * 7, Math.sin(a) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        map: makeDotTexture(),
        color: 0xffe6c0,
        size: 0.045,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(this.dust);
  }

  private buildWelcomeSign(logoUrl: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 1024;
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;

    const draw = (logo: HTMLImageElement | null) => {
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 768, 1024);
      ctx.strokeStyle = '#F4A21D';
      ctx.lineWidth = 5;
      ctx.strokeRect(36, 36, 696, 952);
      if (logo) {
        ctx.save();
        roundRect(ctx, 234, 150, 300, 300, 28);
        ctx.clip();
        ctx.drawImage(logo, 234, 150, 300, 300);
        ctx.restore();
      }
      ctx.fillStyle = '#2d2d2f';
      ctx.textAlign = 'center';
      ctx.font = "300 78px 'Josefin Sans', 'Helvetica Neue', sans-serif";
      spacedText(ctx, 'RAVEX', 384, 560, 26);
      ctx.fillStyle = '#F4A21D';
      ctx.fillRect(334, 600, 100, 3);
      ctx.fillStyle = '#2d2d2f';
      ctx.font = "400 30px 'Josefin Sans', 'Helvetica Neue', sans-serif";
      spacedText(ctx, 'THE 3D GALLERY', 384, 680, 9);
      ctx.fillStyle = '#F4A21D';
      ctx.font = "600 30px 'Josefin Sans', 'Helvetica Neue', sans-serif";
      spacedText(ctx, 'STEP INSIDE', 384, 880, 8);
      tex.needsUpdate = true;
    };
    draw(null);
    const img = new Image();
    img.onload = () => {
      const redraw = () => !this.disposed && draw(img);
      if (document.fonts?.ready) document.fonts.ready.then(redraw);
      else redraw();
    };
    img.src = logoUrl;

    const white = new THREE.MeshStandardMaterial({color: 0xfafafa, roughness: 0.6});
    const face = new THREE.MeshStandardMaterial({map: tex, roughness: 0.55});
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.0, 0.06), [
      white,
      white,
      white,
      white,
      face,
      white,
    ]);
    board.castShadow = true;
    const easel = new THREE.Group();
    board.position.y = 1.75;
    board.rotation.x = -0.1;
    easel.add(board);
    const legMat = new THREE.MeshStandardMaterial({color: 0xb08d63, roughness: 0.7});
    const legGeo = new THREE.CylinderGeometry(0.035, 0.035, 2.9, 8);
    for (const [x, z, rx, rz] of [
      [-0.55, 0.15, -0.12, -0.08],
      [0.55, 0.15, -0.12, 0.08],
      [0, -0.55, 0.28, 0],
    ]) {
      const leg = new THREE.Mesh(legGeo, legMat);
      leg.position.set(x, 1.4, z);
      leg.rotation.set(rx, 0, rz);
      leg.castShadow = true;
      easel.add(leg);
    }
    const a = 0.2;
    const r = R + 3.1;
    easel.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    easel.lookAt(START.x + 1.5, 0, START.z - 1.2);
    this.scene.add(easel);
    this.obstacles.push({x: easel.position.x, z: easel.position.z, r: 0.9});
    this.signPos.copy(easel.position);
  }

  private buildFigures(products: GalleryProduct[]) {
    const pedestalMat = new THREE.MeshStandardMaterial({color: 0xf6f3ee, roughness: 0.28});
    const pedestalGeo = new THREE.CylinderGeometry(0.85, 0.95, 0.55, 48);
    const ringGeo = new THREE.TorusGeometry(0.86, 0.028, 8, 64);
    const hitGeo = new THREE.CylinderGeometry(0.7, 0.7, 2.6, 12);
    const hitMat = new THREE.MeshBasicMaterial({transparent: true, opacity: 0, depthWrite: false});

    const slots = figureSlots(products.length);
    const imageLoader = new THREE.ImageLoader();
    imageLoader.setCrossOrigin('anonymous');
    const gltfLoader = this.gltfLoader;

    const loadImage = (url: string | null) =>
      new Promise<HTMLImageElement | null>((resolve) => {
        if (!url) return resolve(null);
        imageLoader.load(sizedImage(url, 900), resolve, undefined, () => resolve(null));
      });

    // the current fit's mannequin poses + one task per product
    const total = products.length + POSES.length;
    let done = 0;
    let ready = false;
    const tick = () => {
      done += 1;
      this.cb.onProgress(Math.round((done / total) * 100));
    };
    const finish = () => {
      if (ready || this.disposed) return;
      ready = true;
      this.cb.onProgress(100);
      this.cb.onReady();
    };
    // never leave the visitor stuck on the loader
    const safety = window.setTimeout(finish, 15000);
    this.cleanups.push(() => window.clearTimeout(safety));

    const templatesLoaded = this.loadTemplates(this.gender, tick);
    const productTasks: Promise<void>[] = [];

    products.forEach((product, i) => {
      const slot = slots[i];
      const root = new THREE.Group();
      root.position.set(slot.x, 0, slot.z);
      const facing = Math.atan2(-slot.x, -slot.z); // face the centre
      root.rotation.y = facing;
      this.scene.add(root);

      const pedestal = new THREE.Mesh(pedestalGeo, pedestalMat);
      pedestal.position.y = 0.275;
      pedestal.castShadow = pedestal.receiveShadow = true;
      root.add(pedestal);
      const ringMat = new THREE.MeshStandardMaterial({
        color: ACCENT,
        metalness: 0.6,
        roughness: 0.3,
        emissive: ACCENT,
        emissiveIntensity: 0.1,
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.56;
      root.add(ring);

      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 1.4;
      hit.userData.figureIndex = i;
      root.add(hit);

      const isTrousers = /trouser|pant|jogger|cargo/i.test(
        `${product.productType ?? ''} ${product.title}`,
      );
      const figure: Figure = {
        product,
        root,
        body: null,
        ring,
        hit,
        shirtColor: new THREE.Color(0xdddddd),
        pantsColor: new THREE.Color(0x1f1f22),
        isTrousers,
        front: null,
        back: null,
        shirtTextures: {},
        ownMaterials: [],
        print: null,
        isModel: false,
        pose: POSES[i % POSES.length],
        facing,
      };
      this.figures.push(figure);
      this.obstacles.push({x: slot.x, z: slot.z, r: 1.15});

      const {front, back} = pickFlatLays(product);
      const loadPhotos = Promise.all([loadImage(front), loadImage(back)]).then(([f, b]) => {
        // show the side carrying the main artwork on the chest, where visitors look first
        const swap = f && b && designScore(b) > designScore(f) * 1.2;
        figure.front = swap ? b : f;
        figure.back = swap ? f : b;
        if (f && isTrousers) figure.pantsColor = sampleGarmentColor(f, TROUSER_SAMPLES);
        else if (f) figure.shirtColor = sampleShirtColor(f);
      });

      const loadOwnModel = () =>
        new Promise<boolean>((resolve) => {
          if (!product.modelUrl) return resolve(false);
          gltfLoader.load(
            product.modelUrl,
            (gltf) => {
              const model = gltf.scene;
              const box = new THREE.Box3().setFromObject(model);
              const size = box.getSize(new THREE.Vector3());
              model.scale.setScalar(1.8 / Math.max(size.y, 0.001));
              box.setFromObject(model);
              const center = box.getCenter(new THREE.Vector3());
              model.position.set(-center.x, 0.55 - box.min.y, -center.z);
              model.traverse((o) => {
                if ((o as THREE.Mesh).isMesh) o.castShadow = true;
              });
              const group = new THREE.Group();
              group.add(model);
              figure.body = group;
              figure.isModel = true;
              root.add(group);
              resolve(true);
            },
            undefined,
            () => resolve(false),
          );
        });

      productTasks.push(
        Promise.all([loadPhotos, loadOwnModel()]).then(() => {
          tick();
        }),
      );
    });

    Promise.all([templatesLoaded, ...productTasks]).then(() => {
      if (this.disposed) return;
      for (const f of this.figures) this.dress(f);
      finish();
      // fetch the other fit in the background so the women/men switch is instant
      this.loadTemplates(this.gender === 'women' ? 'men' : 'women');
    });
  }

  // ======================= camera + input =======================

  private placeOrbitCamera() {
    const r = TERRACE_R + 10;
    this.yaw.position.set(Math.cos(this.orbitAngle) * r, 13, Math.sin(this.orbitAngle) * r);
    this.yaw.rotation.y = Math.atan2(this.yaw.position.x, this.yaw.position.z);
    this.pitch = -0.42;
    this.camera.rotation.x = this.pitch;
  }

  private bindInput() {
    const el = this.renderer.domElement;
    el.style.touchAction = 'none';

    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.enabled) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(k)) {
        this.keys.add(k);
        if (k.startsWith('arrow')) e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    const onBlur = () => this.keys.clear();

    const onPointerDown = (e: PointerEvent) => {
      if (!this.enabled || this.drag) return;
      this.drag = {id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, t: performance.now()};
      el.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      if (this.usePointerForHover && e.pointerType === 'mouse') {
        this.pointer.set(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
      }
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.look.dx += dx;
      this.look.dy += dy;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!this.drag || e.pointerId !== this.drag.id) return;
      const isTap = this.drag.moved < 8 && performance.now() - this.drag.t < 500;
      this.drag = null;
      if (!isTap || !this.enabled) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      const f = this.pick(ndc, 14);
      if (f) this.cb.onSelect(f.product);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    this.cleanups.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    });
  }

  private pick(ndc: THREE.Vector2, maxDist: number): Figure | null {
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.figures.map((f) => f.hit), false);
    const hit = hits.find((h) => h.distance < maxDist);
    if (!hit) return null;
    return this.figures[hit.object.userData.figureIndex as number] ?? null;
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
  }

  // ======================= frame loop =======================

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    this.sculpture.rotation.y += dt * 0.18;
    this.sculpture.position.y = 3.35 + Math.sin(t * 0.8) * 0.08;

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.05;
      this.placeOrbitCamera();
    } else if (this.mode === 'tour' && this.tour) {
      this.updateTour(dt);
    } else {
      this.updateWalk(dt);
    }

    this.updateAtmosphere(dt, t);
    this.updateHover(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  };

  private updateTour(dt: number) {
    const tour = this.tour!;
    tour.t = Math.min(1, tour.t + dt / tour.duration);
    const k = easeInOutSine(tour.t);
    const p = tour.curve.getPointAt(k);
    this.yaw.position.copy(p);
    // watch the rotunda, then settle onto the entrance view for the last stretch
    const look = new THREE.Vector3(0, 4, 0).lerp(
      tour.endLook,
      THREE.MathUtils.smoothstep(k, 0.68, 1),
    );
    const d = look.sub(p);
    this.yaw.rotation.y = Math.atan2(-d.x, -d.z);
    this.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
    this.camera.rotation.x = this.pitch;
    if (tour.t >= 1) {
      this.yaw.position.copy(START);
      this.yaw.rotation.y = tour.endYaw;
      this.tour = null;
      this.mode = 'walk';
      this.cb.onTourEnd?.();
    }
  }

  private updateAtmosphere(dt: number, t: number) {
    this.shafts.forEach((s, i) => {
      (s.material as THREE.MeshBasicMaterial).opacity = 0.11 + Math.sin(t * 0.6 + i * 1.7) * 0.035;
    });
    if (this.dust) {
      this.dust.rotation.y += dt * 0.012;
      this.dust.position.y = Math.sin(t * 0.25) * 0.15;
    }

    // product spotlight: the figure you're looking at, or the nearest within a few steps
    let focus: Figure | null = null;
    if (this.mode === 'walk') {
      focus = this.hovered;
      if (!focus) {
        let best = 4.6;
        const p = this.yaw.position;
        for (const f of this.figures) {
          const d = Math.hypot(f.root.position.x - p.x, f.root.position.z - p.z);
          if (d < best) {
            best = d;
            focus = f;
          }
        }
      }
    }
    if (focus !== this.focused) {
      if (this.focused) this.focused.ring.material.emissiveIntensity = 0.1;
      this.focused = focus;
      if (focus) {
        const fp = focus.root.position;
        const toCentre = new THREE.Vector3(-fp.x, 0, -fp.z).normalize();
        this.spot.position.set(fp.x + toCentre.x * 1.4, 5.4, fp.z + toCentre.z * 1.4);
        this.spot.target.position.set(fp.x, 1.3, fp.z);
        this.spot.intensity = 0;
        focus.ring.material.emissiveIntensity = 2.6;
      }
    }
    const target = this.focused ? 30 : 0;
    this.spot.intensity += (target - this.spot.intensity) * Math.min(1, dt * 3);
  }

  private updateWalk(dt: number) {
    if (!this.enabled) {
      this.velocity.multiplyScalar(0.8);
      return;
    }
    if (this.look.dx || this.look.dy) {
      this.yaw.rotation.y -= this.look.dx * 0.0032;
      this.pitch = THREE.MathUtils.clamp(this.pitch - this.look.dy * 0.0032, -1.1, 1.1);
      this.camera.rotation.x = this.pitch;
      this.look.dx = this.look.dy = 0;
    }

    const dir = new THREE.Vector3();
    if (this.keys.has('w') || this.keys.has('arrowup')) dir.z -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dir.z += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dir.x -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dir.x += 1;
    dir.x += this.joy.x;
    dir.z += this.joy.y;

    const speed = this.keys.has('shift') ? 6 : 3.4;
    if (dir.lengthSq() > 0.0001) {
      const len = Math.min(dir.length(), 1);
      dir.normalize().multiplyScalar(len).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.yaw.rotation.y);
      this.velocity.lerp(dir.multiplyScalar(speed), 1 - Math.exp(-dt * 10));
    } else {
      this.velocity.multiplyScalar(Math.exp(-dt * 9));
    }

    const p = this.yaw.position;
    p.x += this.velocity.x * dt;
    p.z += this.velocity.z * dt;

    // keep the visitor out of obstacles and inside the balustrade
    const body = 0.35;
    for (const o of this.obstacles) {
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      const d = Math.hypot(dx, dz);
      const min = o.r + body;
      if (d < min && d > 0.0001) {
        p.x = o.x + (dx / d) * min;
        p.z = o.z + (dz / d) * min;
      }
    }
    const maxR = RAIL_R - 0.7;
    const d = Math.hypot(p.x, p.z);
    if (d > maxR) {
      p.x *= maxR / d;
      p.z *= maxR / d;
    }
    p.y = EYE;
  }

  private updateHover(dt: number) {
    let next: Figure | null = null;
    if (this.mode === 'walk' && this.enabled && !this.drag) {
      next = this.pick(this.usePointerForHover ? this.pointer : new THREE.Vector2(0, 0), 9);
    }
    if (next !== this.hovered) {
      this.hovered = next;
      this.renderer.domElement.style.cursor = next ? 'pointer' : 'grab';
      this.cb.onHover(next?.product ?? null);
    }

    // the spotlit figure turns slowly on its pedestal so the piece is seen all round;
    // the others ease back to face the centre
    for (const f of this.figures) {
      if (f === this.focused) {
        f.root.rotation.y += dt * 0.6;
      } else {
        const diff = shortestAngle(f.root.rotation.y, f.facing);
        f.root.rotation.y += diff * Math.min(1, dt * 2.5);
      }
    }

    const label = this.labelEl;
    if (!label) return;
    if (!this.hovered) {
      label.style.opacity = '0';
      return;
    }
    const v = new THREE.Vector3();
    this.hovered.root.getWorldPosition(v);
    v.y += 2.55;
    v.project(this.camera);
    if (v.z > 1) {
      label.style.opacity = '0';
      return;
    }
    const x = (v.x * 0.5 + 0.5) * this.container.clientWidth;
    const y = (-v.y * 0.5 + 0.5) * this.container.clientHeight;
    label.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
    label.style.opacity = '1';
  }
}

// ======================= mannequin =======================

const marbleMat = () =>
  new THREE.MeshStandardMaterial({color: 0xf3f0ea, roughness: 0.32, metalness: 0.02});

/** A marble display figure wearing a tee in the product's colour with its artwork on chest and back. */
function buildMannequin(gender: Gender, shirtColor: THREE.Color, print: THREE.Texture | null) {
  const g = new THREE.Group();
  const women = gender === 'women';
  const marble = marbleMat();
  const pants = new THREE.MeshStandardMaterial({color: 0x1e1e20, roughness: 0.75});
  const shirt = new THREE.MeshStandardMaterial({color: shirtColor, roughness: 0.85, side: THREE.DoubleSide});
  const base = 0.55; // pedestal top

  // torso profile: [radius, height]
  const profile: [number, number][] = women
    ? [
        [0.17, 0.9],
        [0.175, 0.95],
        [0.135, 1.08],
        [0.155, 1.2],
        [0.16, 1.27],
        [0.165, 1.36],
        [0.155, 1.42],
        [0.115, 1.475],
        [0.058, 1.5],
      ]
    : [
        [0.158, 0.9],
        [0.162, 0.96],
        [0.152, 1.08],
        [0.172, 1.22],
        [0.182, 1.31],
        [0.188, 1.39],
        [0.175, 1.45],
        [0.125, 1.505],
        [0.064, 1.53],
      ];
  const depth = 0.72;
  const shirtPts = profile.map(([r, y]) => new THREE.Vector2(r + 0.012, y + base));
  shirtPts.unshift(new THREE.Vector2(profile[0][0] + 0.03, 0.88 + base));
  const torso = new THREE.Mesh(new THREE.LatheGeometry(shirtPts, 40), shirt);
  torso.scale.z = depth;
  torso.castShadow = true;
  g.add(torso);

  // pelvis + legs (dark trousers, like the display figures in a boutique)
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(profile[0][0] + 0.005, 24, 12), pants);
  pelvis.scale.set(1, 0.6, depth);
  pelvis.position.y = base + 0.9;
  pelvis.castShadow = true;
  g.add(pelvis);
  const legGeo = new THREE.CapsuleGeometry(women ? 0.066 : 0.072, 0.74, 6, 14);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, pants);
    leg.position.set(sx * (women ? 0.085 : 0.092), base + 0.47, 0);
    leg.castShadow = true;
    g.add(leg);
  }

  // arms: a rounded shoulder cap and tapered sleeve in the shirt colour
  const shoulderY = profile[profile.length - 3][1] + base - 0.02;
  const shoulderX = profile[profile.length - 3][0] * 0.82;
  for (const sx of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(sx * shoulderX, shoulderY, 0);
    arm.rotation.z = sx * 0.16;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.083, 20, 12), shirt);
    cap.scale.set(1, 0.9, 0.95);
    cap.castShadow = true;
    arm.add(cap);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.083, 0.071, 0.2, 20, 1, true), shirt);
    sleeve.position.y = -0.1;
    sleeve.castShadow = true;
    arm.add(sleeve);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.24, 4, 12), marble);
    upper.position.y = -0.19;
    arm.add(upper);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.22, 4, 12), marble);
    fore.position.set(sx * 0.012, -0.45, 0.02);
    fore.castShadow = true;
    arm.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.044, 12, 8), marble);
    hand.scale.set(0.8, 1.25, 0.6);
    hand.position.set(sx * 0.015, -0.62, 0.025);
    arm.add(hand);
    g.add(arm);
  }

  // neck + head
  const neckY = profile[profile.length - 1][1] + base;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.05, 0.12, 16), marble);
  neck.position.y = neckY + 0.03;
  g.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 24, 16), marble);
  head.scale.set(0.86, 1.14, 0.98);
  head.position.y = neckY + 0.19;
  head.castShadow = true;
  g.add(head);
  if (women) {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.062, 16, 12), marble);
    bun.position.set(0, neckY + 0.27, -0.07);
    g.add(bun);
  }

  // artwork on chest and back, curved to follow the torso
  if (print) {
    const chest = Math.max(profile[3][0], profile[4][0]) + 0.017;
    const printMat = new THREE.MeshStandardMaterial({
      map: print,
      roughness: 0.8,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    for (const back of [false, true]) {
      const geo = new THREE.CylinderGeometry(chest, chest, 0.27, 24, 1, true, (back ? Math.PI : 0) - 0.78, 1.56);
      const decal = new THREE.Mesh(geo, printMat);
      decal.scale.z = depth;
      decal.position.y = base + (women ? 1.2 : 1.22);
      g.add(decal);
    }
  }

  return g;
}

// ======================= helpers =======================

function figureSlots(n: number) {
  const slots: {x: number; z: number}[] = [];
  const outerCap = 16;
  const outer = Math.min(n, outerCap);
  const inner = n - outer;
  // a small collection stands closer in so the hall doesn't feel empty
  const ring = n <= 6 ? 8.2 : 10.2;
  for (let i = 0; i < outer; i++) {
    // leave the entrance axis (+x) clear
    const a = ((i + 0.5) / outer) * Math.PI * 2;
    slots.push({x: Math.cos(a) * ring, z: Math.sin(a) * ring});
  }
  for (let i = 0; i < inner; i++) {
    const a = ((i + 0.5) / inner) * Math.PI * 2 + Math.PI / inner;
    slots.push({x: Math.cos(a) * 6.3, z: Math.sin(a) * 6.3});
  }
  return slots;
}

function sizedImage(url: string, width: number) {
  try {
    const u = new URL(url);
    u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;
  }
}

/** Sample points (fractions of the photo) on plain fabric below a tee's print. */
const SHIRT_SAMPLES = [
  [0.5, 0.84],
  [0.38, 0.81],
  [0.62, 0.81],
  [0.31, 0.69],
  [0.69, 0.69],
];
/** Sample points down the legs of a flat-lay pair of trousers. */
const TROUSER_SAMPLES = [
  [0.42, 0.35],
  [0.58, 0.35],
  [0.4, 0.55],
  [0.6, 0.55],
  [0.5, 0.2],
];

/**
 * Picks the flat-lay photos to print on the tee: images whose file name or alt text says
 * "front"/"flat" and "back", falling back to the first image.
 */
function pickFlatLays(product: GalleryProduct) {
  const label = (i: {url: string; altText: string | null}) =>
    `${i.altText ?? ''} ${i.url.split('?')[0].split('/').pop() ?? ''}`.toLowerCase();
  const images = product.images;
  const front =
    images.find((i) => /front|flat/.test(label(i))) ??
    images.find((i) => !/back|model/.test(label(i))) ??
    images[0];
  const back = images.find((i) => /back/.test(label(i)) && i !== front);
  return {front: front?.url ?? null, back: back?.url ?? null};
}

/**
 * How much artwork a flat-lay photo carries: the average colour distance of the
 * garment's centre from its plain-fabric colour. A blank side scores near zero.
 */
function designScore(img: HTMLImageElement) {
  const n = 40;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const ctx = c.getContext('2d', {willReadFrequently: true});
  if (!ctx) return 0;
  try {
    ctx.drawImage(img, 0, 0, n, n);
    const base = sampleGarmentColor(img, SHIRT_SAMPLES);
    const srgb = {r: 0, g: 0, b: 0};
    base.getRGB(srgb, THREE.SRGBColorSpace);
    const d = ctx.getImageData(Math.round(n * 0.3), Math.round(n * 0.2), Math.round(n * 0.4), Math.round(n * 0.45)).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += Math.abs(d[i] - srgb.r * 255) + Math.abs(d[i + 1] - srgb.g * 255) + Math.abs(d[i + 2] - srgb.b * 255);
    }
    return sum / (d.length / 4);
  } catch {
    return 0;
  }
}

function sampleShirtColor(img: HTMLImageElement) {
  return sampleGarmentColor(img, SHIRT_SAMPLES);
}

/** Reads the garment colour at a few points of a product photo, ignoring the backdrop. */
function sampleGarmentColor(img: HTMLImageElement, points: number[][]) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d', {willReadFrequently: true});
  if (!ctx) return new THREE.Color(0xdddddd);
  try {
    ctx.drawImage(img, 0, 0, 64, 64);
    const samples = points.map(([x, y]) => {
      const d = ctx.getImageData(Math.round(x * 63), Math.round(y * 63), 1, 1).data;
      return [d[0], d[1], d[2]] as const;
    });
    // ignore near-white studio background, take the median luminance sample
    const garment = samples.filter(([r, g, b]) => !(r > 238 && g > 236 && b > 232));
    const list = (garment.length ? garment : samples).sort(
      (a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]),
    );
    const [r, g, b] = list[Math.floor(list.length / 2)];
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  } catch {
    return new THREE.Color(0xdddddd);
  }
}

/** Crops the artwork area out of the flat-lay product photo. */
function makePrintTexture(img: HTMLImageElement, renderer: THREE.WebGLRenderer) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 560;
  const ctx = c.getContext('2d')!;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  ctx.drawImage(img, w * 0.27, h * 0.2, w * 0.46, h * 0.5, 0, 0, 512, 560);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/**
 * The print area on the chest/back of a flat-lay, inside the garment's outline. Collar,
 * sleeves and side seams fall outside it, so their drawn outlines never reach the tee.
 */
const ART_IN_PHOTO = [0.23, 0.13, 0.54, 0.65];
/** In a flat-lay photo: the torso's edges below the sleeves, and the neckline at centre. */
const PHOTO_TORSO = {left: 0.2, right: 0.8, neckY: 0.15};

/**
 * Builds the tee texture: the whole shirt in the plain garment colour, with only the
 * artwork lifted out of each flat-lay photo. The art keeps its true size and its
 * distance below the shoulders, measured against the photo's torso, and is mapped
 * through the mannequin's own UV layout so it never stretches or drifts into the collar.
 */
function makeShirtTexture(
  fit: ShirtFit,
  front: HTMLImageElement,
  back: HTMLImageElement,
  base: THREE.Color,
  renderer: THREE.WebGLRenderer,
) {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', {willReadFrequently: true})!;
  ctx.fillStyle = `#${base.getHexString(THREE.SRGBColorSpace)}`;
  ctx.fillRect(0, 0, size, size);

  const [ax, ay, aw, ah] = ART_IN_PHOTO;
  // metres of body per unit of photo width
  const s = fit.torsoWidth / (PHOTO_TORSO.right - PHOTO_TORSO.left);
  const paint = (img: HTMLImageElement, tris: number[][][], mirror: number, neckY: number) => {
    const art = extractArt(img, base);
    if (!art) return;
    // art pixel (i, j) -> body (x, y): x = x0 + xi*i, y = y0 + yj*j
    const kx = mirror * s;
    const xi = (kx * aw) / art.width;
    const x0 = kx * (ax - 0.5);
    const yj = (-s * ah) / art.height;
    // keep the art's distance below the neckline, as on the garment
    const y0 = neckY - s * (ay - PHOTO_TORSO.neckY);
    const [bx0, bx1] = [Math.min(x0, x0 + xi * art.width), Math.max(x0, x0 + xi * art.width)];
    const [by0, by1] = [y0 + yj * art.height, y0];

    // Paint triangle by triangle: within each one, body -> UV is exactly affine, so the
    // art follows the tee across UV seams without cuts or stretching.
    for (const t of tris) {
      const xs = t.map((c) => c[0]);
      const ys = t.map((c) => c[1]);
      if (Math.max(...xs) < bx0 || Math.min(...xs) > bx1) continue;
      if (Math.max(...ys) < by0 || Math.min(...ys) > by1) continue;
      const [[xa, ya, ua, va], [xb, yb, ub, vb], [xc, yc, uc, vc]] = t;
      const dx1 = xb - xa, dy1 = yb - ya, dx2 = xc - xa, dy2 = yc - ya;
      const det = dx1 * dy2 - dx2 * dy1;
      if (Math.abs(det) < 1e-9) continue;
      // body -> UV for this triangle
      const m00 = ((ub - ua) * dy2 - (uc - ua) * dy1) / det;
      const m01 = ((uc - ua) * dx1 - (ub - ua) * dx2) / det;
      const m10 = ((vb - va) * dy2 - (vc - va) * dy1) / det;
      const m11 = ((vc - va) * dx1 - (vb - va) * dx2) / det;
      const tu = ua - m00 * xa - m01 * ya;
      const tv = va - m10 * xa - m11 * ya;

      // clip to the triangle in texture space, grown by a pixel to hide hairline gaps
      const pts = t.map((c) => [c[2] * size, c[3] * size]);
      const cx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1]) / 3;
      ctx.save();
      ctx.beginPath();
      pts.forEach(([px, py], k) => {
        const d = Math.hypot(px - cx, py - cy) || 1;
        const gx = px + ((px - cx) / d) * 1.2;
        const gy = py + ((py - cy) / d) * 1.2;
        if (k) ctx.lineTo(gx, gy);
        else ctx.moveTo(gx, gy);
      });
      ctx.closePath();
      ctx.clip();
      ctx.setTransform(
        size * m00 * xi,
        size * m10 * xi,
        size * m01 * yj,
        size * m11 * yj,
        size * (m00 * x0 + m01 * y0 + tu),
        size * (m10 * x0 + m11 * y0 + tv),
      );
      ctx.drawImage(art, 0, 0);
      ctx.restore();
    }
  };
  // the mannequin faces +z: seen from the front its right-hand side is +x, from behind -x
  paint(front, fit.front, 1, fit.neckY.front);
  paint(back, fit.back, -1, fit.neckY.back);

  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false; // glTF UV convention
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/**
 * Measures a mannequin's tee: the shoulder line, the chest width, and its torso
 * triangles facing front and back with their body positions and UVs.
 */
function measureShirt(scene: THREE.Object3D): ShirtFit | null {
  let shirt: THREE.Mesh | null = null;
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.name.startsWith('Shirt')) shirt = o as THREE.Mesh;
  });
  if (!shirt) return null;
  const mesh = shirt as THREE.Mesh;
  scene.updateMatrixWorld(true);
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  if (!pos || !nor || !uv) return null;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const pts: {x: number; y: number; nz: number; u: number; v: number}[] = [];
  let top = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
    pts.push({x: p.x, y: p.y, nz: n.z, u: uv.getX(i), v: uv.getY(i)});
    if (Math.abs(p.x) < 0.2) top = Math.max(top, p.y);
  }
  const front: number[][][] = [];
  const back: number[][][] = [];
  const index = geo.index;
  const count = index ? index.count : pos.count;
  for (let k = 0; k < count; k += 3) {
    const ids = [0, 1, 2].map((o) => (index ? index.getX(k + o) : k + o));
    const corners = ids.map((id) => pts[id]);
    if (corners.some((q) => Math.abs(q.x) > 0.24 || q.y < top - 0.75)) continue;
    const nz = (corners[0].nz + corners[1].nz + corners[2].nz) / 3;
    const tri = corners.map((q) => [q.x, q.y, q.u, q.v]);
    if (nz > 0.2) front.push(tri);
    else if (nz < -0.2) back.push(tri);
  }
  if (front.length < 12 || back.length < 12) return null;
  // chest width seen from the front, opened out a little to approximate the fabric's
  // width around the curve, which is what a flat-lay photo shows
  // (below the sleeves, front-facing only, so the arms don't count)
  const band = pts.filter((q) => Math.abs(q.y - (top - 0.3)) < 0.03 && q.nz > 0.35);
  const xs = band.map((q) => q.x);
  const torsoWidth = (xs.length ? Math.max(...xs) - Math.min(...xs) : 0.34) * 1.12;
  const neck = (sign: number) =>
    Math.max(...pts.filter((q) => Math.abs(q.x) < 0.03 && q.nz * sign > 0.3).map((q) => q.y));
  return {front, back, neckY: {front: neck(1), back: neck(-1)}, torsoWidth};
}

/**
 * Cuts the print area out of a flat-lay and makes the plain fabric and studio backdrop
 * transparent, leaving only the artwork. Returns null when there is no real artwork.
 */
function extractArt(img: HTMLImageElement, base: THREE.Color) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const [ax, ay, aw, ah] = ART_IN_PHOTO;
  const w = 512;
  const h = Math.round((w * (ah * ih)) / (aw * iw));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', {willReadFrequently: true})!;
  ctx.drawImage(img, ax * iw, ay * ih, aw * iw, ah * ih, 0, 0, w, h);
  const srgb = {r: 0, g: 0, b: 0};
  base.getRGB(srgb, THREE.SRGBColorSpace);
  const [br, bg, bb] = [srgb.r * 255, srgb.g * 255, srgb.b * 255];
  try {
    const data = ctx.getImageData(0, 0, w, h);
    const p = data.data;
    let kept = 0;
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i];
      const g = p[i + 1];
      const b = p[i + 2];
      const fromFabric = Math.abs(r - br) + Math.abs(g - bg) + Math.abs(b - bb);
      const backdrop = Math.min(r, g, b) > 232 && Math.max(r, g, b) - Math.min(r, g, b) < 14;
      // soft edge so the artwork's outline doesn't fringe
      const a = backdrop ? 0 : Math.min(1, Math.max(0, (fromFabric - 45) / 45));
      p[i + 3] = Math.round(p[i + 3] * a);
      if (a > 0.5) kept++;
    }
    if (kept < (w * h) / 200) return null; // a plain side: nothing to print
    ctx.putImageData(data, 0, 0);
    return c;
  } catch {
    return null; // cross-origin image without CORS
  }
}

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function makePlasterTexture() {
  return canvasTexture(512, (ctx, s) => {
    const rand = rng(7);
    ctx.fillStyle = '#ece6dc';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const v = 200 + Math.floor(rand() * 50);
      ctx.fillStyle = `rgba(${v},${v - 6},${v - 14},${0.05 + rand() * 0.08})`;
      ctx.fillRect(rand() * s, rand() * s, 1 + rand() * 3, 1 + rand() * 3);
    }
  });
}

function makeMarbleFloorTexture() {
  return canvasTexture(1024, (ctx, s) => {
    const rand = rng(21);
    const half = s / 2;
    // two tones in a checker for a classic gallery floor
    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        ctx.fillStyle = (tx + ty) % 2 ? '#e9e3d8' : '#f3efe8';
        ctx.fillRect(tx * half, ty * half, half, half);
      }
    }
    for (let i = 0; i < 60; i++) {
      ctx.strokeStyle = `rgba(120,108,96,${0.05 + rand() * 0.12})`;
      ctx.lineWidth = 0.6 + rand() * 2.2;
      ctx.beginPath();
      const x = rand() * s;
      const y = rand() * s;
      ctx.moveTo(x, y);
      ctx.bezierCurveTo(
        x + (rand() - 0.5) * 400,
        y + (rand() - 0.5) * 400,
        x + (rand() - 0.5) * 400,
        y + (rand() - 0.5) * 400,
        x + (rand() - 0.5) * 600,
        y + (rand() - 0.5) * 600,
      );
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(90,80,70,0.35)';
    ctx.lineWidth = 2;
    for (let i = 0; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(i * half, 0);
      ctx.lineTo(i * half, s);
      ctx.moveTo(0, i * half);
      ctx.lineTo(s, i * half);
      ctx.stroke();
    }
  });
}

function makeTravertineTexture() {
  return canvasTexture(1024, (ctx, s) => {
    const rand = rng(5);
    ctx.fillStyle = '#d8cab3';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 140; i++) {
      const y = rand() * s;
      ctx.fillStyle = `rgba(${150 + rand() * 60},${130 + rand() * 50},${100 + rand() * 40},${0.08 + rand() * 0.12})`;
      ctx.fillRect(0, y, s, 1 + rand() * 5);
    }
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(120,100,80,${0.15 + rand() * 0.2})`;
      ctx.beginPath();
      ctx.ellipse(rand() * s, rand() * s, 1 + rand() * 4, 0.6 + rand() * 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(110,95,78,0.4)';
    ctx.lineWidth = 2;
    const step = s / 2;
    for (let i = 0; i <= 2; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * step);
      ctx.lineTo(s, i * step);
      ctx.stroke();
    }
    for (let row = 0; row < 2; row++) {
      const off = row % 2 ? step / 2 : 0;
      for (let i = 0; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(off + i * step, row * step);
        ctx.lineTo(off + i * step, (row + 1) * step);
        ctx.stroke();
      }
    }
  });
}

function makeVaseGeometry() {
  const pts = [
    [0.0, 0],
    [0.16, 0],
    [0.17, 0.04],
    [0.13, 0.1],
    [0.22, 0.3],
    [0.3, 0.52],
    [0.29, 0.66],
    [0.2, 0.84],
    [0.12, 0.96],
    [0.11, 1.02],
    [0.15, 1.06],
    [0.14, 1.09],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 40);
}

function makeBalusterGeometry() {
  const pts = [
    [0.0, 0],
    [0.12, 0],
    [0.12, 0.1],
    [0.075, 0.16],
    [0.065, 0.3],
    [0.115, 0.52],
    [0.12, 0.62],
    [0.065, 0.8],
    [0.055, 0.86],
    [0.1, 0.9],
    [0.1, 0.97],
    [0.0, 0.97],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return new THREE.LatheGeometry(pts, 12);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Canvas text with letter-spacing, centred on x. */
function spacedText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number) {
  const chars = [...text];
  const widths = chars.map((c) => ctx.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  let cx = x - total / 2;
  const align = ctx.textAlign;
  ctx.textAlign = 'left';
  chars.forEach((c, i) => {
    ctx.fillText(c, cx, y);
    cx += widths[i] + spacing;
  });
  ctx.textAlign = align;
}

function easeInOutSine(t: number) {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** Soft-edged beam that is brightest where it enters and fades along its length. */
function makeShaftTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  const along = ctx.createLinearGradient(0, 0, 0, 256);
  along.addColorStop(0, 'rgba(255,255,255,1)');
  along.addColorStop(0.55, 'rgba(255,255,255,0.35)');
  along.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, 128, 256);
  // feather the sides
  ctx.globalCompositeOperation = 'destination-in';
  const across = ctx.createLinearGradient(0, 0, 128, 0);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.3, 'rgba(0,0,0,1)');
  across.addColorStop(0.7, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, 128, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function shortestAngle(from: number, to: number) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function lerpAngle(a: number, b: number, t: number) {
  return a + shortestAngle(a, b) * t;
}

function disposeObject(obj: THREE.Object3D, textures: boolean) {
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mats = mesh.material
      ? Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material]
      : [];
    for (const m of mats) {
      if (textures) {
        for (const v of Object.values(m)) {
          if (v instanceof THREE.Texture) v.dispose();
        }
      }
      m.dispose();
    }
  });
}
