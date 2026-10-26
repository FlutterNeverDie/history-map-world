"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  MAP_BOTTOM,
  MAP_HEIGHT,
  MAP_TOP,
  MAP_WIDTH,
  normalizeLon,
  yOfLat,
} from "./useMapViewport";
import { mapCover, useMapCover, type MapCover } from "./mapCover";
import { tiltTransform, untilt } from "./tilt";
import { swallowNextClick } from "./ghostClick";
import { cubicBezier } from "./gl/ease";
import type { GlView } from "./gl/renderer";
import { useMapTilt } from "./tiltStore";

/**
 * WebGL 지도 뷰포트(도메인 모름) - 주제 지도·전쟁 지도의 WebGL 판이 쓴다. 본 지도(features/map WorldMap)와 같은 손짓·카메라:
 * - 끌기(놓으면 관성), 휠(커서 고정), 두 손가락 핀치, 두 번 클릭·손가락 두 번 탭 확대
 * - 기울이기(0~55°)·바라보는 방향(아무 각도): 마우스 오른쪽 단추·Ctrl(⌘)·Shift + 끌기(위아래 = 기울기, 좌우 = 방향),
 *   두 손가락 비틀기 = 방향, 두 손가락을 나란히 같이 위아래로 = 기울기. 북쪽 4° 안이면 북쪽에 맞춘다
 * - 나침반(Compass)용 값·조작: 되돌리기(resetView)는 0.45초 동안 북쪽이 위·평평하게, 잡고 돌리기(turnTo)
 * - 카메라 식은 본 지도와 같다: 판(돌렸으면 지도 칸 대각선 정사각형) 위 자리 → 지도 칸 가운데 축 회전 → CSS 기울기 행렬(GlView)
 * WebGL 판은 화면 값(ref)을 매 프레임 읽어 그리므로(getView) 손짓 중에는 React 렌더가 없다.
 * 배율(zoom 상태)은 손을 떼고 쉴 때 한 번 바꾼다 - 글자 판·표식처럼 배율에 따라 다시 만드는 것은 그때.
 */
const MAX_ZOOM = 16;
/** store/ui의 MAX_TILT(본 지도)와 같은 값 */
const MAX_TILT = 55;
/** 이 픽셀보다 적게 움직이면 끌기가 아니라 탭 */
const TAP_SLOP = 5;
/** 핀치하다가 두 손가락이 이만큼(도) 기울면 돌리기도 같이(본 지도 WorldMap과 같은 값) */
const SPIN_START = 15;

type Size = { w: number; h: number };
type Turn = { rot: number; tx: number; ty: number };

/** 판 크기: 북쪽이 위면 지도 칸 그대로, 돌렸거나 돌리는 중이면 지도 칸 대각선 정사각형(어느 각도에서도 모서리가 비지 않음) */
const planeSize = (frame: Size, square: boolean): Size => {
  if (!square) return frame;
  const d = Math.hypot(frame.w, frame.h);
  return { w: d, h: d };
};
/** 화면 방향(px)을 판 방향으로(판은 지도 칸 가운데를 축으로 -heading 돌아 있어 +heading 돌린다) */
function turnVec(x: number, y: number, heading: number): [number, number] {
  const a = (heading * Math.PI) / 180;
  const c = Math.round(Math.cos(a) * 1e9) / 1e9;
  const s = Math.round(Math.sin(a) * 1e9) / 1e9;
  return [x * c - y * s, x * s + y * c];
}

/** 누른 자리(client px)에서 가장 가까운 점(지도 좌표) - reach는 핀 그림 단위 */
type Nearest = <T extends { x: number; y: number }>(
  points: T[],
  cx: number,
  cy: number,
  reach?: number,
) => T | null;

