import {Suspense, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Await, Link, useRouteLoaderData} from 'react-router';
import {AddToCartButton} from '~/components/AddToCartButton';
import {useAside} from '~/components/Aside';
import type {RootLoader} from '~/root';
import logoUrl from '~/assets/ravex-logo.webp';
import type {Gender, GalleryProduct, GalleryVariant} from './types';
import type {GalleryScene} from './scene';
import '~/styles/gallery.css';

const BRAND = 'RAVEX';
const NAV = [
  {label: 'Shop', to: '/collections/all'},
  {label: 'About', to: '/pages/about'},
  {label: 'FAQ', to: '/pages/faq'},
  {label: 'Contact', to: '/pages/contact'},
];

type Phase = 'loading' | 'intro' | 'walk';

export function Gallery({products}: {products: GalleryProduct[]}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<GalleryScene | null>(null);
  const aside = useAside();

  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [gender, setGender] = useState<Gender>('women');
  const [hovered, setHovered] = useState<GalleryProduct | null>(null);
  const [selected, setSelected] = useState<GalleryProduct | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const [touring, setTouring] = useState(false);
  const [webglError, setWebglError] = useState(false);

  // The store header/footer are hidden while the full-screen gallery is mounted.
  useEffect(() => {
    document.body.classList.add('gallery-active');
    return () => document.body.classList.remove('gallery-active');
  }, []);

  useEffect(() => {
    setIsTouch(window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
  }, []);

  // Three.js is only loaded in the browser.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || products.length === 0) return;
    let cancelled = false;
    const mobile = window.matchMedia?.('(pointer: coarse)').matches ?? false;

    import('./scene')
      .then(({GalleryScene}) => {
        if (cancelled) return;
        sceneRef.current = new GalleryScene(container, {
          products,
          logoUrl,
          gender,
          mobile,
          labelEl: labelRef.current,
          callbacks: {
            onProgress: setProgress,
            onReady: () => window.setTimeout(() => setPhase((p) => (p === 'loading' ? 'intro' : p)), 500),
            onHover: setHovered,
            onSelect: setSelected,
            onTourEnd: () => setTouring(false),
          },
        });
        if (import.meta.env.DEV) (window as any).__gallery = sceneRef.current;
      })
      .catch((error) => {
        console.error(error);
        setWebglError(true);
      });

    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
    // gender is applied through setGender below; the scene is built once per product list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products]);

  useEffect(() => {
    sceneRef.current?.setGender(gender);
  }, [gender]);

  const overlayOpen = Boolean(selected) || menuOpen || aside.type !== 'closed';
  useEffect(() => {
    sceneRef.current?.setEnabled(phase === 'walk' && !overlayOpen);
  }, [phase, overlayOpen]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  const enter = () => {
    sceneRef.current?.enter();
    setTouring(true);
    setPhase('walk');
  };

  const openBag = () => {
    setMenuOpen(false);
    aside.open('cart');
  };

  if (products.length === 0) {
    return (
      <div className="gal-empty">
        <img src={logoUrl} alt={BRAND} />
        <p>The gallery opens as soon as the first pieces are added to the store.</p>
      </div>
    );
  }

  return (
    <div className="gal-root">
      <div ref={containerRef} className="gal-canvas" />

      <div ref={labelRef} className="gal-label" aria-hidden>
        {hovered && (
          <>
            <span className="gal-label-title">{hovered.title}</span>
            <span className="gal-label-price">{formatMoney(hovered.amount, hovered.currencyCode)}</span>
          </>
        )}
      </div>

      {phase === 'loading' && (
        <div className="gal-screen gal-loader">
          <LogoCard />
          <div className="gal-bar">
            <i style={{width: `${Math.max(progress, 4)}%`}} />
          </div>
          <div className="gal-pct">{progress}%</div>
          <div className="gal-status">{progress >= 100 ? 'Welcome' : 'The gallery awaits'}</div>
        </div>
      )}

      {phase === 'intro' && (
        <div className="gal-screen gal-intro">
          <LogoCard />
          <div className="gal-sep" />
          <ul className="gal-keys">
            <li>
              <b>WASD / Joystick</b> <span>Walk</span>
            </li>
            <li>
              <b>Drag / Right stick</b> <span>Look around</span>
            </li>
            <li>
              <b>Tap</b> <span>View piece</span>
            </li>
          </ul>
          <GenderSwitch value={gender} onChange={setGender} large />
          <button className="gal-enter" onClick={enter}>
            Enter the gallery
          </button>
          <Link className="gal-skip" to="/collections/all">
            or browse the shop
          </Link>
          {webglError && (
            <p className="gal-error">
              Your browser couldn&apos;t start the 3D view. You can still shop the collection.
            </p>
          )}
        </div>
      )}

      {/* top bar: nav (left), gender (centre), bag (right) */}
      {phase !== 'loading' && (
        <>
          <nav className="gal-nav">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to}>
                {item.label}
              </Link>
            ))}
          </nav>
          <button className="gal-burger" aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
            {menuOpen ? '×' : '☰'}
          </button>
          {menuOpen && (
            <div className="gal-menu">
              {NAV.map((item) => (
                <Link key={item.to} to={item.to} onClick={() => setMenuOpen(false)}>
                  {item.label}
                </Link>
              ))}
            </div>
          )}
          {phase === 'walk' && (
            <div className="gal-top-center">
              <GenderSwitch value={gender} onChange={setGender} />
            </div>
          )}
          <button className="gal-bag" onClick={openBag}>
            Bag <BagCount />
          </button>
        </>
      )}

      {phase === 'walk' && touring && (
        <button className="gal-skip-tour" onClick={() => sceneRef.current?.skipTour()}>
          Skip tour
        </button>
      )}

      {phase === 'walk' && !touring && (
        <>
          <div className="gal-hint">
            {hovered ? (
              <>
                Tap to view <b>{hovered.title}</b>
              </>
            ) : isTouch ? (
              'Left · walk   ·   Right · look   ·   Tap a piece'
            ) : (
              'WASD · walk   ·   Drag · look   ·   Shift · run   ·   Click a piece'
            )}
          </div>
          {isTouch && <div className="gal-reticle" />}
          {isTouch && !overlayOpen && <Joysticks sceneRef={sceneRef} />}
        </>
      )}

      {selected && (
        <ProductPopup product={selected} onClose={() => setSelected(null)} onAdded={openBag} />
      )}
    </div>
  );
}

