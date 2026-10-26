"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import dynamic from "next/dynamic";
import { geoPath } from "d3-geo";
import { usePeriod, useTimeline } from "@/store/timeline";
import { MAX_TILT, MAX_ZOOM, useUi } from "@/store/ui";
import { useVisibleEvents } from "@/store/useVisibleEvents";
import { clusterPins } from "@/lib/events";
import { BADGE, PIN_GROUP, badgeWidth } from "./pinBadge";
import { eventTitle } from "@/lib/localize";
import { formatWhen } from "@/lib/year";
import { formatPeriod } from "@/lib/period";
import { REGION_BY_ID } from "@/data/regions";
import {
  VIEWPOINT_BY_ID,
  homeRegion,
  homeViewpoint,
  zoneViewpoint,
} from "@/data/viewpoints";
import { rasterizeSvg } from "@/components/map/snapshot";
import { useHidden } from "@/components/ui/HideToggle";
import { tiltTransform, untilt } from "@/components/map/tilt";
import { glAvailable, markGlFailed } from "@/components/map/gl/support";
import type { GlMapHandle } from "./GlMap";
import type { GlView } from "@/components/map/gl/renderer";
import { cubicBezier } from "@/components/map/gl/ease";
import { fill } from "@/i18n";
import { useI18n } from "@/i18n/I18nProvider";
import {
  MAP_BOTTOM,
  MAP_HEIGHT,
  MAP_TOP,
  MAP_WIDTH,
  graticule,
  land,
  loadDetailedLand,
  makeProjection,
  normalizeLon,
} from "./baseMap";
import { useBorders, type PolityProps } from "./borders";
import { useHydrated } from "@/components/map/useHydrated";
import { swallowNextClick } from "@/components/map/ghostClick";
import {
  mapCover,
  mapFrame,
  useMapCover,
  type MapCover,
} from "@/components/map/mapCover";

/**
 * 영상용 지도 장면(개발 서버 `?scene`에서만, scene/SceneLayer). 운영 빌드에서는 조건이 거짓으로 굳어 장면 코드가 번들에서 빠진다
 */
const SCENE_DEV = process.env.NODE_ENV === "development";
const SceneLayer = SCENE_DEV
  ? dynamic(() => import("./scene/SceneLayer").then((m) => m.SceneLayer), {
      ssr: false,
    })
  : null;
type SceneHost = import("./scene/SceneLayer").SceneHost;
/**
 * WebGL 지도 판(기본). 코드는 따로 받는다(첫 화면 묶음에 들어가지 않게).
 * WebGL2가 없거나 만들다 실패하면 svg 지도로(글자·핀·손짓 모두 예전 방식). 주소에 ?svg면 svg로(비교·확인용)
 */
const GlMap = dynamic(() => import("./GlMap").then((m) => m.GlMap), {
  ssr: false,
});
// 영상 장면(?scene)은 자기 WebGL 판(scene/SceneGl)을 따로 그린다 - 사이트 WebGL 판은 쓰지 않는다
const isGl = () =>
  glAvailable() && !new URLSearchParams(location.search).has("scene");

/** 장면 최대 배율(가로 약 0.45° - 진지 하나. 지도 좌표 float32 반올림은 x≈630에서 약 2.4m라 이 배율(1px > 10m)까지 흔들림 없음) */
const SCENE_MAX_ZOOM = 1000;
/** 장면 모드인가(브라우저에서만) */
const isScene = () =>
  SCENE_DEV &&
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("scene");

/** 이 픽셀보다 적게 움직이면 끌기가 아니라 탭으로 본다 */
const TAP_SLOP = 5;
/** 핀치하다가 두 손가락이 이만큼(도) 기울면 돌리기도 같이 - 확대할 때 손가락이 조금 기우는 정도로는 돌지 않게 */
const SPIN_START = 15;
/** 배율 1에서 이름을 표시할 최소 면적(km²). 확대할수록 작은 나라도 표시 */
const LABEL_MIN_AREA = 200_000;
/** 배율 1에서 이름표 최대 개수(이름 수). 현대 지도는 나라가 80개 넘게 커서 영국(약 26만 km², 76위)도 들어가게 - 겹치는 이름은 배치에서 빠지므로 빽빽해지지 않는다 */
const MAX_LABELS = 90;