type Gesture = {
  x: number;
  y: number;
  lon: number;
  centerY: number;
  moved: boolean;
  pinch?: { dist: number; zoom: number };
  samples?: [number, number, number][];
  tilt?: {
    x: number;
    y: number;
    from: number;
    heading: number;
    pivot: [number, number] | null;
  };
  /** 두 손가락 비틀기로 돌리기(핀치와 같이): 지난 움직임 때 두 손가락 각도(도, 화면)와 방향 */
  spin?: { angle: number; from: number };
  pair?: { midY: number; angle: number; decided: boolean };
  /** 두 손가락 가운데(화면 client px) - 지난 움직임 때. 그 밑의 지도가 손가락을 따라 옮겨 간다 */
  mid?: [number, number];
};

export function useGlViewport(
  initial: { lon: number; lat: number; zoom: number },
  /** 끌기가 아닌 짧은 탭(화면 client px) - 무엇을 눌렀는지는 같이 넘기는 nearest로 */
  onTap: (cx: number, cy: number, nearest: Nearest) => void,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** WebGL 판(GlCanvas) - 화면 값이 바뀌면 다시 그리게 */
  const canvasRef = useRef<{ request: () => void } | null>(null);
  const request = () => canvasRef.current?.request();

  const lonRef = useRef(initial.lon);
  const cyRef = useRef(yOfLat(initial.lat));
  const zoomRef = useRef(initial.zoom);
  const [zoom, setZoom] = useState(initial.zoom);
  const tiltRef = useRef(0);
  // 기울기 상태는 설정 메뉴 슬라이더와 같이 쓰는 저장소(tiltStore) - 손짓·나침반은 끝날 때 저장소에 쓰고,
  // 슬라이더가 바꾸면(손짓·되돌리기 애니메이션 중이 아닐 때) 판에 바로 반영한다
  const tilt = useMapTilt((s) => s.tilt);
  const setTilt = useMapTilt((s) => s.setTilt);
  // 지도가 처음 뜰 때는 평평하게(다른 지도에서 기울인 값이 남지 않게)
  useEffect(() => setTilt(0), [setTilt]);
  /** 방향 0~359(판에 쓰는 값). 상태(heading)는 돌린 만큼 계속 더한 값 - 나침반 바늘이 359 → 0에서 짧게 돈다 */
  const headingRef = useRef(0);
  const [heading, setHeading] = useState(0);
  const headingRaw = useRef(0);
  const [spinning, setSpinning] = useState(false);
  const [frame, setFrame] = useState<Size | null>(null);
  // 북쪽이 위가 아닌가(돌린 만큼 더한 값이라 360의 배수면 북쪽)
  const square =
    Math.abs((((heading % 360) + 540) % 360) - 180) > 1e-6 || spinning;
  const size = frame && planeSize(frame, square);
  const screenCover = useMapCover(hostRef);
  // 돌린 정사각형 판은 화면보다 커서 덮인 곳까지 이미 지도가 있다 - 세로 한계를 늘리지 않는다
  const cover: MapCover = square ? { top: 0, bottom: 0 } : screenCover;
  const geom = useRef({ frame, size, cover });
  useLayoutEffect(() => {
    geom.current = { frame, size, cover };
    canvasRef.current?.request();
  });

  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef(
    new Map<number, { x: number; y: number; sx: number; sy: number }>(),
  );
  const momentum = useRef(0);
  /** 이동(focusTo)·되돌리기 애니메이션 중 */
  const anim = useRef(0);
  // 설정 메뉴 슬라이더가 기울기를 바꾸면 판에 바로(손짓·되돌리기 애니메이션 중에는 그쪽이 tiltRef를 쓴다)
  useEffect(() => {
    if (gesture.current || anim.current || tiltRef.current === tilt) return;
    tiltRef.current = tilt;
    request();
  }, [tilt]);
  const turn = useRef<Turn | null>(null);
  const settleTimer = useRef(0);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const touchZoomAt = useRef(0);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setFrame({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 보이는 범위(지도 좌표): 배율 1 = 위도 전체가 지도 칸 높이. 판이 크면(돌림) 더 넓게. 가로는 늘 가운데(가로 이동은 경도) */
  const view = useCallback((k: number, cy: number) => {
    const { size, frame, cover } = geom.current;
    const h =
      size && frame ? (MAP_HEIGHT * size.h) / (k * frame.h) : MAP_HEIGHT / k;
    const w = size ? (h * size.w) / size.h : MAP_WIDTH / k;
    const unit = size ? h / size.h : 0;
    const lo = MAP_TOP - cover.top * unit;
    const hi = MAP_BOTTOM - h + cover.bottom * unit;
    const y = hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, cy - h / 2));
    return { x: (MAP_WIDTH - w) / 2, y, w, h };
  }, []);
  /** 세로 가운데를 보이는 범위 안으로(끌어서 한계를 넘긴 만큼 쌓이지 않게) */
  const clampY = () => {
    const v = view(zoomRef.current, cyRef.current);
    cyRef.current = v.y + v.h / 2;
  };
  const frameRect = () => hostRef.current?.getBoundingClientRect();
  /** 판(돌리기 전) 위치·크기 - toPlane이 돌려 주는 점과 같은 기준 */
  const mapRect = () => {
    const r = frameRect();
    const s = geom.current.size;
    if (!r || !s) return r;
    return new DOMRect(
      r.left + (r.width - s.w) / 2,
      r.top + (r.height - s.h) / 2,
      s.w,
      s.h,
    );
  };
  /** 화면 점(client px) → 기울이고 돌리기 전 판 위 점 */
  const toPlane = (cx: number, cy: number): [number, number] => {
    const t = tiltRef.current;
    const h = headingRef.current;
    const rect = t || h ? frameRect() : null;
    if (!rect) return [cx, cy];
    const [x, y] = t ? untilt(rect, t, cx, cy) : [cx, cy];
    if (!h) return [x, y];
    const ox = rect.left + rect.width / 2;
    const oy = rect.top + rect.height / 2;
    const [dx, dy] = turnVec(x - ox, y - oy, h);
    return [ox + dx, oy + dy];
  };
  /**
   * 지도 위 패널·시트·제목에 가려지지 않은 영역의 가운데가 지도 칸 가운데에서 떨어진 양(px, 화면) - 가운데를 옮길 쪽.
   * 패널이 오른쪽이면 x > 0, 왼쪽(아랍어)이면 x < 0
   */
  const overlayOffset = () => {
    const host = hostRef.current;
    const rect = frameRect();
    if (!host || !rect) return { x: 0, y: 0 };
    const { top, bottom } = mapCover(host);
    const y = (bottom - top) / 2;
    const panel = document
      .querySelector("[data-map-overlay]")
      ?.getBoundingClientRect();
    if (!panel || panel.height <= 0 || panel.width >= rect.width * 0.8)
      return { x: 0, y };
    return {
      x:
        panel.left > rect.left + rect.width / 2
          ? (rect.right - panel.left) / 2
          : -(panel.right - rect.left) / 2,
      y,
    };
  };
  /** 돌리는 축: 가려지지 않은 영역의 가운데(화면 점) */
  const pivot = (): [number, number] | null => {
    const r = frameRect();
    if (!r) return null;
    const off = overlayOffset();
    return [r.left + r.width / 2 - off.x, r.top + r.height / 2 - off.y];
  };

  /** 손을 떼고 쉴 때 배율 상태를 바꾼다(글자 판·표식을 그 배율로 다시) */
  const settle = (ms = 150) => {
    window.clearTimeout(settleTimer.current);
    request();
    settleTimer.current = window.setTimeout(() => {
      if (gesture.current || momentum.current || anim.current) return;
      setZoom(zoomRef.current);
      request();
    }, ms);
  };

  /** 판 위 점(px, py)을 고정점으로 배율을 바꾼다 */
  const zoomAt = (next: number, px: number, py: number) => {
    const rect = mapRect();
    const k = zoomRef.current;
    const nk = Math.min(MAX_ZOOM, Math.max(1, next));
    if (!rect || nk === k) return;
    const fx = (px - rect.left) / rect.width;
    const fy = (py - rect.top) / rect.height;
    const before = view(k, cyRef.current);
    const mx = before.x + fx * before.w;
    const my = before.y + fy * before.h;
    const after = view(nk, cyRef.current);
    lonRef.current = normalizeLon(
      lonRef.current - ((after.x + fx * after.w - mx) * 360) / MAP_WIDTH,
    );
    cyRef.current = my - fy * after.h + after.h / 2;
    zoomRef.current = nk;
    clampY();
    request();
  };

  /** 손짓으로 돌리기: 화면 점 (px, py) 밑의 지도가 그 자리에 있도록 가운데를 같이 옮긴다 */
  const spinTo = (h: number, px: number, py: number) => {
    const rect = mapRect();
    if (!rect) return;
    const next = ((h % 360) + 360) % 360;
    const [x0, y0] = toPlane(px, py);
    headingRef.current = next;
    const [x1, y1] = toPlane(px, py);
    const upp = view(zoomRef.current, cyRef.current).h / rect.height;
    lonRef.current = normalizeLon(
      lonRef.current + ((x0 - x1) * upp * 360) / MAP_WIDTH,
    );
    cyRef.current += (y0 - y1) * upp;
    request();
  };
  /** 두 손가락 옮기기: 화면 점 (x0, y0) 밑에 있던 지도가 (x1, y1)로 오게 */
  const panScreen = (x0: number, y0: number, x1: number, y1: number) => {
    const rect = mapRect();
    if (!rect) return;
    const [ax, ay] = toPlane(x0, y0);
    const [bx, by] = toPlane(x1, y1);
    clampY();
    const upp = view(zoomRef.current, cyRef.current).h / rect.height;
    lonRef.current = normalizeLon(
      lonRef.current - ((bx - ax) * upp * 360) / MAP_WIDTH,
    );
    cyRef.current -= (by - ay) * upp;
    request();
  };
  /** 돌리기를 끝내며 저장: 북쪽에서 4° 안이면 북쪽에 맞추고 판을 원래 크기로 */
  const endSpin = (at: [number, number] | null) => {
    let h = headingRef.current;
    if ((h < 4 || h > 356) && at) {
      spinTo(0, at[0], at[1]);
      h = 0;
    }
    const raw = headingRaw.current;
    headingRaw.current = raw + ((((h - raw) % 360) + 540) % 360) - 180;
    setHeading(headingRaw.current);
    if (!h) setSpinning(false);
    settle();
  };

  const stopAnim = () => {
    cancelAnimationFrame(momentum.current);
    momentum.current = 0;
    cancelAnimationFrame(anim.current);
    anim.current = 0;
  };

  /** 관성: 끌다 놓은 속도(px/ms)로 미끄러지다 멈춘다(본 지도와 같은 감속 325ms) */
  const fling = (vx: number, vy: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const rect = mapRect();
      if (!rect) {
        momentum.current = 0;
        return settle();
      }
      const upp = view(zoomRef.current, cyRef.current).h / rect.height;
      lonRef.current = normalizeLon(
        lonRef.current - (vx * dt * upp * 360) / MAP_WIDTH,
      );
      cyRef.current -= vy * dt * upp;
      clampY();
      const k = Math.exp(-dt / 325);
      vx *= k;
      vy *= k;
      request();
      if (Math.hypot(vx, vy) < 0.02) {
        momentum.current = 0;
        return settle();
      }
      momentum.current = requestAnimationFrame(step);
    };
    momentum.current = requestAnimationFrame(step);
  };

  /** 좌표로 부드럽게 이동·확대(0.7초) - 가려지지 않은 영역의 가운데로. 돌려 주는 함수로 그만둔다 */
  const focusTo = (coords: [number, number], minZoom: number) => {
    const rect = frameRect();
    if (!rect) return () => {};
    stopAnim();
    const off = overlayOffset();
    const [ox, oy] = turnVec(off.x, off.y, headingRef.current);
    clampY();
    const from = {
      lon: lonRef.current,
      cy: cyRef.current,
      zoom: zoomRef.current,
    };
    const toZoom = Math.min(MAX_ZOOM, Math.max(from.zoom, minZoom));
    const upp = MAP_HEIGHT / toZoom / rect.height;
    const toLon = coords[0] + (ox * upp * 360) / MAP_WIDTH;
    const toY = yOfLat(coords[1]) + oy * upp;
    const dLon = normalizeLon(toLon - from.lon);
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      lonRef.current = normalizeLon(from.lon + dLon * k);
      cyRef.current = from.cy + (toY - from.cy) * k;
      zoomRef.current = from.zoom + (toZoom - from.zoom) * k;
      request();
      if (t < 1) anim.current = requestAnimationFrame(tick);
      else {
        anim.current = 0;
        clampY();
        settle(0);
      }
    };
    anim.current = requestAnimationFrame(tick);
    return () => {
      if (!anim.current) return;
      cancelAnimationFrame(anim.current);
      anim.current = 0;
      settle(0);
    };
  };

  /** 나침반 누르기: 북쪽이 위·평평하게(0.45초). 축은 가려지지 않은 영역 가운데 - 보던 곳이 그대로 있게 */
  const resetView = () => {
    stopAnim();
    const from = headingRef.current;
    const fromTilt = tiltRef.current;
    const rect = frameRect();
    headingRaw.current = Math.round(headingRaw.current / 360) * 360;
    setHeading(headingRaw.current);
    setTilt(0);
    let delta = 0;
    let o = { x: 0, y: 0 };
    let r: [number, number] = [0, 0];
    if (from && rect) {
      const off = overlayOffset();
      o = { x: -off.x, y: -off.y };
      const [ox0, oy0] = turnVec(o.x, o.y, from);
      const upp = MAP_HEIGHT / (rect.height * zoomRef.current);
      lonRef.current = normalizeLon(
        lonRef.current + ((ox0 - o.x) * upp * 360) / MAP_WIDTH,
      );
      cyRef.current += (oy0 - o.y) * upp;
      headingRef.current = 0;
      delta = ((-from + 540) % 360) - 180;
      r = turnVec(o.x, o.y, delta);
      // 도는 동안은 판을 대각선 정사각형으로 둔다(모서리가 비지 않게)
      setSpinning(true);
    }
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const tick = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / 450);
      const p = cubicBezier(0.2, 0.7, 0.2, 1, t);
      turn.current =
        delta && t < 1
          ? {
              rot: delta * (1 - p),
              tx: (o.x - r[0]) * (1 - p),
              ty: (o.y - r[1]) * (1 - p),
            }
          : null;
      tiltRef.current = fromTilt * (1 - (1 - Math.pow(1 - t, 3)));
      request();
      if (t < 1) anim.current = requestAnimationFrame(tick);
      else {
        anim.current = 0;
        tiltRef.current = 0;
        setSpinning(false);
        settle(0);
      }
    };
    anim.current = requestAnimationFrame(tick);
  };

  /** 나침반 잡고 돌리기: raw = 돌린 만큼 더한 방향 */
  const turnTo = (raw: number) => {
    const at = pivot();
    if (!at) return;
    headingRaw.current = raw;
    spinTo(raw, at[0], at[1]);
    setHeading(raw);
  };
  const turnStart = () => {
    stopAnim();
    setSpinning(true);
  };
  const turnEnd = () => endSpin(pivot());

  /** 지금 화면(ref)에서 지도 좌표 → 판 위 점(client px) */
  const planeOf = (x: number, y: number, rect: DOMRect) => {
    const vv = view(zoomRef.current, cyRef.current);
    return [
      rect.left + ((x - vv.x) / vv.w) * rect.width,
      rect.top + ((y - vv.y) / vv.h) * rect.height,
    ];
  };
  /**
   * 누른 자리(client px)에서 가장 가까운 점(지도 좌표, 경도 0 기준): 핀 그림 reach 단위(점 반지름 4 기준, 본 지도 터치 범위 16) 안에서.
   * 판 위(눕히고 돌리기 전)에서 재서 기울여도 눌린 원 모양 그대로 맞는다
   */
  const nearest: Nearest = (points, cx, cy, reach = 16) => {
    const rect = mapRect();
    const f = geom.current.frame;
    if (!rect || !f) return null;
    const [fx, fy] = toPlane(cx, cy);
    const r = (reach * 1.2 * f.h) / MAP_HEIGHT;
    const shift = (-lonRef.current * MAP_WIDTH) / 360;
    let best: (typeof points)[number] | null = null;
    let bestD = Infinity;
    for (const p of points)
      for (let k = -1; k <= 1; k++) {
        const [px, py] = planeOf(p.x + shift + k * MAP_WIDTH, p.y, rect);
        const d = Math.hypot(fx - px, fy - py);
        if (d <= r && d < bestD) {
          bestD = d;
          best = p;
        }
      }
    return best;
  };

  // 처음 한 번: 가운데가 패널에 가리지 않게 비켜 놓는다(공용 useMapViewport와 같게)
  const placed = useRef(false);
  useEffect(() => {
    const rect = frameRect();
    if (placed.current || !frame || !rect) return;
    placed.current = true;
    const off = overlayOffset();
    const upp = MAP_HEIGHT / zoomRef.current / rect.height;
    lonRef.current = normalizeLon(
      lonRef.current + (off.x * upp * 360) / MAP_WIDTH,
    );
    request();
    // 크기를 처음 잰 뒤 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  // 휠 확대(페이지 스크롤을 막아야 해서 passive: false로 직접 등록). 처리기는 최신 렌더의 것을
  const wheel = useRef((e: WheelEvent) => void e);
  useLayoutEffect(() => {
    wheel.current = (e: WheelEvent) => {
      e.preventDefault();
      stopAnim();
      const [x, y] = toPlane(e.clientX, e.clientY);
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.0015), x, y);
      settle();
    };
  });
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const on = (e: WheelEvent) => wheel.current(e);
    el.addEventListener("wheel", on, { passive: false });
    return () => el.removeEventListener("wheel", on);
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(momentum.current);
      cancelAnimationFrame(anim.current);
      window.clearTimeout(settleTimer.current);
    },
    [],
  );

  /** WebGL 판이 매 프레임 읽는 화면 */
  const getView = useCallback((): GlView | null => {
    const { frame, size } = geom.current;
    if (!frame || !size) return null;
    const t = tiltRef.current;
    return {
      v: view(zoomRef.current, cyRef.current),
      shift: (-lonRef.current * MAP_WIDTH) / 360,
      size,
      frame,
      heading: headingRef.current,
      tilt: tiltTransform(t, frame.h),
      // 기울이면 판 밖 먼 쪽도 화면 끝까지 지도로
      farSide: true,
      turn: turn.current ?? undefined,
      zoom: zoomRef.current,
      still: !gesture.current && !momentum.current && !anim.current,
    };
  }, [view]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    stopAnim();
    window.clearTimeout(settleTimer.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    const [px, py] = toPlane(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, {
      x: px,
      y: py,
      sx: e.clientX,
      sy: e.clientY,
    });
    const [a, b] = [...pointers.current.values()];
    if (
      !b &&
      e.pointerType === "mouse" &&
      (e.button === 2 || e.ctrlKey || e.metaKey || e.shiftKey)
    ) {
      gesture.current = {
        x: px,
        y: py,
        lon: lonRef.current,
        centerY: cyRef.current,
        moved: true,
        tilt: {
          x: e.clientX,
          y: e.clientY,
          from: tiltRef.current,
          heading: headingRef.current,
          pivot: pivot(),
        },
      };
      setSpinning(true);
      return;
    }
    if (b) {
      gesture.current = {
        x: a.x,
        y: a.y,
        lon: lonRef.current,
        centerY: cyRef.current,
        moved: true,
        pinch: {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          zoom: zoomRef.current,
        },
        pair: {
          midY: (a.sy + b.sy) / 2,
          angle: (Math.atan2(b.sy - a.sy, b.sx - a.sx) * 180) / Math.PI,
          decided: false,
        },
        mid: [(a.sx + b.sx) / 2, (a.sy + b.sy) / 2],
      };
      return;
    }
    clampY();
    gesture.current = {
      x: px,
      y: py,
      lon: lonRef.current,
      centerY: cyRef.current,
      moved: false,
      samples: [[e.timeStamp, px, py]],
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    if (g.tilt) {
      tiltRef.current = Math.min(
        MAX_TILT,
        Math.max(0, g.tilt.from - (e.clientY - g.tilt.y) * 0.3),
      );
      if (g.tilt.pivot)
        spinTo(
          g.tilt.heading + (e.clientX - g.tilt.x) * 0.3,
          g.tilt.pivot[0],
          g.tilt.pivot[1],
        );
      request();
      return;
    }
    const [px, py] = toPlane(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, {
      x: px,
      y: py,
      sx: e.clientX,
      sy: e.clientY,
    });
    const [a, b] = [...pointers.current.values()];
    const angle = b
      ? (Math.atan2(b.sy - a.sy, b.sx - a.sx) * 180) / Math.PI
      : 0;
    if (b && g.pinch && g.pair) {
      const mx = (a.sx + b.sx) / 2;
      const my = (a.sy + b.sy) / 2;
      const twist = ((angle - g.pair.angle + 540) % 360) - 180;
      if (!g.pair.decided) {
        // 처음 움직임으로 기울이기(옆으로 나란히 같이 위아래)만 따로 정한다. 아니면 핀치 + 옮기기(+ 돌리기)
        const moveY = my - g.pair.midY;
        const spread = Math.hypot(a.x - b.x, a.y - b.y) - g.pinch.dist;
        if (
          Math.abs(moveY) < 12 &&
          Math.abs(spread) < 12 &&
          Math.abs(twist) < 10
        )
          return;
        g.pair.decided = true;
        if (Math.abs(twist) >= 10 && Math.abs(spread) < 24) {
          // 처음부터 비틀었으면 바로 돌리기(핀치도 그대로) - 판을 정사각형으로 바꾼 뒤 이어지는 움직임부터
          g.spin = { angle, from: headingRef.current };
          setSpinning(true);
          return;
        }
        if (
          Math.abs(moveY) > 2 * Math.abs(spread) &&
          Math.abs(a.sx - b.sx) > Math.abs(a.sy - b.sy)
        ) {
          g.tilt = {
            x: e.clientX,
            y: e.clientY - moveY,
            from: tiltRef.current,
            heading: headingRef.current,
            pivot: null,
          };
          g.pinch = undefined;
          return;
        }
      } else if (!g.spin && Math.abs(twist) >= SPIN_START) {
        // 핀치하다가 비틀어도 돌리기가 붙는다(문턱을 넘은 뒤부터)
        g.spin = { angle, from: headingRef.current };
        setSpinning(true);
      }
      // 두 손가락 가운데 밑의 지도가 손가락을 따라오게: 옮기고 → 돌리고(축 = 가운데) → 확대(고정점 = 가운데)
      if (g.mid) panScreen(g.mid[0], g.mid[1], mx, my);
      g.mid = [mx, my];
      if (g.spin) {
        // 움직임마다 더해 간다(한 번에 180°를 넘겨 비틀어도 튀지 않게)
        g.spin.from -= ((angle - g.spin.angle + 540) % 360) - 180;
        g.spin.angle = angle;
        spinTo(g.spin.from, mx, my);
      }
      // 판 위 거리는 지금 방향으로 두 손가락을 다시 옮겨 잰다(먼저 움직인 손가락은 돌리기 전 방향으로 옮겨 둔 값이라)
      const [ax, ay] = toPlane(a.sx, a.sy);
      const [bx, by] = toPlane(b.sx, b.sy);
      const [qx, qy] = toPlane(mx, my);
      zoomAt(
        g.pinch.zoom * (Math.hypot(ax - bx, ay - by) / g.pinch.dist),
        qx,
        qy,
      );
      return;
    }
    if (b) return;
    const dx = px - g.x;
    const dy = py - g.y;
    if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    g.moved = true;
    const upp =
      view(zoomRef.current, cyRef.current).h / (mapRect()?.height ?? 1);
    g.samples?.push([e.timeStamp, px, py]);
    if (g.samples && g.samples.length > 6) g.samples.shift();
    lonRef.current = normalizeLon(g.lon - dx * upp * (360 / MAP_WIDTH));
    cyRef.current = g.centerY - dy * upp;
    request();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.tilt || g?.spin) {
      gesture.current = null;
      if (g.tilt) setTilt(tiltRef.current);
      if (g.tilt?.pivot || g.spin) endSpin(g.tilt?.pivot ?? pivot());
      else settle();
      return;
    }
    const [px, py] = toPlane(e.clientX, e.clientY);
    if (pointers.current.size > 0) {
      // 핀치 중 한 손가락만 뗐으면 남은 손가락으로 이어서 끌기
      const [rest] = [...pointers.current.values()];
      clampY();
      if (g)
        gesture.current = {
          ...g,
          pinch: undefined,
          x: rest.x,
          y: rest.y,
          lon: lonRef.current,
          centerY: cyRef.current,
          samples: [[e.timeStamp, rest.x, rest.y]],
        };
      return;
    }
    gesture.current = null;
    if (!g) return;
    if (g.moved) {
      clampY();
      const recent = (g.samples ?? []).filter(([t]) => e.timeStamp - t < 100);
      const [t0, x0, y0] = recent[0] ?? [0, 0, 0];
      const dt = e.timeStamp - t0;
      const vx = dt > 0 ? (px - x0) / dt : 0;
      const vy = dt > 0 ? (py - y0) / dt : 0;
      if (!g.pinch && recent.length > 1 && Math.hypot(vx, vy) > 0.3)
        fling(vx, vy);
      else settle();
      return;
    }
    // 손가락 두 번 탭 = 확대(iOS는 touch-none 지도에서 dblclick이 오지 않을 때가 있어 직접 판정)
    if (e.pointerType === "touch") {
      const now = Date.now();
      const p = lastTap.current;
      if (
        p &&
        now - p.t < 320 &&
        Math.hypot(e.clientX - p.x, e.clientY - p.y) < 30
      ) {
        lastTap.current = null;
        touchZoomAt.current = now;
        zoomAt(zoomRef.current * 2, px, py);
        settle(0);
        return;
      }
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
    // 탭으로 연 패널이 뒤따르는 click에 바로 닫히지 않게(ghostClick.ts)
    swallowNextClick();
    onTap(e.clientX, e.clientY, nearest);
  };

  const hostProps = {
    ref: hostRef,
    "data-map-frame": true,
    // svg 지도(WebGL 없음)를 기울이면 먼 쪽 너머로 하늘이 보인다 - WebGL 판은 화면 끝까지 지도를 그린다
    style: { background: "linear-gradient(var(--map-sky), var(--map-ocean))" },
    className:
      "absolute inset-0 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(e.pointerId);
      const g = gesture.current;
      gesture.current = null;
      if (g?.tilt || g?.spin) {
        setTilt(tiltRef.current);
        endSpin(pivot());
      } else settle();
    },
    onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
      if (Date.now() - touchZoomAt.current < 600) return;
      const [x, y] = toPlane(e.clientX, e.clientY);
      zoomAt(zoomRef.current * 2, x, y);
      settle(0);
    },
    // 오른쪽 단추로 끌어 기울이므로 메뉴는 띄우지 않는다
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  };

  return {
    hostProps,
    canvasRef,
    getView,
    /** 쉴 때 정해진 배율(글자 판·표식 기준) */
    zoom,
    /** 지도 칸 크기(px) */
    frame,
    focusTo,
    nearest,
    /** 나침반(Compass)에 넘길 값·조작 */
    compass: {
      heading,
      tilt,
      onReset: resetView,
      onTurnStart: turnStart,
      onTurn: turnTo,
      onTurnEnd: turnEnd,
    },
  };
}
