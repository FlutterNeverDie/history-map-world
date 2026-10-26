"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useHydrated } from "@/components/map/useHydrated";
import { glAvailable, markGlFailed } from "@/components/map/gl/support";
import { useI18n } from "@/i18n/I18nProvider";
import {
  polityColor,
  useMainBordersUrl,
  useMapViewport,
  usePolities,
  usePolityNames,
  labelCandidates,
} from "@/components/map";
import { useTopic, useTopicState } from "./store";
import { useTopicPoints, visiblePoints } from "./points";
import {
  currentItems,
  formatT,
  itemTitle,
  topicTitle,
  visibleItems,
  itemColor,
  itemLabelSpots,
} from "./logic";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** WebGL 판(기본) - 코드는 따로 받는다 */
const TopicMapGl = dynamic(
  () => import("./TopicMapGl").then((m) => m.TopicMapGl),
  { ssr: false },
);

/**
 * 주제 지도: 배경은 그 해의 역사 국경(옅게), 위에 항목.
 * span(전염병): 발원지 + 그 시점까지 퍼진 지점을 선으로 잇는다.
 * persist(발명): 생긴 항목은 계속 점으로 남고, 최근 것은 크게 + 이름.
 * 브라우저에서는 WebGL 판(TopicMapGl - 기울이기·방향 돌리기까지 본 지도와 같은 손짓), WebGL2가 없거나 실패하거나 ?svg면 svg 판.
 */
export function TopicMap() {
  const hydrated = useHydrated();
  const [broken, setBroken] = useState(false);
  if (hydrated && !broken && glAvailable())
    return (
      <TopicMapGl
        onFail={() => {
          markGlFailed();
          setBroken(true);
        }}
      />
    );
  return <TopicMapSvg />;
}

