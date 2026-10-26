"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { geoGraticule10, geoPath } from "d3-geo";
import {
  MAP_BOTTOM,
  MAP_HEIGHT,
  MAP_TOP,
  MAP_WIDTH,
  makeProjection,
  normalizeLon,
  yOfLat,
} from "./projection";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { swallowNextClick } from "./ghostClick";
import { mapCover, useMapCover } from "./mapCover";
import { useHydrated } from "./useHydrated";
import world from "world-atlas/land-110m.json";

/**
 * 평면 지도 뷰포트(도메인을 모르는 공용 부품). 전쟁 지도·주제 지도가 같이 쓴다.
 * - 메르카토르, 위도 85°N ~ 85°S(배율 기준 높이는 82°N ~ 58°S - projection.ts), 가로 1000 단위 = 경도 360°
 * - 가로 이동은 회전(끝없이 이어짐), 세로는 확대했을 때만
 * - 끌기, 휠(커서 고정), 두 번 클릭 확대, focusTo(좌표)로 부드럽게 이동
 * - 지도 위에 떠 있는 패널(`data-map-overlay`)에 가리지 않도록 가운데를 비켜 잡는다
 */
export {
  MAP_WIDTH,
  MAP_HEIGHT,
  MAP_TOP,
  MAP_BOTTOM,
  yOfLat,
  normalizeLon,
  makeProjection,
} from "./projection";
const round1 = (v: number) => Math.round(v * 10) / 10;
export const graticule = geoGraticule10();
const landTopo = world as unknown as Topology<{ land: GeometryCollection }>;
export const land = feature(landTopo, landTopo.objects.land);

/**
 * 성능: 투영은 경도 0에서 한 번만 하고, 좌우 이동(회전)은 지도 그룹을 옮기는 것(translate)으로 처리한다.
 * 메르카토르에서 경도 회전 = 가로 평행 이동이라 결과가 같다. 도형 경로는 도형 객체마다 한 번만 계산해 둔다.
 */
const baseProjection = makeProjection(0);
const basePath = geoPath(baseProjection).digits(1);
const pathCache = new WeakMap<object, string>();
const cachedPath = (obj: Parameters<typeof basePath>[0]): string => {
  let d = pathCache.get(obj as object);
  if (d === undefined) {
    d = basePath(obj) ?? "";
    pathCache.set(obj as object, d);
  }
  return d;
};
const project = (c: [number, number]) => {
  const r = baseProjection(c);
  return r && ([round1(r[0]), round1(r[1])] as const);
};

/** 전쟁 지도는 처음부터 4~6배로 시작하는 게 많아 넉넉히. 더 키우면 국경 데이터(Cliopatria)가 각져 보인다 */
const MAX_ZOOM = 16;

/**
 * 패널에 가리지 않게 가운데를 옮길 화면 픽셀 (오른쪽/왼쪽 패널은 가로, 아래 시트·위 제목/상단 바는 세로).
 * 세로는 (아래 덮인 높이 - 위 덮인 높이) / 2 - 고른 점이 위아래로 가리지 않은 영역의 가운데에 온다
 */
function overlayOffset(svg: SVGSVGElement, rect: DOMRect) {
  const { top, bottom } = mapCover(svg);
  const y = (bottom - top) / 2;
  const panel = document
    .querySelector("[data-map-overlay]")
    ?.getBoundingClientRect();
  if (!panel || panel.height === 0 || panel.width >= rect.width * 0.8)
    return { x: 0, y };
  return {
    x:
      panel.left > rect.left + rect.width / 2
        ? (rect.right - panel.left) / 2
        : -(panel.right - rect.left) / 2,
    y,
  };
}

