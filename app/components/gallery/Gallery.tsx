import {useEffect, useRef, useState, useCallback} from 'react';
import * as THREE from 'three';
import {AddToCartButton} from '~/components/AddToCartButton';
import {useAside} from '~/components/Aside';
import '~/styles/gallery.css';

export interface GalleryProduct {
  id: string;
  handle: string;
  title: string;
  imageUrl: string | null;
  imageAlt: string | null;
  amount: string;
  currencyCode: string;
  variantId: string | null;
  available: boolean;
}

const EYE_HEIGHT = 1.7;
const SPACING = 5.5;
const CORRIDOR_WIDTH = 9;
const WALL_HEIGHT = 6.2;
const GOLD = 0xc9a84a;

type Phase = 'loading' | 'intro' | 'active' | 'paused';

export function Gallery({
  products,
  shopName,
}: {
  products: GalleryProduct[];
  shopName: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const {open: openAside} = useAside();

  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [hovered, setHovered] = useState<GalleryProduct | null>(null);
  const [selected, setSelected] = useState<GalleryProduct | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [added, setAdded] = useState(false);

  const phaseRef = useRef<Phase>('loading');
  const selectedRef = useRef<GalleryProduct | null>(null);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  // Hide the normal store header/footer while the gallery is mounted.
  useEffect(() => {
    document.body.classList.add('gallery-active');
    return () => document.body.classList.remove('gallery-active');
  }, []);

  useEffect(() => {
    setIsTouch(
      typeof window !== 'undefined' &&
        (window.matchMedia?.('(pointer: coarse)').matches ||
          'ontouchstart' in window),
    );
  }, []);

  const closeOverlay = useCallback(() => setSelected(null), []);

  useEffect(() => {
    if (!containerRef.current || products.length === 0) return;
    const container = containerRef.current;

    // ---------- Scene setup ----------
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    scene.fog = new THREE.Fog(0x0a0a0a, 10, 34);

    const camera = new THREE.PerspectiveCamera(
      62,
      container.clientWidth / container.clientHeight,
      0.1,
      100,
    );
    const yawObject = new THREE.Object3D();
    yawObject.position.set(0, EYE_HEIGHT, 0);
    yawObject.add(camera);
    scene.add(yawObject);

    const renderer = new THREE.WebGLRenderer({antialias: true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    // ---------- Lighting ----------
    const hemi = new THREE.HemisphereLight(0x3a3a46, 0x000000, 0.65);
    scene.add(hemi);
    const fill = new THREE.AmbientLight(0x201a10, 0.5);
    scene.add(fill);

    // ---------- Room geometry ----------
    const half = Math.ceil(products.length / 2);
    const corridorLength = Math.max(18, half * SPACING + 10);
    const startX = -corridorLength / 2 + 6;

    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x0c0c0c,
      roughness: 0.55,
      metalness: 0.15,
    });
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(corridorLength + 4, CORRIDOR_WIDTH),
      floorMat,
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const ceilMat = new THREE.MeshStandardMaterial({
      color: 0x050505,
      roughness: 0.9,
    });
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(corridorLength + 4, CORRIDOR_WIDTH),
      ceilMat,
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = WALL_HEIGHT;
    scene.add(ceiling);

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x15120d,
      roughness: 0.85,
    });
    [-1, 1].forEach((side) => {
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(corridorLength + 4, WALL_HEIGHT),
        wallMat,
      );
      wall.position.set(0, WALL_HEIGHT / 2, (side * CORRIDOR_WIDTH) / 2);
      wall.rotation.y = side === 1 ? Math.PI : 0;
      scene.add(wall);
    });
    [-1, 1].forEach((side) => {
      const cap = new THREE.Mesh(
        new THREE.PlaneGeometry(CORRIDOR_WIDTH, WALL_HEIGHT),
        wallMat,
      );
      cap.position.set(
        side === 1 ? startX - 5 : startX + corridorLength - 5,
        WALL_HEIGHT / 2,
        0,
      );
      cap.rotation.y = side === 1 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(cap);
    });

    // A thin gold strip along the floor edges for a museum feel
    const stripMat = new THREE.MeshStandardMaterial({
      color: GOLD,
      metalness: 0.7,
      roughness: 0.3,
    });
    [-1, 1].forEach((side) => {
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(corridorLength + 4, 0.03, 0.08),
        stripMat,
      );
      strip.position.set(0, 0.015, (side * (CORRIDOR_WIDTH - 0.6)) / 2);
      scene.add(strip);
    });

    // ---------- Product frames ----------
    const textureLoader = new THREE.TextureLoader();
    const frameMeshes: {mesh: THREE.Mesh; product: GalleryProduct}[] = [];
    const frameMat = new THREE.MeshStandardMaterial({
      color: GOLD,
      metalness: 0.65,
      roughness: 0.35,
    });
    const pedestalMat = new THREE.MeshStandardMaterial({
      color: 0x1a1a1a,
      roughness: 0.6,
      metalness: 0.2,
    });

    let loaded = 0;
    const total = products.filter((p) => p.imageUrl).length || 1;
    const bumpProgress = () => {
      loaded += 1;
      setProgress(Math.round((loaded / total) * 100));
      if (loaded >= total) {
        window.setTimeout(() => setPhase('intro'), 250);
      }
    };

    products.forEach((product, i) => {
      const side = i % 2 === 0 ? -1 : 1;
      const idx = Math.floor(i / 2);
      const x = startX + idx * SPACING;
      const z = (side * (CORRIDOR_WIDTH - 0.3)) / 2;

      const group = new THREE.Group();
      group.position.set(x, 1.9, z);
      group.rotation.y = side === 1 ? Math.PI : 0;

      const frameW = 1.9;
      const frameH = 2.5;
      const border = new THREE.Mesh(
        new THREE.BoxGeometry(frameW + 0.16, frameH + 0.16, 0.08),
        frameMat,
      );
      border.position.z = -0.04;
      group.add(border);

      const planeGeo = new THREE.PlaneGeometry(frameW, frameH);
      const placeholderMat = new THREE.MeshStandardMaterial({
        color: 0x2a2a2a,
        roughness: 0.8,
      });
      const picture = new THREE.Mesh(planeGeo, placeholderMat);
      picture.position.z = 0.01;
      group.add(picture);
      frameMeshes.push({mesh: picture, product});

      const spot = new THREE.PointLight(0xffdca8, 1.1, 6, 2);
      spot.position.set(0, 1.6, side === 1 ? -0.9 : 0.9);
      group.add(spot);

      const pedestal = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 1.9, 0.5),
        pedestalMat,
      );
      pedestal.position.set(x, 0.95, z + side * -0.55);
      scene.add(pedestal);

      scene.add(group);

      if (product.imageUrl) {
        textureLoader.load(
          product.imageUrl,
          (tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            picture.material = new THREE.MeshStandardMaterial({
              map: tex,
              roughness: 0.75,
            });
            bumpProgress();
          },
          undefined,
          () => bumpProgress(),
        );
      } else {
        bumpProgress();
      }
    });

    const bounds = {
      minX: startX - 5 + 1.2,
      maxX: startX + corridorLength - 5 - 1.2,
      halfZ: CORRIDOR_WIDTH / 2 - 1.1,
    };

    // ---------- Controls state ----------
    const move = {forward: false, back: false, left: false, right: false};
    const velocity = new THREE.Vector3();
    const touchLook = {dx: 0, dy: 0};
    const joyMove = {x: 0, y: 0};
    let pitch = 0;
    const raycaster = new THREE.Raycaster();
    const center = new THREE.Vector2(0, 0);
    let hoveredRef: GalleryProduct | null = null;

    function onKeyDown(e: KeyboardEvent) {
      if (phaseRef.current !== 'active' || selectedRef.current) return;
      if (e.code === 'KeyW' || e.code === 'ArrowUp') move.forward = true;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') move.back = true;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') move.left = true;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') move.right = true;
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') move.forward = false;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') move.back = false;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') move.left = false;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') move.right = false;
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    function onMouseMove(e: MouseEvent) {
      if (document.pointerLockElement !== renderer.domElement) return;
      yawObject.rotation.y -= e.movementX * 0.0022;
      pitch -= e.movementY * 0.0022;
      pitch = Math.max(-1.2, Math.min(1.2, pitch));
      camera.rotation.x = pitch;
    }
    document.addEventListener('mousemove', onMouseMove);

    function onPointerLockChange() {
      if (document.pointerLockElement !== renderer.domElement) {
        if (phaseRef.current === 'active' && !selectedRef.current) {
          setPhase('paused');
        }
      }
    }
    document.addEventListener('pointerlockchange', onPointerLockChange);

    function onCanvasClick() {
      if (selectedRef.current) return;
      if (phaseRef.current === 'paused') {
        renderer.domElement.requestPointerLock?.();
        setPhase('active');
        return;
      }
      if (phaseRef.current !== 'active') return;
      if (!isTouch && document.pointerLockElement !== renderer.domElement) {
        renderer.domElement.requestPointerLock?.();
        return;
      }
      if (hoveredRef) setSelected(hoveredRef);
    }
    renderer.domElement.addEventListener('click', onCanvasClick);

    const clock = new THREE.Clock();
    let raf = 0;
    function animate() {
      raf = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.1);

      if (phaseRef.current === 'active' && !selectedRef.current) {
        // touch look
        if (touchLook.dx || touchLook.dy) {
          yawObject.rotation.y -= touchLook.dx * 0.0028;
          pitch -= touchLook.dy * 0.0028;
          pitch = Math.max(-1.2, Math.min(1.2, pitch));
          camera.rotation.x = pitch;
          touchLook.dx = 0;
          touchLook.dy = 0;
        }

        const speed = 3.6;
        const dir = new THREE.Vector3();
        if (move.forward) dir.z -= 1;
        if (move.back) dir.z += 1;
        if (move.left) dir.x -= 1;
        if (move.right) dir.x += 1;
        if (joyMove.x || joyMove.y) {
          dir.x += joyMove.x;
          dir.z += joyMove.y;
        }
        if (dir.lengthSq() > 0) {
          dir.normalize().applyEuler(new THREE.Euler(0, yawObject.rotation.y, 0));
          velocity.x = dir.x * speed;
          velocity.z = dir.z * speed;
        } else {
          velocity.x *= 0.8;
          velocity.z *= 0.8;
        }

        yawObject.position.x += velocity.x * dt;
        yawObject.position.z += velocity.z * dt;
        yawObject.position.x = Math.max(
          bounds.minX,
          Math.min(bounds.maxX, yawObject.position.x),
        );
        yawObject.position.z = Math.max(
          -bounds.halfZ,
          Math.min(bounds.halfZ, yawObject.position.z),
        );

        // hover raycast
        raycaster.setFromCamera(center, camera);
        const hits = raycaster.intersectObjects(
          frameMeshes.map((f) => f.mesh),
        );
        if (hits.length && hits[0].distance < 5.5) {
          const found = frameMeshes.find((f) => f.mesh === hits[0].object);
          if (found && hoveredRef?.id !== found.product.id) {
            hoveredRef = found.product;
            setHovered(found.product);
          }
          if (labelRef.current && found) {
            const p = new THREE.Vector3();
            found.mesh.getWorldPosition(p);
            p.y += 1.5;
            p.project(camera);
            const x = (p.x * 0.5 + 0.5) * container.clientWidth;
            const y = (-p.y * 0.5 + 0.5) * container.clientHeight;
            labelRef.current.style.transform = `translate(${x}px, ${y}px)`;
            labelRef.current.style.opacity = '1';
          }
        } else {
          if (hoveredRef !== null) {
            hoveredRef = null;
            setHovered(null);
          }
          if (labelRef.current) labelRef.current.style.opacity = '0';
        }
      }

      renderer.render(scene, camera);
    }
    animate();

    function onResize() {
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    }
    window.addEventListener('resize', onResize);

    // expose joystick setters for the DOM joystick handlers below
    (container as any).__setJoyMove = (x: number, y: number) => {
      joyMove.x = x;
      joyMove.y = y;
    };
    (container as any).__addLook = (dx: number, dy: number) => {
      touchLook.dx += dx;
      touchLook.dy += dy;
    };
    (container as any).__renderer = renderer;

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      renderer.domElement.removeEventListener('click', onCanvasClick);
      renderer.dispose();
      floorMat.dispose();
      ceilMat.dispose();
      wallMat.dispose();
      frameMat.dispose();
      pedestalMat.dispose();
      frameMeshes.forEach((f) => {
        f.mesh.geometry.dispose();
        (f.mesh.material as THREE.Material).dispose();
      });
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  const enterGallery = () => {
    setPhase('active');
    setAdded(false);
    const container = containerRef.current as any;
    if (!isTouch && container?.__renderer) {
      container.__renderer.domElement.requestPointerLock?.();
    }
  };

  // ---------- touch joystick handlers ----------
  const moveStick = useRef<HTMLDivElement | null>(null);
  const lookStick = useRef<HTMLDivElement | null>(null);
  const moveTouchId = useRef<number | null>(null);
  const lookTouchId = useRef<number | null>(null);
  const moveOrigin = useRef({x: 0, y: 0});
  const lookOrigin = useRef({x: 0, y: 0});

  const onJoyStart =
    (which: 'move' | 'look') => (e: React.TouchEvent<HTMLDivElement>) => {
      e.preventDefault();
      const touch = e.changedTouches[0];
      const target = which === 'move' ? moveStick : lookStick;
      const rect = target.current!.getBoundingClientRect();
      const origin = {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
      if (which === 'move') {
        moveTouchId.current = touch.identifier;
        moveOrigin.current = origin;
      } else {
        lookTouchId.current = touch.identifier;
        lookOrigin.current = {x: touch.clientX, y: touch.clientY};
      }
    };

  const onJoyMove = (e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current as any;
    if (!container) return;
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === moveTouchId.current) {
        const dx = touch.clientX - moveOrigin.current.x;
        const dy = touch.clientY - moveOrigin.current.y;
        const max = 46;
        const cx = Math.max(-max, Math.min(max, dx));
        const cy = Math.max(-max, Math.min(max, dy));
        container.__setJoyMove?.(cx / max, cy / max);
        const knob = moveStick.current?.querySelector(
          '.gal-knob',
        ) as HTMLDivElement | null;
        if (knob) knob.style.transform = `translate(${cx}px, ${cy}px)`;
      }
      if (touch.identifier === lookTouchId.current) {
        const dx = touch.clientX - lookOrigin.current.x;
        const dy = touch.clientY - lookOrigin.current.y;
        lookOrigin.current = {x: touch.clientX, y: touch.clientY};
        container.__addLook?.(dx * 1.6, dy * 1.6);
      }
    }
  };

  const onJoyEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    const container = containerRef.current as any;
    for (const touch of Array.from(e.changedTouches)) {
      if (touch.identifier === moveTouchId.current) {
        moveTouchId.current = null;
        container?.__setJoyMove?.(0, 0);
        const knob = moveStick.current?.querySelector(
          '.gal-knob',
        ) as HTMLDivElement | null;
        if (knob) knob.style.transform = 'translate(0,0)';
      }
      if (touch.identifier === lookTouchId.current) {
        lookTouchId.current = null;
      }
    }
  };

  if (products.length === 0) {
    return (
      <div className="gal-empty">
        <h1>{shopName}</h1>
        <p>No products yet — add some in the Shopify admin to fill the gallery.</p>
      </div>
    );
  }

  return (
    <div className="gal-root">
      <div ref={containerRef} className="gal-canvas-wrap" />

      <div ref={labelRef} className="gal-hover-label">
        {hovered ? (
          <>
            <span className="gal-hover-title">{hovered.title}</span>
            <span className="gal-hover-price">
              {formatPrice(hovered.amount, hovered.currencyCode)}
            </span>
          </>
        ) : null}
      </div>

      {phase === 'loading' && (
        <div className="gal-screen gal-load">
          <div className="gal-wm">{shopName.toUpperCase()}</div>
          <div className="gal-tag">PREPARING THE GALLERY</div>
          <div className="gal-bar">
            <i style={{width: `${progress}%`}} />
          </div>
          <div className="gal-pct">{progress}%</div>
        </div>
      )}

      {phase === 'intro' && (
        <div className="gal-screen gal-intro">
          <div className="gal-wm">{shopName.toUpperCase()}</div>
          <div className="gal-tag">A WALKABLE SHOWCASE</div>
          <div className="gal-sep" />
          <div className="gal-hints">
            {isTouch ? (
              <>Use the joysticks to <b>walk</b> and <b>look around</b></>
            ) : (
              <><b>WASD</b> to walk &middot; <b>mouse</b> to look &middot; <b>click</b> a piece to view it</>
            )}
          </div>
          <button className="gal-enter-btn" onClick={enterGallery}>
            Enter the Gallery
          </button>
          <a className="gal-skip" href="/collections/all">
            or browse the shop normally →
          </a>
        </div>
      )}

      {phase === 'paused' && (
        <div className="gal-screen gal-resume" onClick={enterGallery}>
          <div className="gal-tag">Click to resume</div>
        </div>
      )}

      {phase === 'active' && !selected && (
        <div className="gal-hint">
          {hovered ? `Click to view "${hovered.title}"` : 'Walk around the gallery'}
        </div>
      )}

      {(phase === 'active' || phase === 'paused') && (
        <div className="gal-crosshair" />
      )}

      {/* Menu bar */}
      <div className="gal-menubar">
        <span className="gal-brand">{shopName}</span>
        <a href="/collections/all">Shop</a>
        <a href="/pages/about">About</a>
        <button
          className="gal-cart-btn"
          onClick={() => openAside('cart')}
          aria-label="Open cart"
        >
          Bag
        </button>
        <button
          className="gal-menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menu"
        >
          ☰
        </button>
      </div>
      {menuOpen && (
        <div className="gal-mmenu">
          <a href="/collections/all">Shop</a>
          <a href="/pages/about">About</a>
          <button onClick={() => openAside('cart')}>Bag</button>
        </div>
      )}

      {/* Touch controls */}
      {isTouch && phase === 'active' && (
        <>
          <div
            ref={moveStick}
            className="gal-stick gal-stick-left"
            onTouchStart={onJoyStart('move')}
            onTouchMove={onJoyMove}
            onTouchEnd={onJoyEnd}
          >
            <div className="gal-knob" />
          </div>
          <div
            ref={lookStick}
            className="gal-stick gal-stick-right"
            onTouchStart={onJoyStart('look')}
            onTouchMove={onJoyMove}
            onTouchEnd={onJoyEnd}
          >
            <div className="gal-knob" />
          </div>
        </>
      )}

      {/* Product detail overlay */}
      {selected && (
        <div className="gal-overlay" role="dialog" aria-modal="true">
          <button className="gal-overlay-close" onClick={closeOverlay}>
            &times;
          </button>
          <div className="gal-overlay-card">
            {selected.imageUrl && (
              <img src={selected.imageUrl} alt={selected.imageAlt ?? selected.title} />
            )}
            <div className="gal-overlay-info">
              <h2>{selected.title}</h2>
              <p className="gal-overlay-price">
                {formatPrice(selected.amount, selected.currencyCode)}
              </p>
              <div className="gal-overlay-actions">
                {selected.variantId && selected.available ? (
                  <AddToCartButton
                    lines={[{merchandiseId: selected.variantId, quantity: 1}]}
                    onClick={() => setAdded(true)}
                  >
                    {added ? 'Added ✓' : 'Add to Bag'}
                  </AddToCartButton>
                ) : (
                  <button disabled>Sold out</button>
                )}
                <a href={`/products/${selected.handle}`}>View full details →</a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatPrice(amount: string, currencyCode: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currencyCode}`;
  }
}
