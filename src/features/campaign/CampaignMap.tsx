"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useHydrated } from "@/components/map/useHydrated";
import { glAvailable, markGlFailed } from "@/components/map/gl/support";
import { useI18n } from "@/i18n/I18nProvider";
import {
  useMapViewport,
  usePolities,
  usePolityNames,
  type PolityProps,
} from "@/components/map";
import { useCampaign, useCampaignState } from "./store";
import {
  battleTitle,
  battlesAt,
  campaignTitle,
  formatTime,
  yearOf,
} from "./logic";
import { battleRadius, polityFill, polityLabels } from "./mapStyle";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** WebGL 판(기본) - 코드는 따로 받는다 */
const CampaignMapGl = dynamic(
  () => import("./CampaignMapGl").then((m) => m.CampaignMapGl),
  { ssr: false },
);

/**
 * 전쟁 지도: 그 시점의 진영별 영토(진영이 없으면 나라별 색) + 진행 중인 전투.
 * 브라우저에서는 WebGL 판(CampaignMapGl - 기울이기·방향 돌리기까지 본 지도와 같은 손짓), WebGL2가 없거나 실패하거나 ?svg면 svg 판.
 */
export function CampaignMap() {
  const hydrated = useHydrated();
  const [broken, setBroken] = useState(false);
  if (hydrated && !broken && glAvailable())
    return (
      <CampaignMapGl
        onFail={() => {
          markGlFailed();
          setBroken(true);
        }}
      />
    );
  return <CampaignMapSvg />;
}

/** svg 판(서버 HTML·WebGL을 못 쓸 때). 지도 조작(끌기·확대·이동)은 공용 useMapViewport */
function CampaignMapSvg() {
  const { locale } = useI18n();
  const c = useCampaign();
  const t = useCampaignState((s) => s.t);
  const selected = useCampaignState((s) => s.selectedBattle);
  const selectBattle = useCampaignState((s) => s.selectBattle);
  const focus = useCampaignState((s) => s.focus);
  const vp = useMapViewport(c.view);
  const year = yearOf(t, c.unit);
  const snapshot = c.borderYears.reduce(
    (pick, y) => (y <= year ? y : pick),
    c.borderYears[0],
  );
  const polities = usePolities(`/campaigns/${c.id}/borders/${snapshot}.json`);
  const nameOf = usePolityNames(locale);

  useEffect(() => {
    if (focus) return vp.focusTo(focus.coords, c.view.zoom * 1.6);
    // 같은 요청(nonce)마다 한 번만
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const battles = useMemo(() => battlesAt(c, t), [c, t]);
  const unit = 1 / vp.zoom;
  const fillOf = (p: PolityProps) => polityFill(c, p, t);

  const labels = useMemo(
    () => polityLabels(polities, nameOf, vp.zoom, vp.project),
    [polities, nameOf, vp.zoom, vp.project],
  );

  return (
    <svg
      {...vp.svgProps((target) => {
        const id = target.closest("[data-battle]")?.getAttribute("data-battle");
        if (id) selectBattle(id);
      })}
      role="img"
      aria-label={`${campaignTitle(c, locale)} - ${formatTime(t, c.unit, locale)}`}
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
            <clipPath id={`war-land-${copy}`}>
              <path d={vp.landD} />
            </clipPath>
          </defs>
          <path d={vp.landD} fill="var(--map-land)" />
          <g
            clipPath={`url(#war-land-${copy})`}
            stroke="var(--map-border)"
            strokeWidth={0.5}
            strokeLinejoin="round"
          >
            {polities.map((p, i) => {
              const [fill, opacity] = fillOf(p.properties);
              return (
                <path
                  key={`${p.properties.n}-${i}`}
                  d={vp.path(p) ?? ""}
                  fill={fill}
                  vectorEffect="non-scaling-stroke"
                  style={{ fillOpacity: opacity }}
                />
              );
            })}
          </g>
          <path
            d={vp.landD}
            fill="none"
            stroke="var(--map-border)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />

          {battles.map((b) => {
            const at = vp.project(b.coords);
            if (!at) return null;
            const on = b.id === selected;
            const r = battleRadius(b);
            return (
              <g
                key={b.id}
                data-battle={b.id}
                transform={`translate(${at[0]} ${at[1]}) scale(${round2(unit * 1.2)})`}
                className="cursor-pointer"
              >
                <title>{battleTitle(b, locale)}</title>
                <circle r={16} fill="transparent" />
                <circle r={r + 3} fill="var(--map-pin-stroke)" opacity={0.9} />
                <circle
                  r={r}
                  fill="#111827"
                  stroke={on ? "var(--accent)" : "#fff"}
                  strokeWidth={on ? 2.5 : 1.5}
                />
                <path
                  d={`M${-r * 0.45} ${-r * 0.45}L${r * 0.45} ${r * 0.45}M${r * 0.45} ${-r * 0.45}L${-r * 0.45} ${r * 0.45}`}
                  stroke="#fff"
                  strokeWidth={1.4}
                />
              </g>
            );
          })}

          <g
            fontWeight={600}
            textAnchor="middle"
            fill="var(--map-label)"
            stroke="var(--map-label-halo)"
            strokeWidth={round2(3 * unit)}
            paintOrder="stroke"
            className="map-names pointer-events-none"
          >
            {labels.map((l) => (
              <text key={l.key} x={l.x} y={l.y} fontSize={l.size}>
                {l.text}
              </text>
            ))}
          </g>
        </g>
      ))}
    </svg>
  );
}
