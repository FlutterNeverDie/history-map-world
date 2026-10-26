import { geoMercator } from "d3-geo";

/**
 * 평면 지도 투영(React·데이터 없음 - 작업 스레드에서도 쓴다): 메르카토르, 가로 1000 단위 = 경도 360°.
 * 지도는 위도 85°N ~ 85°S(MAP_TOP ~ MAP_BOTTOM, 남극까지 - 기울이거나 돌려도 지도 끝 너머가 보이지 않게).
 * 좌표 원점(y = 0)과 배율 기준 높이 MAP_HEIGHT는 예전 범위 82°N ~ 58°S 그대로 - 배율 1 = 이 높이가 지도 칸 높이,
 * 저장된 시점·영상 장면 배율이 바뀌지 않게. 그래서 MAP_TOP은 음수, MAP_BOTTOM은 MAP_HEIGHT보다 크다.
 * 본 지도(features/map baseMap)도 같은 값이다.
 */
export const MAP_WIDTH = 1000;
const SCALE = MAP_WIDTH / (2 * Math.PI);
const mercY = (lat: number) =>
  Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
export const MAP_HEIGHT = Math.round(SCALE * (mercY(82) - mercY(-58)));
export const yOfLat = (lat: number) => SCALE * (mercY(82) - mercY(lat));
export const MAP_TOP = Math.round(yOfLat(85));
export const MAP_BOTTOM = Math.round(yOfLat(-85));
export const normalizeLon = (lon: number) =>
  ((((lon + 180) % 360) + 360) % 360) - 180;
export const makeProjection = (lon: number) =>
  geoMercator()
    .rotate([-lon, 0])
    .scale(SCALE)
    .translate([MAP_WIDTH / 2, SCALE * mercY(82)])
    .clipExtent([
      [0, MAP_TOP],
      [MAP_WIDTH, MAP_BOTTOM],
    ]);