/** svg 판(서버 HTML·WebGL을 못 쓸 때) */
function TopicMapSvg() {
  const { locale } = useI18n();
  const selectedPoint = useTopicState((s) => s.selectedPoint);
  const selectPoint = useTopicState((s) => s.selectPoint);
  const topic = useTopic();
  const t = useTopicState((s) => s.t);
  const selected = useTopicState((s) => s.selected);
  const select = useTopicState((s) => s.select);
  const focus = useTopicState((s) => s.focus);
  const vp = useMapViewport(topic.view);
  const year = Math.floor(t / 12);
  const polities = usePolities(useMainBordersUrl(year));
  const nameOf = usePolityNames(locale);

  useEffect(() => {
    if (focus) return vp.focusTo(focus.coords, Math.max(topic.view.zoom, 2.5));
    // 같은 요청(nonce)마다 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const items = useMemo(() => visibleItems(topic, t), [topic, t]);
  const allSubs = useTopicPoints(topic, locale);
  const subs = useMemo(
    () => visiblePoints(allSubs, t, items),
    [allSubs, t, items],
  );
  const highlighted = useMemo(
    () => new Set(currentItems(topic, t).map((i) => i.id)),
    [topic, t],
  );
  const unit = 1 / vp.zoom;
  // 항목마다 다른 색(logic.ts의 itemColor)
  const colorOf = (id: string) => itemColor(topic, id);

  const labelAt = useMemo(
    () =>
      itemLabelSpots(
        items,
        (id) => highlighted.has(id) || id === selected,
        selected,
        vp.project,
        vp.zoom,
        (it) => itemTitle(it, locale),
      ),
    [items, highlighted, selected, vp.project, vp.zoom, locale],
  );

  return (
    <svg
      {...vp.svgProps((target) => {
        const id = target.closest("[data-item]")?.getAttribute("data-item");
        const sub = target.closest("[data-point]")?.getAttribute("data-point");
        const p = sub && subs.find((s) => s.id === sub);
        if (id) select(id);
        else if (p) selectPoint(p);
      })}
      role="img"
      aria-label={`${topicTitle(topic, locale)} - ${formatT(t, topic, locale)}`}
    >
      <rect
        x={vp.v.x}
        y={-500}
        width={vp.v.w}
        height={3000}
        fill="var(--map-ocean)"
      />
      {vp.copies.map((offset, copy) => (
        <g key={copy} transform={`translate(${offset} 0)`}>
          <path
            d={vp.graticuleD}
            fill="none"
            stroke="var(--map-graticule)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />
          <defs>
            <clipPath id={`topic-land-${copy}`}>
              <path d={vp.landD} />
            </clipPath>
          </defs>
          <path d={vp.landD} fill="var(--map-land)" />
          {/* 배경: 그 해의 나라들(옅게) */}
          <g
            clipPath={`url(#topic-land-${copy})`}
            stroke="var(--map-border)"
            strokeWidth={0.4}
          >
            {polities.map((p, i) => (
              <path
                key={`${p.properties.n}-${i}`}
                d={vp.path(p) ?? ""}
                fill={polityColor(p.properties.w ?? p.properties.n)}
                vectorEffect="non-scaling-stroke"
                style={{ fillOpacity: 0.16 }}
              />
            ))}
          </g>
          <path
            d={vp.landD}
            fill="none"
            stroke="var(--map-border)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />

          {/* 확산 경로: 발원지 → 그 시점까지 퍼진 지점 (persist여도 spread가 있으면 그린다 - 종교 전파) */}
          {items.map((it) => {
            const pts = [
              it.coords,
              ...it.spread.filter((s) => s.t <= t).map((s) => s.coords),
            ]
              .map((c) => vp.project(c))
              .filter((p): p is readonly [number, number] => !!p);
            return (
              <g
                key={`path-${it.id}`}
                opacity={selected && selected !== it.id ? 0.35 : 1}
              >
                {pts.slice(1).map((p, k) => (
                  <line
                    key={k}
                    x1={pts[0][0]}
                    y1={pts[0][1]}
                    x2={p[0]}
                    y2={p[1]}
                    stroke={colorOf(it.id)}
                    strokeWidth={1.4}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                    opacity={0.75}
                  />
                ))}
                {pts.slice(1).map((p, k) => (
                  <circle
                    key={`c${k}`}
                    cx={p[0]}
                    cy={p[1]}
                    r={round2(5 * unit)}
                    fill={colorOf(it.id)}
                    fillOpacity={0.55}
                    stroke="#fff"
                    strokeWidth={round2(1 * unit)}
                  />
                ))}
              </g>
            );
          })}

          {/* 작은 점(전쟁 목록의 전투): 항목 색 작은 원, 고른 점은 크게 */}
          {subs.map((s) => {
            const at = vp.project(s.coords);
            if (!at) return null;
            const on = s.id === selectedPoint?.id;
            return (
              <g
                key={s.id}
                data-point={s.id}
                transform={`translate(${at[0]} ${at[1]}) scale(${round2(unit * 1.2)})`}
                className="cursor-pointer"
              >
                <title>{`${s.title} · ${s.when}`}</title>
                <circle r={12} fill="transparent" />
                <circle
                  r={(on ? 4.5 : 3) + 1.5}
                  fill={on ? "var(--foreground)" : "var(--map-pin-stroke)"}
                />
                <circle r={on ? 4.5 : 3} fill={colorOf(s.item)} />
              </g>
            );
          })}

          {/* 항목 점: 터치 영역 크게, 강조 항목은 크게 + 이름 */}
          {items.map((it) => {
            const at = vp.project(it.coords);
            if (!at) return null;
            const strong = highlighted.has(it.id) || it.id === selected;
            const r = strong ? 8 : 4.5;
            return (
              <g
                key={it.id}
                data-item={it.id}
                transform={`translate(${at[0]} ${at[1]}) scale(${round2(unit * 1.2)})`}
                className="cursor-pointer"
              >
                <title>{itemTitle(it, locale)}</title>
                <circle r={16} fill="transparent" />
                {topic.mode === "span" && (
                  <circle r={r + 6} fill={colorOf(it.id)} fillOpacity={0.18} />
                )}
                <circle r={r + 2.5} fill="var(--map-pin-stroke)" />
                <circle
                  r={r}
                  fill={colorOf(it.id)}
                  stroke={it.id === selected ? "var(--foreground)" : "none"}
                  strokeWidth={2}
                />
              </g>
            );
          })}

          {/* 나라 이름(옅게, 큰 나라만) */}
          <g
            fontWeight={500}
            textAnchor="middle"
            fill="var(--muted)"
            stroke="var(--map-label-halo)"
            strokeWidth={round2(2.5 * unit)}
            paintOrder="stroke"
            className="map-names pointer-events-none"
            opacity={0.8}
          >
            {labelCandidates(polities, nameOf)
              .filter(
                ({ polity }) =>
                  polity.properties.a > 1_500_000 / (vp.zoom * vp.zoom),
              )
              .slice(0, 30)
              .map(({ polity: p, text }, i) => {
                const at = vp.project(p.properties.l!);
                return (
                  at && (
                    <text
                      key={`${p.properties.n}-${i}`}
                      x={at[0]}
                      y={at[1]}
                      fontSize={round2(9 * Math.pow(unit, 0.8))}
                    >
                      {text}
                    </text>
                  )
                );
              })}
          </g>

          {/* 항목 이름: 점·나라 이름보다 위에(가려지지 않게). 자리는 labelAt.
              direction ltr: 아랍어(RTL) 페이지에서도 start = 점 오른쪽 */}
          <g
            direction="ltr"
            fontSize={12}
            fontWeight={700}
            fill="var(--map-label)"
            stroke="var(--map-label-halo)"
            strokeWidth={3}
            paintOrder="stroke"
            className="pointer-events-none"
          >
            {items.map((it) => {
              const spot = labelAt.get(it.id);
              const at = spot && vp.project(it.coords);
              return (
                at && (
                  <text
                    key={it.id}
                    transform={`translate(${at[0]} ${at[1]}) scale(${round2(unit * 1.2)})`}
                    x={spot.dx}
                    y={spot.dy}
                    textAnchor={spot.anchor}
                  >
                    {itemTitle(it, locale)}
                  </text>
                )
              );
            })}
            {/* 고른 작은 점: 위에 이름, 아래에 때 */}
            {selectedPoint &&
              subs.some((s) => s.id === selectedPoint.id) &&
              (() => {
                const at = vp.project(selectedPoint.coords);
                return (
                  at && (
                    <g
                      transform={`translate(${at[0]} ${at[1]}) scale(${round2(unit * 1.2)})`}
                      textAnchor="middle"
                    >
                      <text y={-10}>{selectedPoint.title}</text>
                      <text
                        y={18}
                        fontSize={10.5}
                        fontWeight={600}
                        fill="var(--muted)"
                      >
                        {selectedPoint.when}
                      </text>
                    </g>
                  )
                );
              })()}
          </g>
        </g>
      ))}
    </svg>
  );
}