function LogoCard() {
  return (
    <div className="gal-logo-card">
      <img src={logoUrl} alt={BRAND} />
      <div className="gal-logo-text">
        <span className="gal-wordmark">{BRAND}</span>
        <span className="gal-tagline">The 3D Gallery</span>
      </div>
    </div>
  );
}

function GenderSwitch({
  value,
  onChange,
  large,
}: {
  value: Gender;
  onChange: (g: Gender) => void;
  large?: boolean;
}) {
  return (
    <div className={`gal-gender ${large ? 'is-large' : ''}`} role="radiogroup" aria-label="Fit">
      {(['women', 'men'] as const).map((g) => (
        <button
          key={g}
          role="radio"
          aria-checked={value === g}
          className={value === g ? 'on' : ''}
          onClick={() => onChange(g)}
        >
          {large ? (g === 'women' ? 'Womenswear' : 'Menswear') : g}
        </button>
      ))}
    </div>
  );
}

function BagCount() {
  const root = useRouteLoaderData<RootLoader>('root');
  if (!root) return null;
  return (
    <Suspense fallback={null}>
      <Await resolve={root.cart}>
        {(cart) =>
          cart?.totalQuantity ? <span className="gal-bag-count">{cart.totalQuantity}</span> : null
        }
      </Await>
    </Suspense>
  );
}

function Joysticks({sceneRef}: {sceneRef: React.RefObject<GalleryScene | null>}) {
  const left = useRef<HTMLDivElement | null>(null);
  const right = useRef<HTMLDivElement | null>(null);
  const active = useRef<{move: number | null; look: number | null}>({move: null, look: null});
  const last = useRef({x: 0, y: 0});
  const max = 42;

  const knob = (el: HTMLDivElement | null, x: number, y: number) => {
    const k = el?.querySelector<HTMLElement>('.gal-knob');
    if (k) k.style.transform = `translate(${x}px, ${y}px)`;
  };

  const start = (which: 'move' | 'look') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    active.current[which] = e.pointerId;
    if (which === 'look') last.current = {x: e.clientX, y: e.clientY};
  };

  const move = (which: 'move' | 'look') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (active.current[which] !== e.pointerId) return;
    const el = which === 'move' ? left.current : right.current;
    const rect = el!.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    const k = len > max ? max / len : 1;
    knob(el, dx * k, dy * k);
    if (which === 'move') {
      sceneRef.current?.setMove((dx * k) / max, (dy * k) / max);
    } else {
      sceneRef.current?.addLook((e.clientX - last.current.x) * 1.4, (e.clientY - last.current.y) * 1.4);
      last.current = {x: e.clientX, y: e.clientY};
    }
  };

  const end = (which: 'move' | 'look') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (active.current[which] !== e.pointerId) return;
    active.current[which] = null;
    knob(which === 'move' ? left.current : right.current, 0, 0);
    if (which === 'move') sceneRef.current?.setMove(0, 0);
  };

  useEffect(() => () => sceneRef.current?.setMove(0, 0), [sceneRef]);

  return (
    <>
      {(['move', 'look'] as const).map((which) => (
        <div
          key={which}
          ref={which === 'move' ? left : right}
          className={`gal-stick ${which === 'move' ? 'is-left' : 'is-right'}`}
          onPointerDown={start(which)}
          onPointerMove={move(which)}
          onPointerUp={end(which)}
          onPointerCancel={end(which)}
        >
          <div className="gal-knob" />
        </div>
      ))}
    </>
  );
}