export function useMapViewport(initial: {
  lon: number;
  lat: number;
  zoom: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [lon, setLon] = useState(initial.lon);
  const [centerY, setCenterY] = useState(yOfLat(initial.lat));
  const [zoom, setZoom] = useState(initial.zoom);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const state = useRef({ lon, centerY, zoom });
  /**
   * 확대 미리보기: 확대(핀치·휠·이동 애니메이션)하는 동안에는 새 배율·위치를 여기에만 두고 이미 그린 지도를
   * CSS transform으로 늘리고 옮기기만 한다(GPU, 다시 그리지 않음). 멈추면 한 번 그린다.
   * viewBox 배율이 바뀌면 국경 수백 개의 선 두께·모양을 매번 다시 계산해서 전쟁 지도 핀치가 휴대폰에서 끊겼다.
   */
  const pending = useRef<{ lon: number; centerY: number; zoom: number } | null>(
    null,
  );
  const rendered = useRef<{
    lon: number;
    v: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const commitTimer = useRef(0);
  /** 미리보기 중 지도 칸 크기(처음 한 번만 잼) - 움직일 때마다 재면 방금 바꾼 변환 때문에 레이아웃을 강제로 다시 한다 */
  const previewRect = useRef<DOMRect | null>(null);
  /** 미리보기 변환 쓰기는 한 프레임에 한 번(두 손가락이면 움직임 이벤트가 프레임마다 두 번) */
  const previewFrame = useRef(0);
  const drag = useRef<{
    x: number;
    y: number;
    lon: number;
    cy: number;
    moved: boolean;
    target: Element;
    /** 두 손가락 확대: 시작 때 손가락 사이 거리와 배율 */
    pinch?: { dist: number; zoom: number };
  } | null>(null);
  /** 화면에 닿아 있는 손가락(포인터)들 */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /** 두 번 탭 판정용: 마지막 탭(시각·위치), 손가락 두 번 탭으로 확대한 시각(뒤따르는 dblclick 무시) */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const touchZoomAt = useRef(0);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width && height) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 아래 시트·위 상단 바가 덮은 만큼은 지도를 더 옮길 수 있게(남쪽·북쪽 끝 지점도 가리지 않은 곳으로)
  const cover = useMapCover(svgRef);
  const view = useCallback(
    (k: number, cy: number) => {
      const w = (size ? (MAP_HEIGHT * size.w) / size.h : MAP_WIDTH) / k;
      const h = MAP_HEIGHT / k;
      const unit = size ? h / size.h : 0;
      return {
        x: (MAP_WIDTH - w) / 2,
        y: Math.min(
          MAP_BOTTOM - h + cover.bottom * unit,
          Math.max(MAP_TOP - cover.top * unit, cy - h / 2),
        ),
        w,
        h,
      };
    },
    [size, cover],
  );
  const v = view(zoom, centerY);
  // 이벤트 처리기(휠·이동 애니메이션)가 최신 값을 읽도록 그릴 때마다 갱신. 미리보기를 그렸으면 변환을 지운다(같은 프레임)
  useLayoutEffect(() => {
    state.current = { lon, centerY, zoom };
    rendered.current = { lon, v: view(zoom, centerY) };
    const svg = svgRef.current;
    if (!pending.current && svg?.style.transform) {
      svg.style.transform = "";
      svg.style.willChange = "";
    }
  });
  /** 지도 칸 크기·위치. 미리보기 중에는 svg에 변환이 걸려 있어 변환 없는 부모 기준 */
  const mapRect = () =>
    previewRect.current ??
    (svgRef.current?.parentElement ?? svgRef.current)?.getBoundingClientRect();
  /** 지금 기준 값(미리보기 중이면 그 값) */
  const current = () => pending.current ?? state.current;

  const applyPreview = useCallback(() => {
    previewFrame.current = 0;
    const svg = svgRef.current;
    const r = rendered.current;
    const p = pending.current;
    const rect =
      previewRect.current ??
      (svg?.parentElement ?? svg)?.getBoundingClientRect();
    if (!svg || !r || !p || !rect) return;
    previewRect.current = rect;
    const vp = view(p.zoom, p.centerY);
    const dShift = (-normalizeLon(p.lon - r.lon) * MAP_WIDTH) / 360;
    const tx = ((r.v.x + dShift - vp.x) * rect.width) / vp.w;
    const ty = ((r.v.y - vp.y) * rect.height) / vp.h;
    svg.style.transformOrigin = "0 0";
    svg.style.willChange = "transform";
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${r.v.w / vp.w})`;
  }, [view]);
  /** 미리보기 예약(다음 프레임에 한 번). now면 바로(focusTo는 이미 프레임마다 부른다) */
  const preview = useCallback(
    (now?: boolean) => {
      if (now) {
        cancelAnimationFrame(previewFrame.current);
        return applyPreview();
      }
      if (!previewFrame.current)
        previewFrame.current = requestAnimationFrame(applyPreview);
    },
    [applyPreview],
  );

  /** 미리보기 값을 실제로 그린다 */
  const commit = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = 0;
    previewRect.current = null;
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    setLon(p.lon);
    setCenterY(p.centerY);
    setZoom(p.zoom);
  }, []);

  // 처음 한 번: 가운데가 패널에 가리지 않도록 비켜 놓는다
  const placed = useRef(false);
  useEffect(() => {
    const svg = svgRef.current;
    if (placed.current || !size || !svg) return;
    placed.current = true;
    const rect = svg.getBoundingClientRect();
    const off = overlayOffset(svg, rect);
    const upp = MAP_HEIGHT / state.current.zoom / rect.height;
    setLon((l) => normalizeLon(l + (off.x * upp * 360) / MAP_WIDTH));
  }, [size]);

  /** 화면 좌표(cx, cy)를 고정점으로 배율을 바꾼다. settle이 있으면 미리보기로 두고 그만큼(ms) 뒤에 그린다(0이면 손을 뗄 때) */
  const zoomAt = useCallback(
    (next: number, cx: number, cy: number, settle?: number) => {
      const rect = mapRect();
      const { zoom: k, centerY: c, lon: l } = current();
      const nk = Math.min(MAX_ZOOM, Math.max(1, next));
      if (!rect || nk === k) return;
      const px = (cx - rect.left) / rect.width;
      const py = (cy - rect.top) / rect.height;
      const before = view(k, c);
      const after = view(nk, c);
      const mx = before.x + px * before.w;
      const my = before.y + py * before.h;
      pending.current = {
        lon: normalizeLon(
          l - ((after.x + px * after.w - mx) * 360) / MAP_WIDTH,
        ),
        centerY: my - py * after.h + after.h / 2,
        zoom: nk,
      };
      if (settle === undefined) return commit();
      preview();
      window.clearTimeout(commitTimer.current);
      if (settle > 0) commitTimer.current = window.setTimeout(commit, settle);
    },
    [view, preview, commit],
  );

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(
        current().zoom * Math.exp(-e.deltaY * 0.0015),
        e.clientX,
        e.clientY,
        150,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  /** 좌표로 부드럽게 이동·확대 (패널에 가리지 않는 곳 가운데로) */
  const focusTo = useCallback(
    (coords: [number, number], minZoom: number) => {
      const svg = svgRef.current;
      if (!svg) return () => {};
      const rect = mapRect()!;
      const off = overlayOffset(svg, rect);
      const from = { ...current() };
      const k2 = Math.max(from.zoom, minZoom);
      const upp = MAP_HEIGHT / k2 / rect.height;
      const toLon = coords[0] + (off.x * upp * 360) / MAP_WIDTH;
      const toY = yOfLat(coords[1]) + off.y * upp;
      const dLon = normalizeLon(toLon - from.lon);
      const start = performance.now();
      let frame = 0;
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / 700);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        // 이동 중에는 미리보기(다시 그리지 않음), 끝에서 한 번 그린다
        pending.current = {
          lon: normalizeLon(from.lon + dLon * e),
          centerY: from.centerY + (toY - from.centerY) * e,
          zoom: from.zoom + (k2 - from.zoom) * e,
        };
        if (p < 1) {
          preview(true);
          frame = requestAnimationFrame(tick);
        } else commit();
      };
      frame = requestAnimationFrame(tick);
      return () => {
        cancelAnimationFrame(frame);
        commit();
      };
    },
    [preview, commit],
  );

  const hydrated = useHydrated();

  // 지금 경도만큼 옮긴 자리에 지도 복사본을 놓는다(끝없이 이어지는 지도). 개수는 고정이라 끌 때 다시 만들지 않는다
  const shift = round1((-lon * MAP_WIDTH) / 360);
  const copyCount = Math.ceil(v.w / MAP_WIDTH / 2) + 1;
  const copies = useMemo(() => {
    const out: number[] = [];
    for (let k = -copyCount; k <= copyCount; k++)
      out.push(round1(shift + k * MAP_WIDTH));
    return out;
  }, [shift, copyCount]);

  /** svg에 그대로 펼쳐 넣는 속성. onTap(눌린 요소)은 끌기가 아닌 짧은 탭일 때만 */
  const svgProps = (onTap?: (target: Element) => void) => ({
    ref: svgRef,
    viewBox: `${round1(v.x)} ${round1(v.y)} ${round1(v.w)} ${round1(v.h)}`,
    preserveAspectRatio: size ? "none" : "xMidYMid slice",
    className:
      "absolute inset-0 block h-full w-full cursor-grab touch-none select-none active:cursor-grabbing",
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      // 휠 확대 미리보기가 남아 있으면 먼저 그린다(끌기는 그린 화면 기준)
      if (pending.current && !drag.current) commit();
      e.currentTarget.setPointerCapture(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.current.values()];
      if (b) {
        // 두 번째 손가락: 끌기를 멈추고 두 손가락 확대 시작
        drag.current = {
          x: a.x,
          y: a.y,
          lon: state.current.lon,
          cy: state.current.centerY,
          moved: true,
          target: e.target as Element,
          pinch: {
            dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
            zoom: current().zoom,
          },
        };
        return;
      }
      drag.current = {
        x: e.clientX,
        y: e.clientY,
        lon,
        cy: v.y + v.h / 2,
        moved: false,
        target: e.target as Element,
      };
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const d = drag.current;
      if (!d || !pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.current.values()];
      if (d.pinch && b) {
        // 손가락을 뗄 때 그린다(onPointerUp)
        zoomAt(
          d.pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / d.pinch.dist),
          (a.x + b.x) / 2,
          (a.y + b.y) / 2,
          0,
        );
        return;
      }
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      const upp = v.h / e.currentTarget.getBoundingClientRect().height;
      setLon(normalizeLon(d.lon - dx * upp * (360 / MAP_WIDTH)));
      setCenterY(d.cy - dy * upp);
    },
    onPointerUp: (e: React.PointerEvent<SVGSVGElement>) => {
      pointers.current.delete(e.pointerId);
      const d = drag.current;
      // 핀치가 끝나면 미리보기 배율을 그린다 - 이어지는 한 손가락 끌기는 그린 화면 기준
      if (d?.pinch) commit();
      if (pointers.current.size > 0) {
        // 두 손가락 중 하나만 뗐으면 남은 손가락으로 이어서 끌기
        const [rest] = [...pointers.current.values()];
        if (d)
          drag.current = {
            ...d,
            pinch: undefined,
            x: rest.x,
            y: rest.y,
            lon: state.current.lon,
            cy: state.current.centerY,
          };
        return;
      }
      drag.current = null;
      if (!d || d.moved) return;
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
          zoomAt(current().zoom * 2, e.clientX, e.clientY);
          return;
        }
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      }
      if (onTap) {
        onTap(d.target);
        // 탭으로 연 패널이 뒤따르는 click에 바로 닫히지 않게(ghostClick.ts)
        swallowNextClick();
      }
    },
    onPointerCancel: (e: React.PointerEvent<SVGSVGElement>) => {
      pointers.current.delete(e.pointerId);
      if (drag.current?.pinch) commit();
      drag.current = null;
    },
    onDoubleClick: (e: React.MouseEvent<SVGSVGElement>) => {
      // 손가락 두 번 탭은 위에서 이미 확대했다 — 브라우저가 뒤따라 보내는 dblclick으로 또 확대하지 않게
      if (Date.now() - touchZoomAt.current < 600) return;
      zoomAt(current().zoom * 2, e.clientX, e.clientY);
    },
  });

  return {
    svgRef,
    v,
    zoom,
    lon,
    /** 도형 → svg 경로 (경도 0 기준, 캐시됨) */
    path: cachedPath,
    project,
    focusTo,
    svgProps,
    /** 지도 복사본을 놓을 가로 위치들 — 각각 `translate(x 0)`으로 그리고, key·id는 순번(index)으로 */
    copies,
    // 서버 HTML에는 넣지 않는다(useHydrated 참고)
    landD: hydrated ? cachedPath(land) : "",
    graticuleD: hydrated ? cachedPath(graticule) : "",
  };
}
