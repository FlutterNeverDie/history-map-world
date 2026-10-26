import { geoGraticule10 } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import world from "world-atlas/land-110m.json";
import { loadDetailedLand as loadShared } from "@/components/map/detailedLand";

/** 평면(메르카토르) 지도 - 공용 투영(components/map/projection)과 같은 값: 위도 85°N ~ 85°S(MAP_TOP ~ MAP_BOTTOM),
 * 좌표 원점과 배율 기준 높이 MAP_HEIGHT는 예전 범위 82°N ~ 58°S 그대로 */
export {
  MAP_WIDTH,
  MAP_HEIGHT,
  MAP_TOP,
  MAP_BOTTOM,
  makeProjection,
} from "@/components/map/projection";

/** 경도를 -180 ~ 180으로 */
export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export const graticule = geoGraticule10();

/** 육지(현대 해안선, 110m — 처음 화면용). 나라 영역은 이 모양으로 잘라 바다로 번지지 않게 한다 */
const topology = world as unknown as Topology<{ land: GeometryCollection }>;
export const land = feature(topology, topology.objects.land);

/** 확대했을 때 쓰는 자세한 해안선(50m) - 공용(components/map)을 같이 써서 한 번만 받는다 */
export const loadDetailedLand = () => loadShared() as Promise<typeof land>;