function ProductPopup({
  product,
  onClose,
  onAdded,
}: {
  product: GalleryProduct;
  onClose: () => void;
  onAdded: () => void;
}) {
  const choosable = useMemo(
    () => product.options.filter((o) => o.values.length > 1 || o.values[0] !== 'Default Title'),
    [product],
  );
  const firstAvailable = product.variants.find((v) => v.available) ?? product.variants[0];
  const [selection, setSelection] = useState<Record<string, string>>(() =>
    Object.fromEntries(firstAvailable?.selectedOptions.map((o) => [o.name, o.value]) ?? []),
  );
  const [imageIndex, setImageIndex] = useState(0);

  const variant: GalleryVariant | undefined = product.variants.find((v) =>
    v.selectedOptions.every((o) => selection[o.name] === o.value),
  );
  const isAvailable = (name: string, value: string) =>
    product.variants.some(
      (v) =>
        v.available &&
        v.selectedOptions.every((o) => (o.name === name ? o.value === value : selection[o.name] === o.value)),
    );

  const image = product.images[imageIndex];
  const numericId = variant?.id.split('/').pop();

  const close = useCallback(() => onClose(), [onClose]);

  return (
    <div className="gal-popup-wrap" role="dialog" aria-modal="true" aria-label={product.title} onClick={close}>
      <div className="gal-popup" onClick={(e) => e.stopPropagation()}>
        <button className="gal-popup-close" onClick={close} aria-label="Close">
          ×
        </button>
        <div className="gal-popup-brand">{BRAND}</div>
        {image && (
          <button
            className="gal-popup-image"
            onClick={() => setImageIndex((i) => (i + 1) % product.images.length)}
            aria-label="Next photo"
          >
            <img src={image.url} alt={image.altText ?? product.title} />
          </button>
        )}
        {product.images.length > 1 && (
          <div className="gal-popup-dots">
            {product.images.map((img, i) => (
              <button
                key={img.url}
                className={i === imageIndex ? 'on' : ''}
                onClick={() => setImageIndex(i)}
                aria-label={`Photo ${i + 1}`}
              />
            ))}
          </div>
        )}
        <h2>{product.title}</h2>
        <div className="gal-popup-price">
          {formatMoney(variant?.amount ?? product.amount, variant?.currencyCode ?? product.currencyCode)}
        </div>

        {choosable.map((option) => (
          <div key={option.name} className="gal-option">
            <div className="gal-option-name">{option.name}</div>
            <div className="gal-option-values">
              {option.values.map((value) => (
                <button
                  key={value}
                  className={`${selection[option.name] === value ? 'on' : ''} ${
                    isAvailable(option.name, value) ? '' : 'is-out'
                  }`}
                  onClick={() => setSelection((s) => ({...s, [option.name]: value}))}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="gal-popup-actions">
          {variant?.available ? (
            <>
              <AddToCartButton
                lines={[{merchandiseId: variant.id, quantity: 1}]}
                onClick={() => {
                  // let the cart form submit before the popup unmounts
                  window.setTimeout(() => {
                    onClose();
                    onAdded();
                  }, 150);
                }}
              >
                Add to bag
              </AddToCartButton>
              <a className="gal-buy" href={`/cart/${numericId}:1`}>
                Buy now
              </a>
            </>
          ) : (
            <button disabled>{variant ? 'Sold out' : 'Unavailable'}</button>
          )}
        </div>
        <Link className="gal-popup-more" to={`/products/${product.handle}`}>
          View full details
        </Link>
      </div>
    </div>
  );
}

function formatMoney(amount: string, currencyCode: string) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: Number(amount) % 1 === 0 ? 0 : 2,
    }).format(Number(amount));
  } catch {
    return `${amount} ${currencyCode}`;
  }
}
