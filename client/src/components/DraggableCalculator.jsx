import React, {
  useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState,
} from 'react';

/* =====================================================================
   DraggableCalculator
   ---------------------------------------------------------------------
   • Mount ONCE at admin-layout level (e.g. inside AdminLayout, next to
     <Outlet />):   <DraggableCalculator />
   • Starts at the bottom-right corner, drags anywhere (mouse + touch + pen
     via Pointer Events) and is always clamped inside the viewport.
   • Minimise it to a round button so it never blocks the page.
   • Exact decimal maths (BigInt) — 0.1 + 0.2 = 0.3, no eval(), no floats.
   • Keyboard friendly: digits, + - * / % . Enter = Backspace Delete Esc.
   • Styling is 100 % internal (<style> + style objects). No other files.
   ===================================================================== */

const EDGE = 4;            // px kept free between the calculator and the screen edge
const MARGIN = 16;         // initial gap from the bottom-right corner
const MAX_DIGITS = 15;     // most digits the display can show
const DIV_SCALE = 16;      // working precision for division (rounded to fit afterwards)
const TEN = BigInt(10);
const ZERO = BigInt(0);

/* =====================================================================
   EXACT DECIMAL ARITHMETIC  { n: BigInt (scaled integer), s: decimals }
   ===================================================================== */
const pow10 = (k) => TEN ** BigInt(k);
const absBig = (v) => (v < ZERO ? -v : v);

function parseDec(str) {
  let t = String(str);
  const neg = t.startsWith('-');
  if (neg) t = t.slice(1);
  const [i = '', f = ''] = t.split('.');
  const digits = `${i || '0'}${f}`.replace(/^0+(?=\d)/, '');
  const n = BigInt(digits || '0');
  return { n: neg ? -n : n, s: f.length };
}

function trimDec(d) {
  let { n, s } = d;
  while (s > 0 && n % TEN === ZERO) { n /= TEN; s -= 1; }
  return { n, s };
}