/** 정치체마다 고정된 색 (Wikidata ID/이름 해시) */
const POLITY_COLORS = [
  "#e76f51",
  "#f4a261",
  "#e9c46a",
  "#8ab17d",
  "#2a9d8f",
  "#5e9fd1",
  "#8d7bd1",
  "#d17bb4",
  "#c9886b",
  "#7fa7a0",
];
function polityColor(p: PolityProps): string {
  const key = p.w ?? p.n;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return POLITY_COLORS[Math.abs(h) % POLITY_COLORS.length];
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** 장면 모드는 판을 대각선의 3배로 - 크게 눕혀도 판 끝(지평선 쪽 모서리)이 화면에 보이지 않게(먼 쪽은 안개가 가림) */
const planeGrow = () => (isScene() ? 3 : 1);

/**
 * 지도 판 크기: 북쪽이 위(돌리지 않음)면 지도 칸 그대로, 돌렸거나 돌리는 중이면 지도 칸 대각선 길이의 정사각형 -
 * 어느 각도로 돌려도 지도 칸 모서리가 비지 않는다(square)
 */
function planeSize(frame: { w: number; h: number }, square: boolean) {
  if (!square) return frame;
  const d = Math.hypot(frame.w, frame.h) * planeGrow();
  return { w: d, h: d };
}
/** 화면 지도 칸 → 돌리기 전 지도 판(가운데는 같다). 끌기·확대 계산은 모두 이 판 기준 */
function turnRect(r: DOMRect, square: boolean): DOMRect {
  if (!square) return r;
  const d = Math.hypot(r.width, r.height) * planeGrow();
  return new DOMRect(
    r.left + (r.width - d) / 2,
    r.top + (r.height - d) / 2,
    d,
    d,
  );
}
/** 화면 방향(px)을 지도 판 방향으로 - 판은 지도 칸 가운데를 축으로 -heading 돌아 있어서 +heading 돌린다 */
function turnVec(x: number, y: number, heading: number): [number, number] {
  const a = (heading * Math.PI) / 180;
  // 90° 단위에서 0이 아닌 아주 작은 값(6e-17)이 끼지 않게
  const c = Math.round(Math.cos(a) * 1e9) / 1e9;
  const s = Math.round(Math.sin(a) * 1e9) / 1e9;
  return [x * c - y * s, x * s + y * c];
}
/** 지도를 덮은 높이(화면 위·아래): 돌린 정사각형 판은 화면보다 커서 덮인 곳까지 이미 지도가 있다 - 세로 한계를 늘리지 않는다 */
function turnCover(c: MapCover, square: boolean): MapCover {
  return square ? { top: 0, bottom: 0 } : c;
}

/** 돌리는 판 자리: 돌리지 않으면 지도 칸 그대로. --turn은 판 위 글자를 반대로 돌려 화면에서 똑바로 세우는 값 */
function turnStyle(
  heading: number,
  frame: { w: number; h: number } | null,
  square: boolean,
): React.CSSProperties {
  if (!square || !frame) return { inset: 0 };
  const d = Math.hypot(frame.w, frame.h) * planeGrow();
  return {
    left: (frame.w - d) / 2,
    top: (frame.h - d) / 2,
    width: d,
    height: d,
    transform: heading ? `rotate(${-heading}deg)` : undefined,
    "--turn": `${heading}deg`,
  } as React.CSSProperties;
}

type Gesture = {
  /** 한 손가락/마우스: 끌기 시작 시점의 값 */
  x: number;
  y: number;
  lon: number;
  centerY: number;
  moved: boolean;
  eventId: string | null;
  polity: string | null;
  /** 두 손가락: 핀치 시작 거리와 배율 */
  pinch?: { dist: number; zoom: number };
  /** 누를 때 지도 그림 미리보기 중이었음(svg가 보이는 자리에 없어 누른 핀·나라는 그린 뒤 다시 찾는다) */
  stale?: boolean;
  /** 끌기 속도 계산용 최근 위치(시각 ms, x, y) */
  samples?: [number, number, number][];
  /**
   * 기울이기(위아래)·돌리기(좌우, 마우스만): 시작 화면 점과 그때 기울기·방향, 돌리는 축(화면 점 - 가려지지 않은 영역 가운데).
   * 두 손가락이면 처음 움직임으로 핀치·기울이기·돌리기를 정한다(decided)
   */
  tilt?: {
    x: number;
    y: number;
    from: number;
    heading: number;
    pivot: [number, number] | null;
  };
  /** 두 손가락 비틀기로 돌리기(핀치와 같이): 지난 움직임 때 두 손가락 각도(도, 화면)와 방향 */
  spin?: { angle: number; from: number };
  /** 두 손가락: 시작 가운데 y·두 손가락 각도(화면 client px·도), 기울이기인지 정했는지 */
  pair?: { midY: number; angle: number; decided: boolean };
  /** 두 손가락 가운데(화면 client px) - 지난 움직임 때. 그 밑의 지도가 손가락을 따라 옮겨 간다 */
  mid?: [number, number];
};

/**
 * 지도 그림(snapshot)을 구울 복제본 손질: 넓힌 범위(x ~ x + w)를 덮도록 바다 사각형을 늘리고 지도 복사본(경도 한 바퀴씩)을 더 붙인다.
 * 나라 이름을 숨겼으면 빼고, 고른 핀 물결(움직이는 것)도 뺀다. 복사본은 svg 바로 아래 `<g transform="translate(o 0)">`.
 */
function extendCopies(clone: SVGSVGElement, x: number, w: number) {
  const ocean = clone.querySelector(":scope > rect");
  ocean?.setAttribute("x", String(x));
  ocean?.setAttribute("width", String(w));
  if (document.documentElement.dataset.names === "off")
    clone.querySelectorAll(".map-names").forEach((n) => n.remove());
  clone.querySelectorAll(".animate-pin-pulse").forEach((n) => n.remove());
  // 복사본은 한 장만 남기고 나머지는 그 한 장을 가리키는 <use>로 - 글자로 바꾸는(serialize) 양이 복사본 수만큼 줄어든다
  // (굽기에서 가장 무거운 단계였다: 크롬 CPU 4배 느림에서 글자 바꾸기 95ms + 이미지 파일 만들기 86ms)
  const copies = [...clone.querySelectorAll(":scope > g")];
  const first = copies[0];
  if (!first) return;
  const offsetOf = (g: Element) =>
    Number(/translate\(([-\d.]+)/.exec(g.getAttribute("transform") ?? "")?.[1]);
  const base = offsetOf(first);
  copies.slice(1).forEach((g) => g.remove());
  first.setAttribute("id", "copy");
  for (let k = -4; k <= 4; k++) {
    const o = round1(base + k * MAP_WIDTH);
    if (k === 0 || o >= x + w || o + MAP_WIDTH <= x) continue;
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#copy");
    use.setAttribute("transform", `translate(${round1(o - base)} 0)`);
    clone.appendChild(use);
  }
}

/**
 * 지도 위에 떠 있는 것(데스크톱 오른쪽 패널 / 모바일 아래 시트 / 위 제목 상자)에 가려지지 않은 영역의 가운데가 지도 가운데에서 얼마나 떨어졌는지(px).
 * 패널이 오른쪽(보통)이면 x > 0, 왼쪽(아랍어 RTL)이면 x < 0. 세로는 (아래 덮인 높이 - 위 덮인 높이) / 2
 */
function overlayOffset(svg: SVGSVGElement): { x: number; y: number } {
  // 확대 미리보기 변환이 걸려 있을 수 있어 변환 없는 부모(지도 칸) 기준
  const rect = mapFrame(svg).getBoundingClientRect();
  const { top, bottom } = mapCover(svg);
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
}

/** overlayOffset을 지도 판 방향으로(바라보는 방향을 돌렸으면 화면 아래 시트가 판의 옆이나 위를 덮는다) */
function mapOffset(svg: SVGSVGElement): [number, number] {
  const { x, y } = overlayOffset(svg);
  return turnVec(x, y, useUi.getState().heading % 360);
}

/**
 * 하단 바 위 영역을 모두 덮는 평면 세계지도.
 * - 나라 영역·이름은 선택 연도의 역사 국경(borders.ts)
 * - 가로: 지구를 돌리듯 끝없이 이어진다(회전). 세로: 확대했을 때만 움직인다
 * - 확대: 휠, 두 손가락 핀치, 두 번 클릭
 * - 나라를 누르면 강조하고 이름을 항상 보여준다. 다시 누르면 해제
 */
export function WorldMap() {
  const { locale, messages } = useI18n();
  // 첫 시점은 언어별(homeViewpoint). 아래 useUi 읽기·목록 정렬보다 먼저 저장소에 넣는다
  const [startLon] = useState(() => {
    const home = homeViewpoint(locale);
    useUi.getState().initViewpoint(home);
    return VIEWPOINT_BY_ID.get(home)!.lon;
  });
  const period = usePeriod();
  const viewpoint = useUi((s) => s.viewpoint);
  const setViewpoint = useUi((s) => s.setViewpoint);
  const setCenterLon = useUi((s) => s.setCenterLon);
  const zoom = useUi((s) => s.zoom);
  const setZoom = useUi((s) => s.setZoom);
  const selectFromMap = useUi((s) => s.selectFromMap);
  const focusOn = useUi((s) => s.focusOn);
  const selectedEventId = useUi((s) => s.selectedEventId);
  const {
    polities,
    nameOf,
    ready: bordersReady,
  } = useBorders(period.start, locale);

  const svgRef = useRef<SVGSVGElement>(null);
  /** 손짓을 받는 지도 칸(국경 svg·지도 그림·핀 svg를 감싼다) */
  const hostRef = useRef<HTMLDivElement>(null);
  /** 핀·나라 이름 svg - 국경 svg 위에 따로 둬서 확대·끌기 미리보기 동안 크기를 화면에서 그대로 유지한다 */
  const overlayRef = useRef<SVGSVGElement>(null);
  /** 기울이는 판(국경 svg·지도 그림·핀 svg). 지도 칸(hostRef)은 기울이지 않아 크기를 재는 기준이 된다 */
  const planeRef = useRef<HTMLDivElement>(null);
  const tilt = useUi((s) => s.tilt);
  const setTilt = useUi((s) => s.setTilt);
  /** 지금 기울기(기울이는 손짓 중에는 저장소보다 앞선 값) */
  const tiltRef = useRef(tilt);
  /** 바라보는 방향 0~359(저장소 값은 돌린 만큼 계속 더해 가서 여기서 맞춘다) */
  const heading = ((useUi((s) => s.heading) % 360) + 360) % 360;
  const setHeading = useUi((s) => s.setHeading);
  const spinning = useUi((s) => s.spinning);
  const setSpinning = useUi((s) => s.setSpinning);
  /** 지도 판을 대각선 정사각형으로(돌렸거나 돌리는 중) */
  const square = heading !== 0 || spinning;
  /** 지금 방향·판 모양(돌리는 손짓 중에는 저장소보다 앞선 값) */
  const headingRef = useRef(heading);
  const squareRef = useRef(square);
  /** 돌리는 판(지도 칸 가운데를 축으로 -heading). 기울이는 판 안에 있어 돌린 뒤 화면 아래쪽으로 눕는다 */
  const turnRef = useRef<HTMLDivElement>(null);
  const [lon, setLon] = useState(startLon);
  const [centerY, setCenterY] = useState(MAP_HEIGHT / 2);
  /** 지도 칸 크기(화면). 지도 판 크기(size)는 옆을 보면 가로·세로를 바꾼 것 */
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const size = useMemo(
    () => frame && planeSize(frame, square),
    [frame, square],
  );
  const [selectedPolity, setSelectedPolity] = useState<string | null>(null);
  const lonRef = useRef(startLon);
  const centerYRef = useRef(MAP_HEIGHT / 2);
  /** 실제 배율(확대 중에는 아직 화면에 반영하지 않은 값까지). 확대 계산은 저장소 값이 아니라 이것을 기준으로 */
  const zoomRef = useRef(zoom);
  /** 마지막으로 그린 화면(viewBox·경도) - 확대 미리보기 변환의 기준 */
  const rendered = useRef<{
    lon: number;
    v: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const commitTimer = useRef(0);
  /** 미리보기 중 지도 칸 크기(처음 한 번만 잼) - 손가락이 움직일 때마다 재면 방금 바꾼 변환 때문에 브라우저가 레이아웃을 강제로 다시 한다 */
  const previewRect = useRef<DOMRect | null>(null);
  /** 미리보기 변환 쓰기는 한 프레임에 한 번(두 손가락이면 움직임 이벤트가 프레임마다 두 번 온다) */
  const previewFrame = useRef(0);
  /** 지도 그림(snapshot): 마지막으로 그린 국경 화면을 좌우 ex·위아래 ey 화면씩 넓게 구운 canvas. key가 지금 그린 화면 번호와 같을 때만 쓴다 */
  const snapHost = useRef<HTMLDivElement>(null);
  const snap = useRef<{
    key: number;
    /** 구울 때의 큰 내용 번호(major) */
    major: number;
    w: number;
    h: number;
    /** 화면 밖으로 넓게 구운 양(좌우·위아래 각각 몇 화면) */
    ex: number;
    ey: number;
    /** 구울 때의 화면(경도·viewBox) - 미리보기 변환의 기준 */
    r: { lon: number; v: { x: number; y: number; w: number; h: number } };
  } | null>(null);
  /** 확대·이동을 그리는 중(그때 바뀌는 svg는 내용 변화가 아니라 화면 변화 - 구운 그림을 버리지 않는다) */
  const viewCommit = useRef(false);
  const renderKey = useRef(0);
  /**
   * 큰 내용 번호: 지도가 실제로 달라지는 변화(연도의 국경·언어·테마·나라 이름 숨기기)에만 바뀐다.
   * 핀·나라 강조 같은 작은 변화로는 그림을 버리지 않는다 - 핀을 누른 직후 확대·끌기가 예전 방식(svg 직접 이동)으로 빠져
   * 화면 끝 빈 곳·경계선이 깜빡였다. 작은 변화는 쉴 때 다시 구우면서 반영된다
   */
  const major = useRef(0);
  // 연도의 국경·언어가 바뀌면 큰 내용 변화(구운 지도 그림을 쓰지 않는다)
  useEffect(() => {
    major.current++;
  }, [polities, locale]);
  /** 구운 지도 그림을 손짓 미리보기에 쓸 수 있는지(내용이 그대로거나 작은 변화만 있었음) */
  const snapUsable = () => {
    const s = snap.current;
    return !!s && (s.key === renderKey.current || s.major === major.current);
  };
  const snapTimer = useRef(0);
  /** commitZoom(아래에서 만듦)을 미리보기에서 부르기 위한 ref */
  const commitRef = useRef(() => {});
  /** 누른 손가락: 지도 판 위 점(x, y)과 화면 점(sx, sy - 두 손가락 기울이기 판정은 화면 기준) */
  const pointers = useRef(
    new Map<number, { x: number; y: number; sx: number; sy: number }>(),
  );
  const gesture = useRef<Gesture | null>(null);
  /** 두 번 탭 판정용: 마지막 탭(시각·위치), 손가락 두 번 탭으로 확대한 시각(뒤따르는 dblclick 무시) */
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const touchZoomAt = useRef(0);
  /** 손을 뗀 뒤 그리기 예약(연달아 움직이는 동안은 그림만 옮기고 쉴 때 한 번 그린다) */
  const settleTimer = useRef(0);
  /** 관성 이동 애니메이션(requestAnimationFrame id, 0이면 멈춤) */
  const momentum = useRef(0);

  const updateLon = useCallback((next: number) => {
    lonRef.current = normalizeLon(next);
    setLon(lonRef.current);
  }, []);
  const updateCenterY = useCallback((next: number) => {
    centerYRef.current = next;
    setCenterY(next);
  }, []);

  // 화면 크기: 세로(위도 전체)를 높이에 맞추고 가로는 비율만큼. 지도 칸(돌리지 않음)을 재고, 판 크기는 방향에 맞춰 바꾼다(size)
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setFrame({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 보이는 범위(지도 좌표). 가로는 항상 가운데 고정이고, 가로 이동은 회전(lon)으로 한다 */
  // 아래 시트(모바일 사건 목록)·위 제목 상자가 덮은 만큼은 지도를 더 옮길 수 있게 - 희망봉처럼 남쪽 끝, 북쪽 끝 사건도 가리지 않은 곳으로
  const screenCover = useMapCover(svgRef);
  const actualCover = useMemo(
    () => turnCover(screenCover, square),
    [screenCover, square],
  );
  // 시트를 닫아 덮은 높이가 줄어도 그 전 한계를 잡아 둔다(held) - 바로 줄이면 시트 덕에 아래(위)로 더 옮겨 둔 지도가
  // 가운데로 끌려 들어가 움직였다(점을 눌러 옮긴 뒤 목록을 닫을 때). 지도를 원래 범위 안으로 옮기면 놓는다(아래 effect)
  const [held, setHeld] = useState<MapCover>({ top: 0, bottom: 0 });
  const [prevCover, setPrevCover] = useState(actualCover);
  // 판 모양이 바뀌면(돌리기 시작·끝) 덮인 쪽이 달라지므로 잡아 둔 한계를 버린다
  const [prevSquare, setPrevSquare] = useState(square);
  if (square !== prevSquare) {
    setPrevSquare(square);
    setPrevCover(actualCover);
    setHeld({ top: 0, bottom: 0 });
  } else if (actualCover !== prevCover) {
    setPrevCover(actualCover);
    if (
      actualCover.top < prevCover.top ||
      actualCover.bottom < prevCover.bottom
    )
      setHeld((h) => ({
        top: Math.max(
          h.top,
          actualCover.top < prevCover.top ? prevCover.top : 0,
        ),
        bottom: Math.max(
          h.bottom,
          actualCover.bottom < prevCover.bottom ? prevCover.bottom : 0,
        ),
      }));
  }
  const cover = useMemo(
    () => ({
      top: Math.max(actualCover.top, held.top),
      bottom: Math.max(actualCover.bottom, held.bottom),
    }),
    [actualCover, held],
  );
  // 배율은 화면에서 보이는 크기: 배율 1 = 위도 전체가 지도 칸 높이. 판이 지도 칸보다 크면(돌린 정사각형) 그만큼 더 넓게 보인다
  const view = useCallback(
    (k: number, cy: number) => {
      const h =
        size && frame ? (MAP_HEIGHT * size.h) / (k * frame.h) : MAP_HEIGHT / k;
      const w = size ? (h * size.w) / size.h : MAP_WIDTH / k;
      const unit = size ? h / size.h : 0;
      const lo = MAP_TOP - cover.top * unit;
      const hi = MAP_BOTTOM - h + cover.bottom * unit;
      // 판이 위도 전체보다 크면(돌린 판을 축소했을 때) 가운데에
      const y =
        hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, cy - h / 2));
      return { x: (MAP_WIDTH - w) / 2, y, w, h };
    },
    [size, frame, cover],
  );
  const v = view(zoom, centerY);
  // 잡아 둔 한계는 지도가 실제 한계 안으로 들어오면 놓는다(그리는 중에 바로 - 이전 값과 비교해 고치는 React 방식)
  if (held.top || held.bottom) {
    const unit = size ? v.h / size.h : 0;
    if (
      v.y <= MAP_BOTTOM - v.h + actualCover.bottom * unit + 0.5 &&
      v.y >= MAP_TOP - actualCover.top * unit - 0.5
    )
      setHeld({ top: 0, bottom: 0 });
  }

  useLayoutEffect(() => {
    headingRef.current = heading;
    squareRef.current = square;
  }, [heading, square]);
  /** 지도 칸 크기·위치(화면). 확대 미리보기 중에는 svg에 변환이 걸려 있어서, 변환이 없는 지도 칸 기준으로 잰다 */
  const frameRect = useCallback(
    () => previewRect.current ?? hostRef.current?.getBoundingClientRect(),
    [],
  );
  /** 지도 판(돌리기 전) 크기·위치 - toPlane이 돌려 주는 점과 같은 기준 */
  const mapRect = useCallback(() => {
    const r = frameRect();
    return r && turnRect(r, squareRef.current);
  }, [frameRect]);

  /** 기울인 판에 바로 쓰기(기울이는 손짓 중에는 프레임마다 - 다시 그리지 않는다). 먼 쪽은 하늘로 흐리게 */
  const applyTilt = useCallback((t: number) => {
    tiltRef.current = t;
    const plane = planeRef.current;
    const h = hostRef.current?.clientHeight ?? 0;
    if (!plane) return;
    plane.style.transform = tiltTransform(t, h);
    // 장면 모드는 먼 쪽을 자르지 않는다(대각선 정사각형 판이 지평선 너머까지 - 영상 위쪽이 하늘로 비지 않게, 안개는 장면 층이)
    const fade =
      t && !isScene()
        ? `linear-gradient(to bottom, transparent, #000 ${round1(4 + t / 4)}%)`
        : "";
    plane.style.maskImage = fade;
    plane.style.webkitMaskImage = fade;
    glMap.current?.request();
  }, []);
  // 기울기가 손짓 밖에서 바뀌면(설정 메뉴·나침반) 0.45초 동안 옮겨 간다. 손짓은 이미 판에 써 두어 그대로
  useEffect(() => {
    const from = tiltRef.current;
    if (
      isScene() ||
      Math.abs(from - tilt) < 0.5 ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return applyTilt(tilt);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 450);
      const k = 1 - Math.pow(1 - t, 3);
      applyTilt(from + (tilt - from) * k);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [tilt, applyTilt]);
  // 지도 칸 크기가 바뀌면(원근 거리가 높이 기준) 지금 기울기로 다시
  useEffect(() => applyTilt(tiltRef.current), [frame, applyTilt]);

  // 방향이 손짓 밖에서 바뀌면(나침반 = 북쪽이 위로) 판은 바로 새 방향으로 놓고 보이는 것만 예전 방향에서 0.45초 돌아오게.
  // 축은 패널에 가려지지 않은 영역의 가운데(overlayOffset) - 지도 칸 가운데로 돌리면 데스크톱에서 보던 곳이 오른쪽 패널 밑으로 갔다.
  // 손짓으로 돌린 것은 이미 판에 써 두었다(shownHeading을 같이 바꿔 여기서 다시 돌지 않음). 끝나면 돌리는 중(spinning)을 끈다
  const shownHeading = useRef(heading);
  useLayoutEffect(() => {
    const from = shownHeading.current;
    shownHeading.current = heading;
    // 장면 모드는 카메라가 정한 방향 그대로(돌리는 애니메이션·축 옮기기 없음)
    if (isScene()) return;
    const el = turnRef.current;
    if (!el || !frame || from === heading) {
      if (spinning && !gesture.current && !heading) setSpinning(false);
      return;
    }
    // 보이는 영역 가운데(화면 o)에 있던 지도 점이 돌린 뒤에도 그 자리에 오게 가운데를 옮긴다.
    // 예전 화면은 rendered(아래 layout effect가 이번 그림으로 바꾸기 전 - 이 effect가 먼저 돈다)
    const svg = svgRef.current;
    const r = rendered.current;
    // overlayOffset은 가운데를 옮길 양(가려진 쪽으로) - 보이는 영역 가운데는 그 반대쪽
    const off = svg ? overlayOffset(svg) : { x: 0, y: 0 };
    const o = { x: -off.x, y: -off.y };
    if (r && (o.x || o.y)) {
      const [ox0, oy0] = turnVec(o.x, o.y, from);
      const [ox1, oy1] = turnVec(o.x, o.y, heading);
      const upp = MAP_HEIGHT / (frame.h * zoomRef.current); // 픽셀당 지도 단위
      updateLon(lonRef.current + ((ox0 - ox1) * upp * 360) / MAP_WIDTH);
      updateCenterY(r.v.y + r.v.h / 2 + (oy0 - oy1) * upp);
    }
    const done = () => {
      if (!useUi.getState().heading && !gesture.current) setSpinning(false);
    };
    const delta = ((heading - from + 540) % 360) - 180;
    // 조금씩 바뀌면(나침반을 잡고 돌리기) 애니메이션 없이 바로
    if (
      Math.abs(delta) < 15 ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return done();
    // 판 가운데가 아니라 o를 축으로 돌도록: o - R(delta)·o 만큼 옮긴 데서 시작
    const [rx, ry] = turnVec(o.x, o.y, delta);
    if (isGl()) {
      // WebGL 판: 같은 곡선·시간으로 회전·옮김을 줄여 가며 그린다(Web Animations의 rotate·translate와 같은 값)
      const start = performance.now();
      const tick = (now: number) => {
        const k = Math.min(1, (now - start) / 450);
        const p = cubicBezier(0.2, 0.7, 0.2, 1, k);
        glTurn.current =
          k < 1
            ? {
                rot: delta * (1 - p),
                tx: (o.x - rx) * (1 - p),
                ty: (o.y - ry) * (1 - p),
              }
            : null;
        glMap.current?.request();
        if (k < 1) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
      return;
    }
    el.animate(
      [
        {
          translate: `${round1(o.x - rx)}px ${round1(o.y - ry)}px`,
          rotate: `${delta}deg`,
        },
        { translate: "0px 0px", rotate: "0deg" },
      ],
      { duration: 450, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" },
    ).onfinish = done;
  }, [heading, frame, spinning, setSpinning, updateLon, updateCenterY]);

  /**
   * 화면 위 점(client px)을 기울이고 돌리기 전 지도 판 위의 점으로(눕힌 것을 펴고(untilt), 돌린 것을 되돌린다).
   * 끌기·확대 계산은 모두 이 점과 mapRect로 한다 - 그래서 기울이거나 돌려도 끄는 손가락 밑 지도가 따라온다
   */
  const toPlane = useCallback(
    (cx: number, cy: number): [number, number] => {
      const t = tiltRef.current;
      const h = headingRef.current;
      const rect = t || h ? frameRect() : null;
      if (!rect) return [cx, cy];
      const [x, y] = t ? untilt(rect, t, cx, cy) : [cx, cy];
      if (!h) return [x, y];
      // 돌린 판 위의 점으로(판은 지도 칸 가운데를 축으로 돌아 있다)
      const ox = rect.left + rect.width / 2;
      const oy = rect.top + rect.height / 2;
      const [dx, dy] = turnVec(x - ox, y - oy, h);
      return [ox + dx, oy + dy];
    },
    [frameRect],
  );

  /**
   * 확대 미리보기: 확대하는 동안에는 이미 그린 지도를 CSS transform으로 늘리고 옮기기만 하고(GPU, 다시 그리지 않음),
   * 멈추면(commitZoom) 실제 배율로 한 번 다시 그린다. viewBox 배율이 바뀌면 국경 수백 개(복사본까지)의 선 두께·모양을
   * 브라우저가 매번 다시 계산해서 휴대폰 핀치가 15~24fps로 끊겼다(CPU 4배 느림 측정, 스타일·레이아웃만 5초).
   */
  const applyPreview = useCallback(() => {
    previewFrame.current = 0;
    const svg = svgRef.current;
    const r = rendered.current;
    const frame = frameRect();
    if (!svg || !r || !frame) return;
    previewRect.current = frame;
    // WebGL 판은 지금 값(ref)으로 지도·핀·이름을 바로 그린다 - svg를 늘리고 옮길 필요가 없다
    if (isGl()) return glMap.current?.request();
    const rect = turnRect(frame, squareRef.current);
    const vp = view(zoomRef.current, centerYRef.current);
    /** 기준 화면(base)에서 지금 화면으로 가는 변환 */
    const toNow = (base: typeof r) => {
      const dShift =
        (-normalizeLon(lonRef.current - base.lon) * MAP_WIDTH) / 360;
      return {
        scale: base.v.w / vp.w,
        tx: ((base.v.x + dShift - vp.x) * rect.width) / vp.w,
        ty: ((base.v.y - vp.y) * rect.height) / vp.h,
      };
    };
    // 핀·이름 svg는 그린 화면 기준으로 옮기고, 늘어난 만큼 핀·글자를 줄여 화면에서 크기를 그대로 둔다
    // (같이 늘렸다가 손을 뗀 뒤 원래 크기로 돌아가는 게 느리고 어색했다). 줄이는 값은 바뀔 때만 쓴다
    const ov = overlayRef.current;
    if (ov) {
      const t = toNow(r);
      ov.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.scale})`;
      const pinK = String(round4(1 / t.scale));
      if (ov.style.getPropertyValue("--pin-k") !== pinK) {
        ov.style.setProperty("--pin-k", pinK);
        // 이름 글자는 배율^0.2만큼 커지게 그리므로(placedLabels) 미리보기도 같게
        ov.style.setProperty("--label-k", String(round4(t.scale ** -0.8)));
      }
      if (ov.dataset.preview === undefined) {
        ov.style.willChange = "transform";
        ov.dataset.preview = "";
      }
    }
    const host = snapHost.current;
    const canvas = host?.firstElementChild as HTMLElement | null;
    const s = snap.current;
    // 손으로 움직이지 않는 이동(핀을 눌러 그 자리로 가기·휠)은 내용이 조금 지난 그림이라도 쓴다 - 핀을 누르면 강조가 바뀌어
    // 그림을 버리게 되는데, 그때 svg를 직접 옮기면 화면 끝에 지도가 없는 빈 곳과 경계선이 깜빡였다. 도착하면 진짜 지도로 바뀐다
    if (
      host &&
      canvas &&
      s &&
      (s.key === renderKey.current ||
        s.major === major.current ||
        !gesture.current) &&
      s.w === rect.width &&
      s.h === rect.height
    ) {
      // 그림은 구울 때의 화면 기준(그 뒤 확대·이동을 그렸어도 그대로 쓴다 - 연달아 확대할 때 다시 구울 때까지 기다리지 않게)
      const { scale, tx, ty } = toNow(s.r);
      // 그림이 화면을 다 덮는지(끌기로 한 화면 넘게 가면 빈 곳이 보인다) - 끌기는 넘으면 한 번 그리고 이어 간다
      const { width: W, height: H } = rect;
      const covered =
        tx - s.ex * W * scale <= 1 &&
        tx + (s.ex + 1) * W * scale >= W - 1 &&
        ty - s.ey * H * scale <= 1 &&
        ty + (s.ey + 1) * H * scale >= H - 1;
      if (
        covered ||
        gesture.current?.pinch ||
        (!gesture.current && !momentum.current)
      ) {
        canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        // 그림으로 바꾸는 건 처음 한 번만 - svg 속성은 같은 값을 다시 써도 WebKit이 지도 svg 전체 스타일을 다시 계산해
        // 매 프레임 쓰면 아이폰에서 끌기·확대가 무거웠다(Safari 타임라인으로 확인)
        if (host.style.visibility !== "visible") {
          host.style.visibility = "visible";
          svg.style.opacity = "0";
          svg.dataset.preview = "";
        }
        return;
      }
      // 그림 밖으로 나가면 그림을 버리고 한 번 그린 뒤 예전 방식(끌 때마다 그림)으로 이어 간다 - 쉬면 다시 굽는다
      snap.current = null;
      host.style.visibility = "hidden";
      svg.style.opacity = "";
      return commitRef.current();
    }
    if (host && host.style.visibility === "visible")
      host.style.visibility = "hidden";
    if (svg.style.opacity) svg.style.opacity = "";
    const { scale, tx, ty } = toNow(r);
    svg.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    if (svg.dataset.preview === undefined) {
      svg.style.transformOrigin = "0 0";
      svg.style.willChange = "transform";
      // 고른 핀 물결이 움직이면 늘린 지도를 프레임마다 다시 그려야 해서 멈춘다
      svg.dataset.preview = "";
    }
  }, [view, frameRect]);
  /** 미리보기 예약(다음 프레임에 한 번). now면 바로(사건 고르기 이동은 이미 프레임마다 부른다) */
  const previewZoom = useCallback(
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

  /** 미리보기 중인 배율·위치를 실제로 그린다(변환은 다시 그린 직후 useLayoutEffect에서 지운다) */
  const commitZoom = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    cancelAnimationFrame(previewFrame.current);
    previewFrame.current = 0;
    previewRect.current = null;
    // 화면이 실제로 바뀌면(다시 그림) 그 svg 변화는 화면 변화로 본다 - 아래 useLayoutEffect가 그린 뒤 끈다
    const r = rendered.current;
    const next = view(zoomRef.current, centerYRef.current);
    if (r && (r.lon !== lonRef.current || r.v.w !== next.w || r.v.y !== next.y))
      viewCommit.current = true;
    updateLon(lonRef.current);
    updateCenterY(centerYRef.current);
    setZoom(zoomRef.current);
  }, [setZoom, updateLon, updateCenterY, view]);
  /** previewZoom을 ref로(사건 고르기 이동 effect가 함수가 바뀔 때마다 다시 돌지 않게) */
  const previewRef = useRef(previewZoom);
  useEffect(() => {
    commitRef.current = commitZoom;
    previewRef.current = previewZoom;
  }, [commitZoom, previewZoom]);

  /** 화면 좌표(cx, cy)를 고정점으로 배율을 바꾼다. preview면 미리보기로 두고 settle(ms) 뒤에 그린다(0이면 손을 뗄 때 직접) */
  const zoomAt = useCallback(
    (nextZoom: number, cx: number, cy: number, settle?: number) => {
      const rect = mapRect();
      const k = zoomRef.current;
      const nk = Math.min(MAX_ZOOM, Math.max(1, nextZoom));
      if (!rect || nk === k) return;
      const px = (cx - rect.left) / rect.width;
      const py = (cy - rect.top) / rect.height;
      const before = view(k, centerYRef.current);
      const mx = before.x + px * before.w;
      const my = before.y + py * before.h;
      const after = view(nk, centerYRef.current);
      // 고정점이 같은 화면 위치에 오도록: 가로는 회전, 세로는 중심 이동
      const dx = after.x + px * after.w - mx;
      lonRef.current = normalizeLon(lonRef.current - (dx * 360) / MAP_WIDTH);
      centerYRef.current = my - py * after.h + after.h / 2;
      zoomRef.current = nk;
      if (settle === undefined) return commitZoom();
      previewZoom();
      window.clearTimeout(commitTimer.current);
      if (settle > 0)
        commitTimer.current = window.setTimeout(commitZoom, settle);
    },
    [view, mapRect, previewZoom, commitZoom],
  );

  // 다시 그린 뒤: 그린 화면을 기억하고, 미리보기 변환이 남아 있으면 지운다(같은 프레임이라 깜빡이지 않음)
  useLayoutEffect(() => {
    rendered.current = { lon, v: view(zoom, centerY) };
    zoomRef.current = zoom;
    const svg = svgRef.current;
    if (svg && svg.dataset.preview !== undefined) {
      svg.style.transform = "";
      svg.style.willChange = "";
      svg.style.opacity = "";
      delete svg.dataset.preview;
      if (snapHost.current) snapHost.current.style.visibility = "hidden";
    }
    const ov = overlayRef.current;
    if (ov && ov.dataset.preview !== undefined) {
      ov.style.transform = "";
      ov.style.willChange = "";
      ov.style.removeProperty("--pin-k");
      ov.style.removeProperty("--label-k");
      delete ov.dataset.preview;
    }
    // 이번 그리기의 svg 변화(MutationObserver 기록은 이 뒤 microtask로 온다)를 본 다음 끈다
    queueMicrotask(() => {
      queueMicrotask(() => {
        viewCommit.current = false;
      });
    });
  }, [lon, centerY, zoom, view]);

  // 지도 내용이 바뀌면(svg DOM 변화 - 다시 그렸는데 바뀐 게 없으면 그대로) 지도 그림을 새로 굽는다
  // (멈추고 0.5초 뒤, 확대·끌기 중이 아닐 때). 그동안 확대·끌기는 svg를 직접 옮긴다.
  // 렌더마다 버리면 끌기 시작(setViewpoint) 같은 내용 없는 렌더에도 그림을 못 써서 DOM 변화로 판단한다
  useEffect(() => {
    const svg = svgRef.current;
    // 장면 모드는 프레임마다 실제로 그린다(그림으로 늘리고 옮기는 미리보기는 깜빡임·흐림이 섞인다)
    if (!svg || isScene() || isGl()) return;
    // 휴대폰은 좌우 두 화면·위아래 한 화면씩(확대했을 때 금방 그림 밖으로 나가서), 데스크톱은 화면이 커서 한 화면·반 화면씩
    // (그만큼 해상도를 높여 끄는 동안에도 흐리지 않게)
    const coarse = matchMedia("(pointer: coarse)").matches;
    const ex = coarse ? 2 : 1;
    const ey = coarse ? 1 : 0.5;
    /** 움직이는 중에 내용이 바뀌었음(다음 굽기 때 지금 그림을 버린다) */
    let dirty = false;
    /** 끄는 중 곧바로 굽기 예약됨 */
    let soon = false;
    const build = async () => {
      const host = snapHost.current;
      const r = rendered.current;
      const rect = turnRect(
        mapFrame(svg).getBoundingClientRect(),
        squareRef.current,
      );
      if (!host || !r || !rect?.width) return;
      // 그림을 보여 주는 중이면 끝난 뒤에. 끄는 중이라도 그림이 없으면(그림 밖으로 나가 예전 방식으로 그리는 중) 바로 굽는다
      if (
        svg.dataset.preview !== undefined ||
        (gesture.current && snap.current)
      ) {
        snapTimer.current = window.setTimeout(build, 500);
        return;
      }
      if (dirty) {
        dirty = false;
        renderKey.current++;
      }
      const key = renderKey.current;
      const majorAtStart = major.current;
      const { width: W, height: H } = rect;
      // 그림 크기: 화면 (2ex+1)배 × (2ey+1)배. 해상도는 휴대폰 1.5배·800만 화소(아이폰 canvas 한도 1670만),
      // 데스크톱 2배·1600만 화소까지
      const nx = 2 * ex + 1;
      const ny = 2 * ey + 1;
      const scale = Math.min(
        coarse ? 1.5 : 2,
        devicePixelRatio,
        Math.sqrt((coarse ? 8e6 : 16e6) / (W * nx * H * ny)),
      );
      const canvas = await rasterizeSvg(
        svg,
        {
          x: r.v.x - ex * r.v.w,
          y: r.v.y - ey * r.v.h,
          w: r.v.w * nx,
          h: r.v.h * ny,
        },
        { w: W * nx, h: H * ny, scale },
        (clone) => extendCopies(clone, r.v.x - ex * r.v.w, r.v.w * nx),
        host.querySelector("canvas") ?? undefined,
        () => svg.dataset.preview !== undefined,
      );
      if (!canvas) {
        // 굽는 사이 그림 미리보기가 시작됐으면 끝난 뒤 다시
        if (svg.dataset.preview !== undefined)
          snapTimer.current = window.setTimeout(build, 500);
        return;
      }
      if (key !== renderKey.current) return;
      Object.assign(canvas.style, {
        position: "absolute",
        left: `${-ex * W}px`,
        top: `${-ey * H}px`,
        width: `${W * nx}px`,
        height: `${H * ny}px`,
        transformOrigin: `${ex * W}px ${ey * H}px`,
        willChange: "transform",
      });
      if (canvas.parentElement !== host) host.replaceChildren(canvas);
      snap.current = { key, major: majorAtStart, w: W, h: H, ex, ey, r };
    };
    /** 확대·끌기·관성 이동 중(지도 그림을 보여 주는 중 포함) */
    const interacting = () =>
      !!gesture.current ||
      !!momentum.current ||
      snapHost.current?.style.visibility === "visible";
    /**
     * content: 내용이 바뀜(구운 그림을 버림). 화면만 바뀌었으면 그림은 두고 더 선명하게 다시 굽기만.
     * 움직이는 중의 내용 변화(끌기 시작 → 보는 지역이 바뀌어 핀 순위·목록이 바뀜 등)는 끝난 뒤로 미룬다 -
     * 바로 버리면 끌 때마다 그림을 못 쓰고 매번 다시 그리는 길로 빠졌다(아이폰 Safari 타임라인으로 확인)
     */
    /** 화면만 옮겼고(배율 그대로) 아직 그림 안쪽이면 다시 굽지 않는다 - 끌기만 하고 놓을 때마다 굽느라 멈추지 않게 */
    const stillCovers = () => {
      const s = snap.current;
      const r = rendered.current;
      if (!s || !r || Math.abs(s.r.v.w / r.v.w - 1) > 0.02) return false;
      const dx =
        ((-normalizeLon(r.lon - s.r.lon) * MAP_WIDTH) / 360 + s.r.v.x - r.v.x) /
        r.v.w;
      const dy = (s.r.v.y - r.v.y) / r.v.h;
      return Math.abs(dx) < s.ex / 2 && Math.abs(dy) < s.ey / 2;
    };
    const invalidate = (content = true) => {
      if (content) {
        if (interacting()) dirty = true;
        else renderKey.current++;
      } else if (!dirty && stillCovers()) return;
      // 끄는 중인데 그림이 없으면(그림 밖으로 나가 예전 방식) 곧바로 굽는다 - 움직일 때마다 미루면 손을 뗄 때까지 못 굽는다
      if (gesture.current && !snap.current) {
        if (!soon) {
          soon = true;
          window.clearTimeout(snapTimer.current);
          snapTimer.current = window.setTimeout(() => {
            soon = false;
            build();
          }, 60);
        }
        return;
      }
      window.clearTimeout(snapTimer.current);
      // 굽기는 화면을 잠깐 멈춘다(WebKit 데스크톱 70ms, 휴대폰은 더) - 손을 뗀 뒤 0.3초 쉬면
      snapTimer.current = window.setTimeout(build, 300);
    };
    // 미리보기가 svg 자신에 거는 style·data-preview는 내용 변화가 아니다
    const content = new MutationObserver((records) => {
      if (
        records.some(
          (m) =>
            m.target !== svg ||
            (m.attributeName !== "style" && m.attributeName !== "data-preview"),
        )
      )
        invalidate(!viewCommit.current);
    });
    content.observe(svg, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    // 테마·나라 이름 숨기기(html 속성)도 그림을 바꾼다
    const page = new MutationObserver(() => {
      major.current++;
      invalidate();
    });
    page.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-names"],
    });
    invalidate();
    return () => {
      content.disconnect();
      page.disconnect();
      window.clearTimeout(snapTimer.current);
    };
  }, []);

  // 판 모양이 바뀌면(돌리기 시작·끝) 구운 그림은 크기가 맞지 않는다 - 버려서 돌리는 중에도 곧바로 새로 굽게
  useEffect(() => {
    snap.current = null;
  }, [square]);

  // 휠 확대 (페이지 스크롤을 막아야 해서 passive: false로 직접 등록)
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = toPlane(e.clientX, e.clientY);
      zoomAt(zoomRef.current * Math.exp(-e.deltaY * 0.0015), x, y, 150);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, toPlane]);

  // 시점이 바뀌면 가까운 방향으로 회전. 시점 경도는 패널에 가려지지 않은 영역의 가운데에 온다
  // (데스크톱은 오른쪽 사건 패널이 지도 가운데를 가려, 동아시아 시점이 중앙아시아처럼 보였다)
  // 첫 화면(언어 기준 → 시간대 기준)은 회전 없이 바로 놓는다
  const instant = useRef(true);
  const mounted = useRef(false);
  useEffect(() => {
    if (!viewpoint) return;
    const svg = svgRef.current;
    const shift = svg
      ? (mapOffset(svg)[0] * MAP_HEIGHT * 360) /
        (useUi.getState().zoom *
          mapFrame(svg).getBoundingClientRect().height *
          MAP_WIDTH)
      : 0;
    const target = VIEWPOINT_BY_ID.get(viewpoint)!.lon + (shift || 0);
    if (instant.current) {
      if (mounted.current) instant.current = false;
      updateLon(target);
      setCenterLon(lonRef.current);
      return;
    }
    const from = lonRef.current;
    const delta = normalizeLon(target - from);
    if (Math.abs(delta) < 0.01) return;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 600);
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      updateLon(from + delta * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else setCenterLon(lonRef.current);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [viewpoint, setCenterLon, updateLon]);

  // 브라우저에서는 기기 시간대로 사는 곳에 가까운 시점을 고른다(정적 HTML은 언어 기준이라 하이드레이션 뒤에)
  useEffect(() => {
    mounted.current = true;
    let timeZone = "";
    try {
      timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {}
    const ui = useUi.getState();
    const zone = zoneViewpoint(timeZone);
    const region = homeRegion(timeZone, locale);
    if (region)
      ui.setHome({ region, viewpoint: zone ?? homeViewpoint(locale) });
    if (zone && zone !== ui.viewpoint) ui.initViewpoint(zone);
    else instant.current = false;
  }, [locale]);

  // 사건 목록에서 고르면 그 사건이 "가려지지 않은 영역"의 가운데 오도록 이동·확대
  const focus = useUi((s) => s.focus);
  useEffect(() => {
    const svg = svgRef.current;
    if (!focus || !svg) return;
    const rect = mapFrame(svg).getBoundingClientRect();
    const [offsetX, offsetY] = mapOffset(svg);
    const fromLon = lonRef.current;
    const fromY = centerYRef.current;
    const fromZoom = zoomRef.current;
    const toZoom = Math.max(fromZoom, 2.5);
    const upp = MAP_HEIGHT / toZoom / rect.height; // 목표 배율에서 픽셀당 지도 단위(배율은 지도 칸 높이 기준)
    const toLon = focus.coords[0] + (offsetX * upp * 360) / MAP_WIDTH;
    const pointY = makeProjection(0)([0, focus.coords[1]])?.[1] ?? fromY;
    const toY = pointY + offsetY * upp;
    const dLon = normalizeLon(toLon - fromLon);
    setViewpoint(null);
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 700);
      const k = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      // 이동 중에는 미리보기(다시 그리지 않음), 끝에서 한 번 그린다 - 배율이 바뀌는 애니메이션이 휴대폰에서 끊겼다
      lonRef.current = normalizeLon(fromLon + dLon * k);
      centerYRef.current = fromY + (toY - fromY) * k;
      zoomRef.current = fromZoom + (toZoom - fromZoom) * k;
      if (t < 1) {
        previewRef.current(true);
        frame = requestAnimationFrame(tick);
      } else {
        commitRef.current();
        setCenterLon(lonRef.current);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // 새로 고른 사건(focus)에만 움직인다 - 미리보기·그리기 함수는 ref로. 함수를 의존성에 두면 시트를 닫아 가린 높이가
    // 바뀔 때(함수가 새로 만들어짐) 이동을 처음부터 다시 해, 고른 점이 가운데로 또 움직였다
  }, [focus, setViewpoint, setCenterLon]);

  // 해안선: 처음엔 가벼운 110m, 확대하면 자세한 50m로 바꾼다(한 번 받으면 계속 사용)
  const [detailedLand, setDetailedLand] = useState<typeof land | null>(null);
  useEffect(() => {
    if (zoom < 1.5 || detailedLand) return;
    let alive = true;
    loadDetailedLand()
      .then((l) => alive && setDetailedLand(l))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [zoom, detailedLand]);
  const landShape = zoom >= 1.5 && detailedLand ? detailedLand : land;

  const events = useVisibleEvents();
  // 성능: 투영은 경도 0에서 한 번만 하고, 좌우 이동(회전)은 그룹을 옮기는 것(translate)으로 처리한다.
  // 메르카토르에서 경도 회전 = 가로 평행 이동이라 결과가 같고, 끌 때마다 모든 국경을 다시 계산하지 않는다.
  // 장면 모드(브라우저에서만 - 하이드레이션 걱정 없음)는 크게 확대하므로 반올림하지 않는다:
  // 배율 160이면 지도 0.1단위가 화면 16px이라 해안선이 각지고 카메라가 계단처럼 움직였다
  const fine = useHydrated() && (isScene() || isGl());
  const rv = fine ? (x: number) => x : round1;
  const { path, project } = useMemo(() => {
    const projection = makeProjection(0);
    if (fine)
      return {
        path: geoPath(projection),
        project: (coords: [number, number]) => projection(coords),
      };
    // 서버(Node)와 브라우저의 부동소수점 끝자리가 달라 하이드레이션 불일치가 나지 않도록 반올림
    const project = (coords: [number, number]) => {
      const p = projection(coords);
      return p && ([round1(p[0]), round1(p[1])] as const);
    };
    return { path: geoPath(projection).digits(1), project };
  }, [fine]);

  // 확대할수록 작은 나라 이름도 보여준다. 선택한 나라는 항상
  // 나라가 적은 시대(고대 초기 등)는 작은 나라도 이름을 모두 보여준다
  const labeled = useMemo(() => {
    const minArea = polities.length <= 30 ? 0 : LABEL_MIN_AREA / (zoom * zoom);
    const sorted = polities
      .filter(
        (p) =>
          p.properties.l &&
          (p.properties.a >= minArea || p.properties.n === selectedPolity),
      )
      // 넓이가 같으면(원본의 겹친 층) 괄호 없는 이름을 먼저 — "(Carolingian Empire)"보다 "Kingdom of the Franks"
      .sort(
        (a, b) =>
          b.properties.a - a.properties.a ||
          Number(a.properties.n.startsWith("(")) -
            Number(b.properties.n.startsWith("(")),
      );
    // 최대 개수는 조각 수가 아니라 이름 수로 센다 - 한 나라가 여러 조각·겹친 층(식민지, "(British Empire)" 등)이면
    // 조각마다 한 자리씩 차지해 영국 같은 큰 나라 이름이 밀려나던 문제
    const limit = Math.round(MAX_LABELS * zoom);
    const names = new Set<string>();
    const out: typeof sorted = [];
    for (const p of sorted) {
      // 선택한 나라는 개수와 상관없이 항상 이름을 단다
      if (!names.has(p.properties.n) && p.properties.n !== selectedPolity) {
        if (names.size >= limit) continue;
        names.add(p.properties.n);
      }
      out.push(p);
    }
    return out;
  }, [polities, zoom, selectedPolity]);

  // 글자·핀은 확대해도 화면에서 거의 같은 크기로 (지도 좌표 ÷ 배율)
  const unit = 1 / zoom;

  // 설정 "사건 핀 숨기기"(`<html data-pins="off">`, 영상 캡처도) - 핀이 없으면 +N·누르기·말풍선도 없다
  const pinsHidden = useHidden("pins");
  // 핀: 개수 제한 없이 모두, 화면에서 가까운 것(핀 그림 PIN_GROUP단위 안)은 중요한 핀 하나로 묶고 "+N"(확대하면 풀린다)
  const pins = useMemo(
    () =>
      pinsHidden
        ? []
        : clusterPins(
            events.flatMap((e) => {
              const p = project(e.coords);
              return p
                ? [{ id: e.id, importance: e.importance, x: p[0], y: p[1], e }]
                : [];
            }),
            PIN_GROUP * 1.2 * unit,
            MAP_WIDTH,
            selectedEventId,
          ),
    [events, project, unit, selectedEventId, pinsHidden],
  );

  // 이름 배치: 큰 나라부터 놓고, 이미 놓인 이름과 겹치면 뺀다(선택한 나라는 항상 먼저)
  const placedLabels = useMemo(() => {
    const ordered = [...labeled].sort(
      (a, b) =>
        Number(b.properties.n === selectedPolity) -
        Number(a.properties.n === selectedPolity),
    );
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const placed: {
      key: string;
      x: number;
      y: number;
      fontSize: number;
      text: string;
    }[] = [];
    // 원본 국경은 같은 땅을 여러 층으로 겹쳐 둔다(예: 840년 "Kingdom of the Franks"·"(Kingdom of the Franks)"·
    // "(Carolingian Empire)"가 넓이·위치까지 같음) → 같은 이름이나 같은 자리의 이름표는 하나만
    const seenText = new Set<string>();
    const seenPoint = new Set<string>();
    // 이름은 화면에서 똑바로 서게 돌려 그리므로(--turn) 글자가 차지하는 칸도 화면 방향으로 잡는다:
    // 글자가 이어지는 방향(along)과 화면 위쪽(up)을 지도 판 방향으로
    const [ax, ay] = turnVec(1, 0, heading);
    const [ux, uy] = turnVec(0, -1, heading);
    ordered.forEach((p, i) => {
      const at = project(p.properties.l!);
      if (!at) return;
      const point = p.properties.l!.join(",");
      const name = nameOf(p.properties);
      if (seenText.has(name) || seenPoint.has(point)) return;
      seenText.add(name);
      seenPoint.add(point);
      // 기본 8.5, 큰 나라일수록 최대 15까지 (지도 좌표 단위)
      const base = Math.min(
        15,
        8.5 + Math.log10(Math.max(1, p.properties.a / LABEL_MIN_AREA)) * 4,
      );
      const selected = p.properties.n === selectedPolity;
      const fontSize = round2(
        (selected ? Math.max(base, 13) : base) * Math.pow(unit, 0.8),
      );
      const text = name;
      // 글자 폭 추정: 한글·한자 등은 글자 크기만큼, 라틴 문자는 약 0.58배
      const width = [...text].reduce(
        (w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 1 : 0.58) * fontSize,
        0,
      );
      // 글자 칸: 가로로 폭만큼, 세로로 글자선 위 1em·아래 0.25em(화면 기준)
      const boxAt = ([x, y]: [number, number]) => {
        const xs: number[] = [];
        const ys: number[] = [];
        for (const along of [-width / 2, width / 2])
          for (const up of [-0.25 * fontSize, fontSize]) {
            xs.push(x + ax * along + ux * up);
            ys.push(y + ay * along + uy * up);
          }
        return {
          x0: Math.min(...xs),
          x1: Math.max(...xs),
          y0: Math.min(...ys),
          y1: Math.max(...ys),
        };
      };
      const free = (b: ReturnType<typeof boxAt>) =>
        !boxes.some(
          (o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0,
        );
      // 제자리가 막히면 화면 위아래로 조금씩 비켜 본다
      const spot = [0, 1.3, -1.3, 2.6, -2.6]
        .map((step): [number, number] => [
          at[0] - ux * step * fontSize,
          at[1] - uy * step * fontSize,
        ])
        .find((c) => free(boxAt(c)));
      // 나라가 적은 시대(고대 초기)·선택한 나라는 자리가 없어도 표시한다
      if (spot === undefined && !selected && polities.length > 30) return;
      const [finalX, finalY] = (spot ?? [at[0], at[1]]).map(round1);
      boxes.push(boxAt([finalX, finalY]));
      placed.push({
        key: `${p.properties.n}-${i}`,
        x: finalX,
        y: finalY,
        fontSize,
        text,
      });
    });
    return placed;
  }, [
    labeled,
    selectedPolity,
    project,
    unit,
    nameOf,
    polities.length,
    heading,
  ]);
  // 해안선·경위선은 서버 HTML에 넣지 않는다(JS 번들에 같은 데이터가 있어 HTML만 수백 KB 커짐)
  const hydrated = useHydrated();
  const landD = useMemo(
    () => (hydrated ? (path(landShape) ?? "") : ""),
    [hydrated, path, landShape],
  );
  const graticuleD = useMemo(
    () => (hydrated ? (path(graticule) ?? "") : ""),
    [hydrated, path],
  );
  const polityDs = useMemo(
    () => polities.map((p) => path(p) ?? ""),
    [path, polities],
  );
  // 지금 경도만큼 옮긴 위치에 지도를 놓고, 화면에 걸치는 복사본만 그린다(끝없이 이어지는 지도)
  const shift = rv((-lon * MAP_WIDTH) / 360);
  // 복사본 key는 순번(k) - 위치(offset)로 하면 경도가 조금만 바뀌어도(끌기·확대 뒤 다시 그릴 때마다) 복사본을 통째로 지우고
  // 국경 수천 개를 새로 만들어 휴대폰에서 손을 뗀 뒤 크게 멈췄다. 순번이면 위치(transform)만 바뀐다
  const copies = [-2, -1, 0, 1, 2]
    .map((k) => ({ k, offset: rv(shift + k * MAP_WIDTH) }))
    .filter(({ offset: o }) => o < v.x + v.w && o + MAP_WIDTH > v.x);
  // 핀·이름 svg는 좌우 한 화면·위아래 반 화면씩 넓게 그린다 - 끄는 동안 다시 그리지 않고 옮기기만 하므로 화면 밖 핀·이름도 미리
  const overlayCopies = [-2, -1, 0, 1, 2]
    .map((k) => ({ k, offset: rv(shift + k * MAP_WIDTH) }))
    .filter(({ offset: o }) => o < v.x + 2 * v.w && o + MAP_WIDTH > v.x - v.w);

  // 지도 내용은 끌기 중에 바뀌지 않으므로 한 번 만들어 복사본마다 재사용(React가 다시 그리지 않는다).
  // 국경(배율과 무관)과 핀·이름표(배율에 따라 크기가 바뀜)를 나눠, 배율이 바뀌어도 수백 개 국경 경로는 다시 맞춰 보지 않는다
  const bordersLayer = useMemo(
    () => (
      <>
        <path
          d={graticuleD}
          fill="none"
          stroke="var(--map-graticule)"
          style={{ strokeWidth: "calc(0.5 * var(--px))" }}
        />
        {/* 육지 + 나라 영역. 나라 색은 해안선 모양으로 잘라 바다로 번지지 않게 한다 */}
        <path d={landD} fill="var(--map-land)" />

        {/* 선택 연도의 나라 영역 */}
        <g
          clipPath="url(#land-clip)"
          stroke="var(--map-border)"
          strokeLinejoin="round"
          style={{ strokeWidth: "calc(0.6 * var(--px))" }}
        >
          {polities.map((p, i) => {
            const selected = p.properties.n === selectedPolity;
            return (
              <path
                key={`${p.properties.n}-${i}`}
                data-polity={p.properties.n}
                d={polityDs[i]}
                fill={polityColor(p.properties)}
                style={
                  selected
                    ? {
                        fillOpacity: "calc(var(--map-region-opacity) + 0.3)",
                        stroke: "var(--map-label)",
                        strokeWidth: "calc(1.6 * var(--px))",
                      }
                    : { fillOpacity: "var(--map-region-opacity)" }
                }
              />
            );
          })}
        </g>
        <path
          d={landD}
          fill="none"
          stroke="var(--map-border)"
          style={{ strokeWidth: "calc(0.5 * var(--px))" }}
        />
      </>
    ),
    [graticuleD, landD, polities, polityDs, selectedPolity],
  );
  // WebGL 판(?gl)의 핀·말풍선 자료(svg 핀과 같은 순서·색)
  const glPins = useMemo(
    () =>
      pins.flatMap(({ pin, more }) => {
        const region = REGION_BY_ID.get(pin.e.region);
        return region
          ? [
              {
                id: pin.id,
                x: pin.x,
                y: pin.y,
                color: region.color,
                selected: pin.id === selectedEventId,
                more,
              },
            ]
          : [];
      }),
    [pins, selectedEventId],
  );
  const glBubble = useMemo(() => {
    if (pinsHidden) return null;
    const e = events.find((ev) => ev.id === selectedEventId);
    const p = e && project(e.coords);
    if (!e || !p) return null;
    // 사진이 있는 사건은 핀 자리에 둥근 사진(npm run photos의 정사각 사진, 지역 색 테두리)
    const color = REGION_BY_ID.get(e.region)?.color;
    return {
      x: p[0],
      y: p[1],
      title: eventTitle(e, locale),
      photo:
        e.photo && color ? { src: `/photos/${e.id}-s.webp`, color } : undefined,
    };
  }, [events, project, selectedEventId, locale, pinsHidden]);
  const overlayLayer = useMemo(
    () => (
      <>
        {/* 사건 핀: 보이는 점은 작게, 터치 영역(r=16)은 크게. 확대해도 화면 크기 유지 */}
        {pins.map(({ pin, more }) => {
          const e = pin.e;
          const p = [pin.x, pin.y];
          const region = REGION_BY_ID.get(e.region);
          if (!region) return null;
          const selected = e.id === selectedEventId;
          return (
            <g
              key={e.id}
              data-event-id={e.id}
              transform={`translate(${p[0]} ${p[1]}) scale(${round2(unit * 1.2)})`}
              className="pointer-events-auto cursor-pointer"
            >
              <title>{`${formatWhen(e, locale)} ${eventTitle(e, locale)}`}</title>
              {/* 미리보기로 늘린 만큼 줄인다(--pin-k, applyPreview) */}
              <g style={{ transform: "scale(var(--pin-k, 1))" }}>
                <circle r={16} fill="transparent" />
                {/* 고른 점: 물결이 퍼져 "지금 이 사건"이 바로 보이게 */}
                {selected && (
                  <circle
                    r={7.5}
                    fill="none"
                    stroke={region.color}
                    strokeWidth={2}
                    className="pointer-events-none origin-center animate-pin-pulse [transform-box:fill-box] motion-reduce:hidden"
                  />
                )}
                <circle r={selected ? 7.5 : 6} fill="var(--map-pin-stroke)" />
                <circle
                  r={selected ? 5 : 4}
                  fill={region.color}
                  stroke="var(--map-pin-ring)"
                  strokeWidth={selected ? 1.5 : 1}
                />
                {/* 묶인 핀 수: 점 오른쪽 위 작은 표(판을 돌렸으면 화면에서 똑바로) */}
                {more > 0 && (
                  <g
                    className="pointer-events-none"
                    style={{
                      transform: `rotate(var(--turn, 0deg)) translate(${BADGE.x}px, ${BADGE.y}px)`,
                    }}
                  >
                    <rect
                      x={0}
                      y={-BADGE.h / 2}
                      width={badgeWidth(more)}
                      height={BADGE.h}
                      rx={BADGE.h / 2}
                      style={{ fill: "var(--foreground)" }}
                    />
                    <text
                      x={badgeWidth(more) / 2}
                      y={BADGE.font * 0.36}
                      textAnchor="middle"
                      fontSize={BADGE.font}
                      fontWeight={700}
                      style={{ fill: "var(--background)" }}
                    >
                      +{more}
                    </text>
                  </g>
                )}
              </g>
            </g>
          );
        })}

        {/* 나라 이름: 큰 나라부터, 면적에 따라 글자 크기. 핀보다 위에 그리되 터치는 통과 */}
        <g
          fontWeight={600}
          textAnchor="middle"
          fill="var(--map-label)"
          stroke="var(--map-label-halo)"
          strokeWidth={round2(3 * unit)}
          paintOrder="stroke"
          className="map-names pointer-events-none"
        >
          {placedLabels.map((label) => (
            <text
              key={label.key}
              // 미리보기로 늘린 만큼 줄이도록(--label-k) 자리는 CSS transform으로 - 그 점을 중심으로 줄어든다.
              // 바라보는 방향을 돌렸으면 판과 반대로 돌려(--turn) 화면에서 똑바로
              style={{
                transform: `translate(${label.x}px, ${label.y}px) rotate(var(--turn, 0deg)) scale(var(--label-k, 1))`,
              }}
              fontSize={label.fontSize}
            >
              {label.text}
            </text>
          ))}
        </g>

        {/* 고른 사건 이름: 점 바로 위 말풍선, 나라 이름보다 위 층(나라 이름과 붙어 읽히지 않게 바탕을 깐다). 터치는 통과 */}
        {(() => {
          if (pinsHidden) return null;
          const e = events.find((ev) => ev.id === selectedEventId);
          const p = e && project(e.coords);
          if (!e || !p) return null;
          const title = eventTitle(e, locale);
          // 글자 폭 어림(한중일 글자 1em, 그 밖 0.6em) - 말풍선 너비
          const width =
            [...title].reduce(
              (w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 12 : 7.2),
              0,
            ) + 14;
          // 사진이 있으면 핀 자리에 둥근 사진(화면 44px = 핀 그림 단위로 r), 말풍선은 그 위로(WebGL 판과 같은 모양)
          const color = REGION_BY_ID.get(e.region)?.color;
          const r = frame && e.photo ? (22 * MAP_HEIGHT) / (1.2 * frame.h) : 0;
          const lift = r
            ? -r - (4 * MAP_HEIGHT) / (1.2 * frame!.h) - 20 + 33
            : 0;
          return (
            <g
              transform={`translate(${p[0]} ${p[1]}) scale(${round2(unit * 1.2)})`}
              className="pointer-events-none"
            >
              {r > 0 && (
                <g style={{ transform: "scale(var(--pin-k, 1))" }}>
                  <clipPath id="pin-photo">
                    <circle r={r - (2.5 * r) / 22} />
                  </clipPath>
                  <circle r={r + (2 * r) / 22} fill="var(--map-pin-stroke)" />
                  <circle r={r} fill={color} />
                  <image
                    href={`/photos/${e.id}-s.webp`}
                    x={-r}
                    y={-r}
                    width={2 * r}
                    height={2 * r}
                    clipPath="url(#pin-photo)"
                    preserveAspectRatio="xMidYMid slice"
                  />
                </g>
              )}
              {/* 판을 돌렸으면 말풍선은 반대로 돌려 화면에서 점 위에 똑바로 */}
              <g
                style={{
                  transform: "rotate(var(--turn, 0deg)) scale(var(--pin-k, 1))",
                }}
              >
                <rect
                  x={-width / 2}
                  y={-33 + lift}
                  width={width}
                  height={20}
                  rx={6}
                  style={{ fill: "var(--surface)", stroke: "var(--line)" }}
                  strokeWidth={1}
                />
                <text
                  y={-19 + lift}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={700}
                  fill="var(--map-label)"
                >
                  {title}
                </text>
              </g>
            </g>
          );
        })()}
      </>
    ),
    [
      pins,
      events,
      project,
      unit,
      selectedEventId,
      locale,
      placedLabels,
      frame,
      pinsHidden,
    ],
  );

  /** 지금 지도 그림(canvas)으로 미리보기 중인지 */
  const snapPreviewing = () => snapHost.current?.style.visibility === "visible";
  /**
   * 손을 뗀 뒤 그리기: 지도 그림으로 미리보기 중이면 0.25초 쉴 때 한 번(연달아 확대·끌기하는 동안 다시 그리지 않는다 -
   * 다시 그리는 순간 휴대폰이 잠깐 멈춰 다음 손짓과 겹치면 걸렸다), 아니면 바로.
   */
  const settle = () => {
    window.clearTimeout(settleTimer.current);
    const done = () => {
      commitZoom();
      setCenterLon(lonRef.current);
    };
    if (!snapPreviewing()) return done();
    settleTimer.current = window.setTimeout(() => {
      if (!gesture.current && !momentum.current) done();
    }, 250);
  };
  const stopMomentum = () => {
    cancelAnimationFrame(momentum.current);
    momentum.current = 0;
  };
  /** 관성: 끌다 놓은 속도(px/ms)로 미끄러지다 멈춘다(지도 그림만 옮김, iOS 스크롤과 비슷한 감속) */
  const fling = (vx: number, vy: number) => {
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(32, now - last);
      last = now;
      const rect = mapRect();
      if (!rect || !snapUsable()) {
        momentum.current = 0;
        return settle();
      }
      const upp = view(zoomRef.current, centerYRef.current).h / rect.height;
      lonRef.current = normalizeLon(
        lonRef.current - (vx * dt * upp * 360) / MAP_WIDTH,
      );
      centerYRef.current -= vy * dt * upp;
      const k = Math.exp(-dt / 325);
      vx *= k;
      vy *= k;
      previewZoom(true);
      if (Math.hypot(vx, vy) < 0.02) {
        momentum.current = 0;
        return settle();
      }
      momentum.current = requestAnimationFrame(step);
    };
    momentum.current = requestAnimationFrame(step);
  };

  /**
   * 손짓으로 돌리기: 판에 바로 쓰고(다시 그리지 않음), 화면 점 (px, py) 밑의 지도가 그 자리에 있도록 가운데를 옮긴다(미리보기).
   * 판이 대각선 정사각형이어야 모서리가 비지 않으므로 시작할 때 spinning을 켠다
   */
  const spinTo = (h: number, px: number, py: number) => {
    const el = turnRef.current;
    const rect = mapRect();
    if (!el || !rect) return;
    const next = ((h % 360) + 360) % 360;
    const [x0, y0] = toPlane(px, py);
    headingRef.current = next;
    // 저장소에 넣을 때 방향 effect가 다시 돌리지 않게
    shownHeading.current = next;
    // WebGL 판은 headingRef를 매 프레임 읽어 그린다 - 안 보이는 svg 판까지 돌리면 손짓마다 스타일·레이아웃을 다시 해서 무거웠다
    // (판은 손을 뗀 뒤 저장한 방향으로 렌더가 놓는다)
    if (!isGl()) {
      el.style.transform = next ? `rotate(${-next}deg)` : "";
      el.style.setProperty("--turn", `${next}deg`);
    }
    const [x1, y1] = toPlane(px, py);
    const upp = view(zoomRef.current, centerYRef.current).h / rect.height;
    lonRef.current = normalizeLon(
      lonRef.current + ((x0 - x1) * upp * 360) / MAP_WIDTH,
    );
    centerYRef.current += (y0 - y1) * upp;
    previewZoom();
    glMap.current?.request();
  };
  /** 두 손가락 옮기기: 화면 점 (x0, y0) 밑에 있던 지도가 (x1, y1)로 오게(미리보기 - 손을 뗄 때 그린다) */
  const panScreen = (x0: number, y0: number, x1: number, y1: number) => {
    const rect = mapRect();
    if (!rect) return;
    const [ax, ay] = toPlane(x0, y0);
    const [bx, by] = toPlane(x1, y1);
    // 화면 끝에 붙어 잘린 중심값 대신 실제로 보이는 중심에서(끌기와 같이 - 넘긴 만큼 쌓이지 않게)
    const cv = view(zoomRef.current, centerYRef.current);
    const upp = cv.h / rect.height;
    lonRef.current = normalizeLon(
      lonRef.current - ((bx - ax) * upp * 360) / MAP_WIDTH,
    );
    centerYRef.current = cv.y + cv.h / 2 - (by - ay) * upp;
    previewZoom();
  };
  /** 돌리기를 끝내며 저장: 북쪽에서 4° 안이면 북쪽에 맞추고 판을 원래 크기로 */
  const endSpin = (pivot: [number, number] | null) => {
    let h = headingRef.current;
    if ((h < 4 || h > 356) && pivot) {
      spinTo(0, pivot[0], pivot[1]);
      h = 0;
    }
    const raw = useUi.getState().heading;
    setHeading(raw + ((((h - raw) % 360) + 540) % 360) - 180);
    if (!h) setSpinning(false);
    settle();
  };
  /** 돌리는 축: 패널·시트에 가려지지 않은 영역의 가운데(화면 점) */
  const spinPivot = (): [number, number] | null => {
    const svg = svgRef.current;
    const r = hostRef.current?.getBoundingClientRect();
    if (!svg || !r) return null;
    const off = overlayOffset(svg);
    return [r.left + r.width / 2 - off.x, r.top + r.height / 2 - off.y];
  };

  /** 지금 화면(ref 값)에서 지도 좌표 → 판 위 점(client px) */
  const planeOf = (x: number, y: number, rect: DOMRect) => {
    const vv = view(zoomRef.current, centerYRef.current);
    return [
      rect.left + ((x - vv.x) / vv.w) * rect.width,
      rect.top + ((y - vv.y) / vv.h) * rect.height,
    ];
  };
  /**
   * WebGL 판의 핀 누르기: svg 때와 같은 규칙(누르는 범위 r16 안에서 가운데가 가장 가까운 점). 판 위(눕히고 돌리기 전)에서 재므로
   * 기울여도 svg처럼 눌린 원 모양 그대로 맞는다
   */
  const pinAtGl = (cx: number, cy: number): string | null => {
    const rect = mapRect();
    if (!rect || !frame) return null;
    const [fx, fy] = toPlane(cx, cy);
    const reach = (16 * 1.2 * frame.h) / MAP_HEIGHT;
    const shiftNow = (-lonRef.current * MAP_WIDTH) / 360;
    let best: string | null = null;
    let bestD = Infinity;
    for (const pin of glPins) {
      for (let k = -1; k <= 1; k++) {
        const [px, py] = planeOf(pin.x + shiftNow + k * MAP_WIDTH, pin.y, rect);
        const d = Math.hypot(fx - px, fy - py);
        if (d <= reach && d < bestD) {
          bestD = d;
          best = pin.id;
        }
      }
    }
    return best;
  };
  /** WebGL 판의 나라 누르기: 누른 점의 지도 좌표 → 해안선 안쪽 삼각형에 드는 맨 위 나라(svg와 같게) */
  const polityAtGl = (cx: number, cy: number): string | null => {
    const rect = mapRect();
    if (!rect) return null;
    const [fx, fy] = toPlane(cx, cy);
    const vv = view(zoomRef.current, centerYRef.current);
    const x =
      vv.x +
      ((fx - rect.left) / rect.width) * vv.w -
      (-lonRef.current * MAP_WIDTH) / 360;
    const y = vv.y + ((fy - rect.top) / rect.height) * vv.h;
    return glMap.current?.polityAt(x, y) ?? null;
  };

  /**
   * 누른 자리(client px)의 핀: 누르는 범위(r=16) 안에 든 핀 중 보이는 점의 가운데가 가장 가까운 것.
   * 범위가 겹치면 브라우저는 나중에 그린(위에 있는) 핀을 주므로 직접 고른다. 탭할 때만(끌기마다 재지 않게)
   */
  const pinAt = (cx: number, cy: number): string | null => {
    if (isGl()) return pinAtGl(cx, cy);
    let best: string | null = null;
    let bestD = Infinity;
    for (const pin of overlayRef.current?.querySelectorAll<SVGGElement>(
      "[data-event-id]",
    ) ?? []) {
      const area = pin.querySelector("circle")?.getBoundingClientRect();
      if (!area?.width) continue;
      const x = area.left + area.width / 2;
      const y = area.top + area.height / 2;
      const d = Math.hypot(cx - x, cy - y);
      // 기울인 판에서는 범위가 타원이라 가로·세로 중 큰 쪽 반지름으로
      if (d <= Math.max(area.width, area.height) / 2 && d < bestD) {
        bestD = d;
        best = pin.dataset.eventId ?? null;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 관성 이동을 잡고, 쉴 때 그리기 예약은 미룬다(지도 그림 미리보기에서 이어 간다)
    stopMomentum();
    window.clearTimeout(settleTimer.current);
    const previewing = snapPreviewing();
    // svg를 직접 늘린 미리보기(휠 등)가 남아 있으면 먼저 그린다(끌기는 그린 화면 기준)
    if (
      !gesture.current &&
      !previewing &&
      (svgRef.current?.style.transform || previewFrame.current)
    )
      commitZoom();
    e.currentTarget.setPointerCapture(e.pointerId);
    // 끌기·확대는 기울이기 전 지도 칸 위의 점으로 계산한다(toPlane)
    const [px, py] = toPlane(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, {
      x: px,
      y: py,
      sx: e.clientX,
      sy: e.clientY,
    });
    const [a, b] = [...pointers.current.values()];
    // 마우스 오른쪽 단추·Ctrl(⌘)·Shift를 누르고 위아래로 끌면 기울이기(지도 앱과 같은 방식)
    if (
      !b &&
      e.pointerType === "mouse" &&
      (e.button === 2 || e.ctrlKey || e.metaKey || e.shiftKey)
    ) {
      gesture.current = {
        x: px,
        y: py,
        lon: lonRef.current,
        centerY: centerYRef.current,
        moved: true,
        eventId: null,
        polity: null,
        tilt: {
          x: e.clientX,
          y: e.clientY,
          from: tiltRef.current,
          heading: headingRef.current,
          pivot: spinPivot(),
        },
      };
      setSpinning(true);
      return;
    }
    if (b) {
      // 두 번째 손가락: 핀치 시작(같이 위아래로 쓸면 기울이기 - 처음 움직임으로 정한다, 비틀면 핀치 중에도 돌리기가 붙는다)
      gesture.current = {
        x: a.x,
        y: a.y,
        lon: lonRef.current,
        centerY: centerYRef.current,
        moved: true,
        eventId: null,
        polity: null,
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
    const target = e.target as Element;
    // 화면 끝에 붙어 잘린 중심값 대신 실제로 보이는 중심에서 시작(미리보기 중이면 그 화면)
    const cv = view(zoomRef.current, centerYRef.current);
    gesture.current = {
      x: px,
      y: py,
      lon: lonRef.current,
      centerY: cv.y + cv.h / 2,
      moved: false,
      stale: previewing,
      samples: [[e.timeStamp, px, py]],
      // 누른 핀은 뗄 때 가장 가까운 점으로 정한다(pinAt)
      eventId: null,
      polity: previewing
        ? null
        : (target.closest("[data-polity]")?.getAttribute("data-polity") ??
          null),
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || !pointers.current.has(e.pointerId)) return;
    // 기울이기: 위로 끌면 더 눕힌다(지도는 다시 그리지 않고 판만 기울인다). 마우스는 좌우로 끌면 돌리기
    if (g.tilt) {
      applyTilt(
        Math.min(
          MAX_TILT,
          Math.max(0, g.tilt.from - (e.clientY - g.tilt.y) * 0.3),
        ),
      );
      if (g.tilt.pivot)
        spinTo(
          g.tilt.heading + (e.clientX - g.tilt.x) * 0.3,
          g.tilt.pivot[0],
          g.tilt.pivot[1],
        );
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

    /** 두 손가락 각도(도, 화면) */
    const angle = b
      ? (Math.atan2(b.sy - a.sy, b.sx - a.sx) * 180) / Math.PI
      : 0;
    if (b && g.pinch && g.pair) {
      const mx = (a.sx + b.sx) / 2;
      const my = (a.sy + b.sy) / 2;
      const twist = ((angle - g.pair.angle + 540) % 360) - 180;
      if (!g.pair.decided) {
        // 처음 움직임으로 기울이기(옆으로 나란히 같이 위아래, 거리는 그대로)만 따로 정한다. 아니면 핀치 + 옮기기(+ 돌리기)
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
          // 처음부터 비틀었으면 바로 돌리기(핀치도 그대로). 판을 대각선 정사각형으로 바꾼 뒤(spinning) 이어지는 움직임부터 돌린다
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
        // 핀치하다가 비틀어도 돌리기가 붙는다(지도 앱처럼, 문턱을 넘은 뒤부터)
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
      // 손가락을 뗄 때 그린다(onPointerUp)
      zoomAt(
        g.pinch.zoom * (Math.hypot(ax - bx, ay - by) / g.pinch.dist),
        qx,
        qy,
        0,
      );
      return;
    }
    if (b) return;
    const dx = px - g.x;
    const dy = py - g.y;
    if (!g.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    if (!g.moved) {
      g.moved = true;
      setViewpoint(null);
    }
    const unitsPerPixel =
      view(zoomRef.current, centerYRef.current).h / (mapRect()?.height ?? 1);
    g.samples?.push([e.timeStamp, px, py]);
    if (g.samples && g.samples.length > 6) g.samples.shift();
    const nextLon = g.lon - dx * unitsPerPixel * (360 / MAP_WIDTH);
    const nextY = g.centerY - dy * unitsPerPixel;
    // 지도 그림이 있으면(휴대폰) 그림만 옮기고 손을 뗄 때 한 번 그린다 - 끌 때마다 다시 그리면 아이폰에서 밀렸다
    if (snapUsable()) {
      lonRef.current = normalizeLon(nextLon);
      centerYRef.current = nextY;
      previewZoom();
      return;
    }
    updateLon(nextLon);
    updateCenterY(nextY);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    // 기울이기·돌리기가 끝나면(손가락 하나라도 떼면) 저장
    if (g?.tilt || g?.spin) {
      // 남은 손가락은 무시한다(다시 누르면 새 손짓)
      gesture.current = null;
      if (g.tilt) setTilt(tiltRef.current);
      if (g.tilt?.pivot || g.spin) endSpin(g.tilt?.pivot ?? spinPivot());
      return;
    }
    const [px, py] = toPlane(e.clientX, e.clientY);
    // 핀치가 끝나면(손가락 하나라도 떼면) 미리보기 배율을 그린다 - 지도 그림 미리보기면 이어지는 끌기도 그림으로 하고 쉴 때 그린다
    if (g?.pinch && !snapPreviewing()) commitZoom();
    if (pointers.current.size > 0) {
      // 핀치 중 한 손가락만 뗐으면 남은 손가락으로 이어서 끌기
      const [rest] = [...pointers.current.values()];
      if (g) {
        gesture.current = {
          ...g,
          pinch: undefined,
          x: rest.x,
          y: rest.y,
          lon: lonRef.current,
          centerY: centerYRef.current,
          samples: [[e.timeStamp, rest.x, rest.y]],
        };
      }
      return;
    }
    gesture.current = null;
    if (!g) return;
    if (g.moved) {
      // 놓기 직전 0.1초의 속도로 관성 이동(핀치 끝은 제외)
      const recent = (g.samples ?? []).filter(([t]) => e.timeStamp - t < 100);
      const [t0, x0, y0] = recent[0] ?? [0, 0, 0];
      const dt = e.timeStamp - t0;
      const vx = dt > 0 ? (px - x0) / dt : 0;
      const vy = dt > 0 ? (py - y0) / dt : 0;
      if (
        !g.pinch &&
        recent.length > 1 &&
        Math.hypot(vx, vy) > 0.3 &&
        snapPreviewing()
      )
        fling(vx, vy);
      else settle();
      return;
    }
    // 지도 그림 미리보기 중에 누른 탭: 지금 화면을 바로 그리고 그 자리의 핀·나라를 찾는다
    if (g.stale) {
      flushSync(() => commitZoom());
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      g.polity =
        hit?.closest("[data-polity]")?.getAttribute("data-polity") ?? null;
    }
    // 누른 핀은 손가락에서 가장 가까운 점으로(누르는 범위가 겹치면 위에 그려진 핀이 늘 이겨, 붙은 두 점 중 한쪽만 눌렸다)
    g.eventId = pinAt(e.clientX, e.clientY);
    if (isGl()) g.polity = polityAtGl(e.clientX, e.clientY);
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
        return;
      }
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
    // 탭으로 연 패널이 뒤따르는 click에 바로 닫히지 않게(components/map/ghostClick)
    swallowNextClick();
    if (g.eventId) {
      // 시트가 열리며 점을 덮으므로, 패널 크기가 바뀐 뒤(두 프레임 뒤) 점을 가려지지 않은 영역 가운데로 옮긴다
      const coords = events.find((ev) => ev.id === g.eventId)?.coords;
      // 묶음 핀(+N)이면 묶인 사건들을 같이 넘겨 목록에서 한 덩어리로
      const group = pins.find((c) => c.pin.id === g.eventId)?.members;
      // 순서: 누른 대표 사건, 나머지는 시기 순
      selectFromMap(
        g.eventId,
        [
          ...(group?.slice(0, 1) ?? []),
          ...(group?.slice(1) ?? []).sort((a, b) => a.e.start - b.e.start),
        ].map((m) => m.id),
      );
      if (coords)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => focusOn(coords)),
        );
    } else
      setSelectedPolity((cur) =>
        g.polity && g.polity !== cur ? g.polity : null,
      );
  };

  // 영상 장면(개발 서버 ?scene): 카메라·연도를 장면이 정하고, 다 그렸는지 알려 준다
  const sceneOn = hydrated && isScene();
  const sceneTarget = useRef<{
    lon: number;
    zoom: number;
    heading: number;
    tilt: number;
    year: number;
  } | null>(null);
  const sceneState = useRef({
    zoom,
    heading,
    year: period.start,
    ready: false,
  });
  useLayoutEffect(() => {
    sceneState.current = {
      zoom,
      heading,
      year: period.start,
      ready: bordersReady && (zoom < 1.5 || !!detailedLand),
    };
  });
  const sceneHost = useRef<SceneHost | null>(null);
  useLayoutEffect(() => {
    if (!SCENE_DEV || !hydrated) return;
    sceneHost.current = {
      pins: () => {
        const rect = mapRect();
        if (!rect) return [];
        const shift = (-lonRef.current * MAP_WIDTH) / 360;
        return glPins.flatMap((pin) =>
          [-1, 0, 1].flatMap((k) => {
            const [x, y] = planeOf(pin.x + shift + k * MAP_WIDTH, pin.y, rect);
            return x > rect.left &&
              x < rect.right &&
              y > rect.top &&
              y < rect.bottom
              ? [{ id: pin.id, x, y, more: pin.more }]
              : [];
          }),
        );
      },
      apply: (c) => {
        // 장면은 전투 한 곳까지 다가가야 해서 사이트 한계(16)보다 크게
        const zoomTo = Math.min(SCENE_MAX_ZOOM, Math.max(1, c.zoom));
        const lonTo = normalizeLon(c.lon);
        const headingTo = ((c.heading % 360) + 360) % 360;
        const tiltTo = Math.min(MAX_TILT, Math.max(0, c.tilt));
        const yearTo = Math.round(c.year) || 1;
        const ui = useUi.getState();
        const tl = useTimeline.getState();
        if (sceneOn) {
          // 장면: 판은 늘 대각선 정사각형(돌리는 각도가 바뀌어도 판 크기가 그대로), 연도는 정확히(단위 1년)
          if (!ui.spinning) ui.setSpinning(true);
          if (tl.step !== 1) tl.setStep(1);
        }
        // 방향 effect가 돌리는 애니메이션·축 옮기기를 하지 않게(손짓으로 돌릴 때처럼)
        shownHeading.current = headingTo;
        ui.setHeading(headingTo);
        ui.setTilt(tiltTo);
        tl.setYear(yearTo);
        sceneTarget.current = {
          lon: lonTo,
          zoom: zoomTo,
          heading: headingTo,
          tilt: tiltTo,
          // 연도 단위에 맞춘 기간 시작(장면은 단위 1년이라 그대로)
          year: useTimeline.getState().year,
        };
        zoomRef.current = zoomTo;
        useUi.setState({ zoom: zoomTo });
        updateLon(lonTo);
        updateCenterY(makeProjection(0)([0, c.lat])?.[1] ?? MAP_HEIGHT / 2);
      },
      ready: () => {
        const want = sceneTarget.current;
        const r = rendered.current;
        const st = sceneState.current;
        if (!want || !r) return false;
        return (
          st.ready &&
          Math.abs(normalizeLon(r.lon - want.lon)) < 1e-6 &&
          Math.abs(st.zoom - want.zoom) < 1e-9 &&
          Math.abs(st.heading - want.heading) < 1e-6 &&
          Math.abs(tiltRef.current - want.tilt) < 1e-6 &&
          st.year === want.year
        );
      },
    };
  });
  // 개발 서버에서는 장면이 아니어도 같은 조작을 window.__mapView로 연다 - 지도 교체 전후 비교 사진(scripts/dev/map-compare.mjs)이
  // 같은 화면·연도를 정확히 맞춰 찍게. 운영 빌드에는 없다(SCENE_DEV). sceneHost를 이번 렌더 값으로 바꾼 뒤에 연다(앞에 두면 한 렌더 늦은 값 - 핀 숨기기 직후 pins()가 옛 핀을 줬다)
  useLayoutEffect(() => {
    if (!SCENE_DEV || !hydrated) return;
    (window as unknown as { __mapView?: SceneHost }).__mapView =
      sceneHost.current ?? undefined;
  });
  const sceneGeo =
    sceneOn && size && frame ? { v, size, frame, lon, heading, tilt } : null;

  // WebGL 판(?gl): 지금 화면을 ref 값으로 읽어 그린다(손짓 미리보기 중에도 같은 화면). 렌더마다 한 번 다시 그린다
  /** WebGL 판을 만들다 실패하면 svg로 바꿔 다시 그린다 */
  const [glBroken, setGlBroken] = useState(false);
  const glOn = hydrated && !glBroken && isGl();
  const glMap = useRef<GlMapHandle>(null);
  /** 나침반 되돌리기 애니메이션 중 더 돌리고 옮길 양(WebGL 판) */
  const glTurn = useRef<{ rot: number; tx: number; ty: number } | null>(null);
  const glView = useRef<() => GlView | null>(() => null);
  useLayoutEffect(() => {
    glView.current = () => {
      if (!frame || !size) return null;
      const t = tiltRef.current;
      return {
        v: view(zoomRef.current, centerYRef.current),
        shift: (-lonRef.current * MAP_WIDTH) / 360,
        size,
        frame,
        heading: headingRef.current,
        tilt: tiltTransform(t, frame.h),
        // 기울이면 판 밖 먼 쪽도 화면 끝까지 지도로(장면 모드는 장면 층이 그린다)
        farSide: !isScene(),
        turn: glTurn.current ?? undefined,
        zoom: zoomRef.current,
        // 그린 화면 그대로 멈춰 있음(손짓·관성 없음) - 글자를 화면 픽셀에 맞춘다
        still:
          !gesture.current &&
          !momentum.current &&
          zoomRef.current === zoom &&
          lonRef.current === lon &&
          centerYRef.current === centerY,
      };
    };
    glMap.current?.request();
  });

  return (
    // 손짓은 지도 칸이 받는다 - 핀은 위의 핀 svg에, 나라는 아래 국경 svg에 있어서
    <div
      ref={hostRef}
      data-map-frame
      // 기울이면 먼 쪽 너머로 하늘이 보인다. 크기 기준 칸(container) - 옆으로 돌린 판이 지도 칸의 가로·세로를 바꿔 쓴다(cqw·cqh)
      style={{
        background: "linear-gradient(var(--map-sky), var(--map-ocean))",
        containerType: "size",
      }}
      className="absolute inset-0 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => {
        pointers.current.delete(e.pointerId);
        // 핀치·끌기 미리보기가 남아 있으면 그린다(지도 그림이면 쉴 때)
        if (gesture.current?.pinch || gesture.current?.moved) settle();
        gesture.current = null;
      }}
      onDoubleClick={(e) => {
        // 손가락 두 번 탭은 onPointerUp에서 이미 확대했다
        if (Date.now() - touchZoomAt.current < 600) return;
        const [x, y] = toPlane(e.clientX, e.clientY);
        zoomAt(zoomRef.current * 2, x, y);
      }}
      // 오른쪽 단추로 끌어 기울이므로 메뉴는 띄우지 않는다
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* 기울이는 판(applyTilt) - 아래 가운데를 축으로 */}
      {glOn && (
        <GlMap
          ref={glMap}
          getView={glView}
          polities={polities}
          land={landShape}
          selected={selectedPolity}
          pins={glPins}
          labels={placedLabels}
          bubble={glBubble}
          zoom={zoom}
          frameH={frame?.h ?? 0}
          onFail={() => {
            markGlFailed();
            setGlBroken(true);
          }}
        />
      )}
      {/* 영상 장면 WebGL 판(바다·땅·지형·나라 색·해안·마감 - 국경 svg 대신) */}
      {SceneLayer && sceneGeo && (
        <SceneLayer
          where="gl"
          geo={sceneGeo}
          host={sceneHost}
          gl={{ getView: glView, polities, land: landShape }}
        />
      )}
      <div ref={planeRef} className="absolute inset-0 origin-bottom">
        {/* 돌리는 판(바라보는 방향) - 지도 칸 가운데를 축으로. 옆을 보면 가로·세로를 바꾼 크기로 놓고 돌려 지도 칸을 덮는다 */}
        <div
          ref={turnRef}
          className="absolute"
          style={turnStyle(heading, frame, square)}
        >
          <svg
            ref={svgRef}
            viewBox={`${rv(v.x)} ${rv(v.y)} ${rv(v.w)} ${rv(v.h)}`}
            preserveAspectRatio={size ? "none" : "xMidYMid slice"}
            // 화면 1px = 지도 몇 단위(국경선 굵기용). vector-effect: non-scaling-stroke는 배율이 바뀔 때마다 WebKit이
            // 국경 수백 개의 선 모양을 다시 계산해(손을 뗀 뒤 다시 그릴 때 35~55ms) 굵기를 직접 나눈다. 크기를 재기 전(서버 HTML)은 화면 높이 800px로 어림
            style={
              {
                "--px": round4(v.h / (size?.h ?? 800)),
                // WebGL 판이 대신 그린다(나라 누르기 판정은 3단계 전까지 이 svg가 받는다)
                ...(glOn ? { opacity: 0 } : {}),
              } as React.CSSProperties
            }
            role="img"
            aria-label={fill(messages.ui.mapLabel, {
              year: formatPeriod(period, locale),
            })}
            className="absolute inset-0 block h-full w-full"
          >
            <rect
              x={rv(v.x)}
              y={MAP_TOP}
              width={rv(v.w)}
              height={MAP_BOTTOM - MAP_TOP}
              fill="var(--map-ocean)"
            />
            <defs>
              <clipPath id="land-clip">
                <path d={landD} />
              </clipPath>
            </defs>
            {!glOn &&
              copies.map(({ k, offset }) => (
                <g key={k} transform={`translate(${offset} 0)`}>
                  {bordersLayer}
                </g>
              ))}
          </svg>
          {/* 확대·끌기 중에 국경 svg 대신 보이는 지도 그림(snapshot) */}
          <div
            ref={snapHost}
            aria-hidden
            className="pointer-events-none invisible absolute inset-0 overflow-hidden"
          />
          {SceneLayer && sceneGeo && (
            <SceneLayer where="plane" geo={sceneGeo} host={sceneHost} />
          )}
          {/* 핀·나라 이름: 지도 칸보다 좌우 한 화면·위아래 반 화면씩 넓게(끄는 동안 옮기기만 해도 화면 밖 핀이 보이게).
          변환 기준점은 지도 칸 왼쪽 위(33.33% 25%) - 지도 그림과 같은 변환을 그대로 쓴다. 터치는 핀만 받는다 */}
          <svg
            ref={overlayRef}
            aria-hidden
            viewBox={`${round1(v.x - v.w)} ${round1(v.y - v.h / 2)} ${round1(v.w * 3)} ${round1(v.h * 2)}`}
            preserveAspectRatio={size ? "none" : "xMidYMid slice"}
            className="pointer-events-none absolute -top-1/2 -left-full block h-[200%] w-[300%] origin-[33.3333%_25%]"
          >
            {!sceneOn &&
              !glOn &&
              overlayCopies.map(({ k, offset }) => (
                <g key={k} transform={`translate(${offset} 0)`}>
                  {overlayLayer}
                </g>
              ))}
          </svg>
        </div>
      </div>
      {/* 장면의 부대·전투 표시(서 있는 그림 - 눕히지 않고 판 위 자리만 화면으로 옮김) */}
      {SceneLayer && sceneGeo && (
        <SceneLayer where="screen" geo={sceneGeo} host={sceneHost} />
      )}
    </div>
  );
}