function toStr(d) {
  const { n, s } = trimDec(d);
  const neg = n < ZERO;
  const abs = absBig(n).toString().padStart(s + 1, '0');
  const int = abs.slice(0, abs.length - s);
  const frac = s ? abs.slice(abs.length - s) : '';
  return `${neg && (int !== '0' || frac) ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** round half away from zero to `scale` decimals */
function roundTo(d, scale) {
  if (d.s <= scale) return d;
  const div = pow10(d.s - scale);
  const neg = d.n < ZERO;
  const a = absBig(d.n);
  let q = a / div;
  if ((a % div) * BigInt(2) >= div) q += BigInt(1);
  return { n: neg ? -q : q, s: scale };
}

/** keep the value inside the display: ≤ MAX_DIGITS digits, rounding extra decimals */
function fit(d) {
  const t = trimDec(d);
  const intDigits = Math.max(1, absBig(t.n).toString().length - t.s);
  if (intDigits > MAX_DIGITS) throw new Error('OVERFLOW');
  return trimDec(roundTo(t, MAX_DIGITS - intDigits));
}

const align = (a, b) => {
  const s = Math.max(a.s, b.s);
  return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s];
};
const add = (a, b) => { const [x, y, s] = align(a, b); return { n: x + y, s }; };
const sub = (a, b) => { const [x, y, s] = align(a, b); return { n: x - y, s }; };
const mul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
function div(a, b) {
  if (b.n === ZERO) throw new Error('DIV0');
  // (a.n / 10^a.s) / (b.n / 10^b.s) · 10^DIV_SCALE, rounded half away from zero
  const num = a.n * pow10(b.s + DIV_SCALE);
  const den = b.n * pow10(a.s);
  const neg = (num < ZERO) !== (den < ZERO);
  const an = absBig(num);
  const ad = absBig(den);
  const q = (an * BigInt(2) + ad) / (ad * BigInt(2));
  return { n: neg ? -q : q, s: DIV_SCALE };
}
const div100 = (d) => ({ n: d.n, s: d.s + 2 });

function calc(a, op, b) {
  const x = parseDec(a);
  const y = parseDec(b);
  let r;
  if (op === '+') r = add(x, y);
  else if (op === '-') r = sub(x, y);
  else if (op === '*') r = mul(x, y);
  else r = div(x, y);
  return toStr(fit(r));
}
const norm = (str) => toStr(fit(parseDec(str)));

/* ---------- display formatting (Indian grouping: 12,34,567.50) ---------- */
const groupIN = (i) => (i.length <= 3
  ? i
  : `${i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${i.slice(-3)}`);

function fmt(str) {
  if (!str || /[^\d.-]/.test(str)) return str;           // error text is shown as-is
  const neg = str.startsWith('-');
  const body = neg ? str.slice(1) : str;
  const dot = body.indexOf('.');
  const int = dot === -1 ? body : body.slice(0, dot);
  const rest = dot === -1 ? '' : body.slice(dot);        // keeps a trailing "." while typing
  return `${neg ? '-' : ''}${groupIN(int || '0')}${rest}`;
}

/* =====================================================================
   CALCULATOR STATE
   ===================================================================== */
const OPS = { '+': '+', '-': '−', '*': '×', '/': '÷' };
const INITIAL = {
  display: '0',        // number being typed, or the latest result
  acc: null,           // left operand waiting for the right one
  op: null,            // pending operator
  rhsPending: false,   // an operator was just pressed
  overwrite: true,     // next digit replaces the display
  lastOp: null,        // for repeated "="
  lastRhs: null,
  expr: '',            // small line above the result
  error: false,
};

const FRESH = { expr: '', lastOp: null, lastRhs: null, acc: null };

function step(s, a) {
  switch (a.type) {
    case 'digit': {
      if (s.overwrite) {
        return { ...s, display: a.value, overwrite: false, rhsPending: false, ...(s.op === null ? FRESH : {}) };
      }
      if (s.display.replace(/[-.]/g, '').length >= MAX_DIGITS) return s;
      if (s.display === '0') return { ...s, display: a.value };
      if (s.display === '-0') return { ...s, display: `-${a.value}` };
      return { ...s, display: s.display + a.value };
    }

    case 'dot': {
      if (s.overwrite) {
        return { ...s, display: '0.', overwrite: false, rhsPending: false, ...(s.op === null ? FRESH : {}) };
      }
      return s.display.includes('.') ? s : { ...s, display: `${s.display}.` };
    }

    case 'op': {
      const sym = OPS[a.value];
      if (s.rhsPending && s.op) return { ...s, op: a.value, expr: `${fmt(s.acc)} ${sym}` };
      const cur = norm(s.display);
      const acc = s.acc !== null && s.op ? calc(s.acc, s.op, cur) : cur;   // chain: 2 + 3 + …
      return {
        ...s, acc, display: acc, op: a.value, rhsPending: true, overwrite: true,
        lastOp: null, lastRhs: null, expr: `${fmt(acc)} ${sym}`,
      };
    }

    case 'equals': {
      if (s.op && s.acc !== null) {
        const rhs = norm(s.display);
        const result = calc(s.acc, s.op, rhs);
        return {
          ...s, display: result, acc: null, op: null, rhsPending: false, overwrite: true,
          lastOp: s.op, lastRhs: rhs, expr: `${fmt(s.acc)} ${OPS[s.op]} ${fmt(rhs)} =`,
        };
      }
      if (s.lastOp && s.lastRhs !== null) {                                  // 2 + 3 = = → 8
        const left = norm(s.display);
        const result = calc(left, s.lastOp, s.lastRhs);
        return { ...s, display: result, overwrite: true, expr: `${fmt(left)} ${OPS[s.lastOp]} ${fmt(s.lastRhs)} =` };
      }
      return { ...s, display: norm(s.display), overwrite: true };
    }

    case 'percent': {
      const cur = parseDec(s.display);
      const base = s.acc !== null && (s.op === '+' || s.op === '-')
        ? div100(mul(parseDec(s.acc), cur))      // 200 + 10 %  →  20
        : div100(cur);                           // 200 × 10 %  →  0.1
      return { ...s, display: toStr(fit(base)), rhsPending: false, overwrite: true };
    }

    case 'negate': {
      if (s.rhsPending) return { ...s, display: '-0', rhsPending: false, overwrite: false };
      if (s.display.startsWith('-')) return { ...s, display: s.display.slice(1) };
      if (s.display === '0' && s.overwrite) return s;
      return { ...s, display: `-${s.display}` };
    }

    case 'back': {
      if (s.rhsPending) return s;
      let d = s.display.slice(0, -1);
      if (d === '' || d === '-') d = '0';
      return { ...s, display: d, overwrite: false, expr: s.op ? s.expr : '' };
    }

    default:
      return s;
  }
}

function reducer(state, action) {
  if (action.type === 'clear') return INITIAL;
  let s = state;
  if (s.error) {                                   // any key after an error starts clean
    if (action.type === 'back') return INITIAL;
    s = INITIAL;
  }
  try {
    return step(s, action);
  } catch (err) {
    return { ...INITIAL, error: true, display: err.message === 'DIV0' ? 'Cannot divide by 0' : 'Number too large' };
  }
}

/* =====================================================================
   KEYPAD LAYOUT
   ===================================================================== */
const KEYS = [
  { id: 'clear', label: 'C', kind: 'fn', aria: 'Clear' },
  { id: 'back', label: '⌫', kind: 'fn', aria: 'Backspace' },
  { id: 'percent', label: '%', kind: 'fn', aria: 'Percent' },
  { id: 'op', value: '/', label: '÷', kind: 'op', aria: 'Divide' },
  { id: 'digit', value: '7', label: '7', kind: 'num' },
  { id: 'digit', value: '8', label: '8', kind: 'num' },
  { id: 'digit', value: '9', label: '9', kind: 'num' },
  { id: 'op', value: '*', label: '×', kind: 'op', aria: 'Multiply' },
  { id: 'digit', value: '4', label: '4', kind: 'num' },
  { id: 'digit', value: '5', label: '5', kind: 'num' },
  { id: 'digit', value: '6', label: '6', kind: 'num' },
  { id: 'op', value: '-', label: '−', kind: 'op', aria: 'Subtract' },
  { id: 'digit', value: '1', label: '1', kind: 'num' },
  { id: 'digit', value: '2', label: '2', kind: 'num' },
  { id: 'digit', value: '3', label: '3', kind: 'num' },
  { id: 'op', value: '+', label: '+', kind: 'op', aria: 'Add' },
  { id: 'negate', label: '+/-', kind: 'fn', aria: 'Change sign' },
  { id: 'digit', value: '0', label: '0', kind: 'num' },
  { id: 'dot', label: '.', kind: 'num', aria: 'Decimal point' },
  { id: 'equals', label: '=', kind: 'eq', aria: 'Equals' },
];

/* =====================================================================
   STORAGE (remembers position + open/closed between visits)
   ===================================================================== */
const readSaved = (key) => {
  try { return JSON.parse(window.localStorage.getItem(key)) || null; } catch { return null; }
};
const writeSaved = (key, value) => {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
};

/* =====================================================================
   COMPONENT
   ===================================================================== */
export default function DraggableCalculator({
  defaultOpen = true,
  storageKey = 'vk_calculator_v1',
  zIndex = 1500,            // above the admin header (1000), below modals (2000)
}) {
  const [calc_, dispatch] = useReducer(reducer, INITIAL);
  const [open, setOpen] = useState(() => {
    const saved = typeof window !== 'undefined' ? readSaved(storageKey) : null;
    if (saved && typeof saved.open === 'boolean') return saved.open;
    return defaultOpen && (typeof window === 'undefined' || window.innerWidth >= 600); // phones start minimised
  });
  const [pos, setPos] = useState(null);                 // null until first measured (avoids a flash)

  const rootRef = useRef(null);
  const dragRef = useRef(null);
  const anchorRef = useRef(null);
  const openRef = useRef(open);
  openRef.current = open;
  const posRef = useRef(null);
  posRef.current = pos;

  /* ---------- keep the box inside the viewport ---------- */
  const clampPos = useCallback((p) => {
    const el = rootRef.current;
    const w = el ? el.offsetWidth : 0;
    const h = el ? el.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      x: Math.round(Math.min(Math.max(EDGE, p.x), Math.max(EDGE, vw - w - EDGE))),
      y: Math.round(Math.min(Math.max(EDGE, p.y), Math.max(EDGE, vh - h - EDGE))),
    };
  }, []);

  /* first paint: bottom-right corner (or the remembered spot) */
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const saved = readSaved(storageKey);
    const start = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? { x: saved.x, y: saved.y }
      : { x: window.innerWidth - el.offsetWidth - MARGIN, y: window.innerHeight - el.offsetHeight - MARGIN };
    setPos(clampPos(start));
  }, [clampPos, storageKey]);

  /* opening / minimising changes the size → keep the nearest corner fixed */
  useLayoutEffect(() => {
    const el = rootRef.current;
    const a = anchorRef.current;
    if (!el || !a) return;
    anchorRef.current = null;
    setPos(clampPos({
      x: a.right ? a.rect.right - el.offsetWidth : a.rect.left,
      y: a.bottom ? a.rect.bottom - el.offsetHeight : a.rect.top,
    }));
  }, [open, clampPos]);

  /* viewport / element size changes (rotation, resize, browser bars, open/close) */
  useEffect(() => {
    const refit = () => setPos((p) => {
      if (!p) return p;
      const c = clampPos(p);
      return c.x === p.x && c.y === p.y ? p : c;
    });
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
    let ro;
    if (typeof ResizeObserver !== 'undefined' && rootRef.current) {
      ro = new ResizeObserver(refit);
      ro.observe(rootRef.current);
    }
    return () => {
      window.removeEventListener('resize', refit);
      window.removeEventListener('orientationchange', refit);
      if (ro) ro.disconnect();
    };
  }, [clampPos]);

  /* remember position + state (not on every pixel of a drag) */
  useEffect(() => {
    if (pos && !dragRef.current) writeSaved(storageKey, { x: pos.x, y: pos.y, open });
  }, [pos, open, storageKey]);

  const setOpenAnchored = useCallback((next) => {
    const el = rootRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      anchorRef.current = {
        rect,
        right: rect.left + rect.width / 2 > window.innerWidth / 2,
        bottom: rect.top + rect.height / 2 > window.innerHeight / 2,
      };
    }
    setOpen(next);
  }, []);

  /* ---------- dragging (mouse, touch and pen through Pointer Events) ---------- */
  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest && e.target.closest('[data-nodrag]')) return;
    const p = pos || { x: 0, y: 0 };
    dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y, moved: false };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported */ }
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;       // ignore tiny jitter so taps stay taps
    d.moved = true;
    setPos(clampPos({ x: d.ox + dx, y: d.oy + dy }));
  };

  const endDrag = (e, cancelled) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return null;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (d.moved && posRef.current) writeSaved(storageKey, { x: posRef.current.x, y: posRef.current.y, open: openRef.current });
    return cancelled ? true : d.moved;
  };

  const dragProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: (e) => endDrag(e, false),
    onPointerCancel: (e) => endDrag(e, true),
  };

  /* ---------- keys ---------- */
  const press = (key) => {
    if (key.id === 'digit' || key.id === 'op') dispatch({ type: key.id, value: key.value });
    else dispatch({ type: key.id });
  };

  const onKeyDown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const onButton = e.target && e.target.tagName === 'BUTTON';
    if ((k === 'Enter' || k === ' ') && onButton) return;  // let the focused button handle it
    let action = null;
    if (/^[0-9]$/.test(k)) action = { type: 'digit', value: k };
    else if (k === '.' || k === ',') action = { type: 'dot' };
    else if (k === '+' || k === '-') action = { type: 'op', value: k };
    else if (k === '*' || k === 'x' || k === 'X') action = { type: 'op', value: '*' };
    else if (k === '/') action = { type: 'op', value: '/' };
    else if (k === '%') action = { type: 'percent' };
    else if (k === 'Enter' || k === '=') action = { type: 'equals' };
    else if (k === 'Backspace') action = { type: 'back' };
    else if (k === 'Delete' || k === 'c' || k === 'C') action = { type: 'clear' };
    else if (k === 'Escape') { e.preventDefault(); setOpenAnchored(false); return; }
    if (action) { e.preventDefault(); dispatch(action); }
  };

  /* ---------- display ---------- */
  const shown = fmt(calc_.display);
  const len = shown.length;
  const base = calc_.error ? 20 : len <= 9 ? 36 : len <= 12 ? 30 : len <= 15 ? 25 : 20;
  const activeOp = calc_.rhsPending ? calc_.op : null;

  /* ---------- render ---------- */
  const rootStyle = {
    position: 'fixed',
    left: 0,
    top: 0,
    zIndex,
    transform: pos ? `translate3d(${pos.x}px, ${pos.y}px, 0)` : 'translate3d(0, 0, 0)',
    visibility: pos ? 'visible' : 'hidden',
  };

  return (
    <>
      <style>{CSS}</style>

      <div
        ref={rootRef}
        className={`vkcalc ${open ? 'vkcalc--open' : 'vkcalc--min'}`}
        style={rootStyle}
        onKeyDown={open ? onKeyDown : undefined}
        role="group"
        aria-label="Calculator"
      >
        {open ? (
          <div className="vkcalc-panel">
            {/* drag handle */}
            <div className="vkcalc-head" {...dragProps}>
              <span className="vkcalc-grip" aria-hidden="true">
                <i /><i /><i /><i /><i /><i />
              </span>
              <span className="vkcalc-title">Calculator</span>
              <button
                type="button"
                className="vkcalc-min"
                data-nodrag
                aria-label="Minimise calculator"
                title="Minimise"
                onClick={() => setOpenAnchored(false)}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <path d="M5 12h14" />
                </svg>
              </button>
            </div>

            {/* display */}
            <div className="vkcalc-screen">
              <div className="vkcalc-expr" aria-hidden="true">{calc_.expr || '\u00A0'}</div>
              <div
                className={`vkcalc-value ${calc_.error ? 'is-error' : ''}`}
                role="status"
                aria-live="polite"
                aria-label={`Result ${shown}`}
                style={{ fontSize: `clamp(16px, min(${base}px, 8.5vw), ${base}px)` }}
              >
                {shown}
              </div>
            </div>

            {/* keypad */}
            <div className="vkcalc-keys">
              {KEYS.map((key) => (
                <button
                  key={`${key.id}${key.value || ''}`}
                  type="button"
                  className={`vkcalc-key vkcalc-key--${key.kind}`}
                  aria-label={key.aria || key.label}
                  aria-pressed={key.id === 'op' ? activeOp === key.value : undefined}
                  data-active={key.id === 'op' && activeOp === key.value ? 'true' : undefined}
                  onClick={() => press(key)}
                >
                  {key.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="vkcalc-fab"
            aria-label="Open calculator (drag to move)"
            title="Calculator"
            {...dragProps}
            onPointerUp={(e) => { if (endDrag(e, false) === false) setOpenAnchored(true); }}
            onClick={(e) => { if (e.detail === 0) setOpenAnchored(true); }}   /* keyboard: Enter / Space */
          >
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="2.5" width="16" height="19" rx="3" />
              <rect x="7.5" y="5.5" width="9" height="3.5" rx="0.8" />
              <path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01" strokeWidth="2.6" />
            </svg>
          </button>
        )}
      </div>
    </>
  );
}

/* =====================================================================
   INTERNAL CSS
   ===================================================================== */
const CSS = `
.vkcalc, .vkcalc * { box-sizing: border-box; }
.vkcalc {
  font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #f5f5f7;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  will-change: transform;
}

/* ----- panel ----- */
.vkcalc-panel {
  width: min(320px, calc(100vw - 8px));
  max-height: calc(100vh - 8px);
  overflow: hidden auto;
  background: linear-gradient(160deg, #1a1a21 0%, #0d0d11 100%);
  border: 1px solid #2c2c38;
  border-radius: 18px;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.65), 0 0 0 1px rgba(255, 0, 51, 0.12);
}
.vkcalc-head {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 8px 8px 12px;
  cursor: grab; touch-action: none;                /* lets a finger drag instead of scrolling */
  border-bottom: 1px solid #25252f;
}
.vkcalc-head:active { cursor: grabbing; }
.vkcalc-grip { display: grid; grid-template-columns: repeat(3, 4px); gap: 3px; opacity: 0.55; }
.vkcalc-grip i { width: 4px; height: 4px; border-radius: 50%; background: #b0b0bd; display: block; }
.vkcalc-title { flex: 1; font-size: 0.82rem; font-weight: 600; color: #c9c9d3; letter-spacing: 0.2px; }
.vkcalc-min {
  width: 32px; height: 32px; display: grid; place-items: center; cursor: pointer;
  background: transparent; color: #b0b0bd; border: 0; border-radius: 10px; touch-action: manipulation;
}
.vkcalc-min:hover { background: #25252f; color: #fff; }

/* ----- display ----- */
.vkcalc-screen { padding: 10px 16px 6px; text-align: right; }
.vkcalc-expr { min-height: 18px; font-size: 0.78rem; color: #8d8d9b; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; }
.vkcalc-value {
  min-height: 46px; display: flex; align-items: center; justify-content: flex-end;
  font-weight: 600; line-height: 1.1; letter-spacing: 0.3px; color: #fff;
  font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden;
}
.vkcalc-value.is-error { color: #ff8da0; font-weight: 500; }

/* ----- keys ----- */
.vkcalc-keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: clamp(6px, 1.6vw, 9px); padding: 8px 12px 14px; }
.vkcalc-key {
  height: clamp(40px, 6.6vh, 54px);
  font: 500 1.15rem "Inter", system-ui, sans-serif;
  color: #f3f3f6; background: #22222b;
  border: 1px solid #2d2d39; border-radius: 14px;
  cursor: pointer; touch-action: manipulation;
  transition: background 0.12s, transform 0.08s, border-color 0.12s;
}
.vkcalc-key:hover { background: #2b2b36; }
.vkcalc-key:active { transform: scale(0.95); }
.vkcalc-key--fn { background: #2c2c38; color: #ffb3c0; font-size: 1rem; }
.vkcalc-key--fn:hover { background: #363644; }
.vkcalc-key--op { background: rgba(255, 0, 51, 0.15); color: #ff8da0; border-color: rgba(255, 0, 51, 0.35); font-size: 1.3rem; }
.vkcalc-key--op:hover { background: rgba(255, 0, 51, 0.26); }
.vkcalc-key--op[data-active="true"] { background: #ff8da0; color: #1a0007; border-color: #ff8da0; }
.vkcalc-key--eq { background: #ff0033; border-color: #ff0033; color: #fff; font-size: 1.3rem; }
.vkcalc-key--eq:hover { background: #ff2a55; }

.vkcalc-key:focus-visible, .vkcalc-min:focus-visible, .vkcalc-fab:focus-visible {
  outline: 2px solid #ff4d6a; outline-offset: 2px;
}

/* ----- minimised button ----- */
.vkcalc-fab {
  width: 56px; height: 56px; display: grid; place-items: center; cursor: grab;
  color: #fff; background: linear-gradient(145deg, #ff0033, #b30024);
  border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 50%;
  box-shadow: 0 10px 26px rgba(255, 0, 51, 0.4), 0 4px 10px rgba(0, 0, 0, 0.6);
  touch-action: none;
  transition: transform 0.12s;
}
.vkcalc-fab:active { cursor: grabbing; transform: scale(0.94); }

/* ----- short screens (phones in landscape) ----- */
@media (max-height: 560px) {
  .vkcalc-key { height: 34px; font-size: 1rem; border-radius: 10px; }
  .vkcalc-keys { padding-bottom: 10px; gap: 5px; }
  .vkcalc-value { min-height: 36px; }
  .vkcalc-screen { padding-top: 6px; }
}
@media (max-width: 360px) {
  .vkcalc-key { font-size: 1.02rem; }
  .vkcalc-fab { width: 52px; height: 52px; }
}
@media (prefers-reduced-motion: reduce) {
  .vkcalc-key, .vkcalc-fab { transition: none; }
}
@media print { .vkcalc { display: none !important; } }
`;
