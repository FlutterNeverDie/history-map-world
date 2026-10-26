# components/map — 지도 공용 부품 (도메인 모름)

전쟁 지도(features/campaign)·주제 지도(features/topic)가 같이 쓴다. 두 지도는 브라우저에서 WebGL 판(`useGlViewport` + `gl/GlCanvas`), 서버 HTML·WebGL을 못 쓸 때 svg 판(`useMapViewport`). 사건·전쟁·전염병 같은 기능 데이터를 import하지 않는다.
(본 지도 features/map은 시점·확대 상태를 전역 store와 엮어 쓰므로 아직 자체 구현을 쓴다.)

- `useMapViewport(처음 {lon, lat, zoom})`: 메르카토르 투영(**경도 0에서 한 번만** 투영하고 좌우 이동은 `copies` 위치로 translate — 끌 때 도형을 다시 계산하지 않는다. `path(도형)`은 도형 객체마다 캐시. 복사본 `<g>`의 key·clipPath id는 순번으로), 회전·세로 이동·확대(휠, 두 손가락 핀치, 두 번 클릭·손가락 두 번 탭, 배율 1~16), `focusTo(좌표, 최소 배율)`,
  지도 위 패널(`data-map-overlay`)에 가리지 않게 가운데를 비켜 잡기. `svgProps(onTap)`을 svg에 펼쳐 넣는다.
  배율이 바뀌는 동안(핀치·휠·`focusTo`)은 미리보기: 새 값을 `pending`에만 두고 svg를 CSS transform으로 늘리고 옮긴 뒤, 손을 떼거나(핀치)·0.15초 멈추거나(휠)·이동이 끝나면 한 번 그린다(본 지도 WorldMap과 같은 방식, 전쟁 지도 핀치 38fps → 73fps). svg 부모가 지도 칸 전체를 덮어야 한다(크기를 부모로 잰다). 크기는 미리보기 시작 때 한 번만 재고(`previewRect`), 변환 쓰기는 프레임마다 한 번(`previewFrame`).
- `mapFrame(svg)`(mapCover.ts): 크기를 재는 지도 칸 - `data-map-frame`이 있으면 그것(본 지도: svg를 담은 판을 기울이고 svg에 미리보기 변환을 걸어서), 없으면 svg 부모.
- `mapCover(svg)`·`useMapCover(svgRef)`(mapCover.ts): 지도를 덮은 높이 - 아래(모바일 시트 `data-map-overlay`)와 위(`data-map-top`: 본 지도 제목 상자, 전쟁 지도 상단 바). 세로 이동 한계를 이만큼 늘려(남쪽 끝 희망봉, 북쪽 끝 핀란드 …도 가리지 않은 곳으로) 고른 점을 위아래 가리지 않은 영역의 가운데에 둔다. 본 지도 WorldMap도 같이 쓴다. 지도 위에 새로 위쪽에 떠 있는 것을 만들면 `data-map-top`을 붙인다.
- `rasterizeSvg(svg, 범위, 크기, 손질)`(snapshot.ts): svg를 canvas 한 장으로 굽는다(CSS 변수는 지금 테마 값으로 바꿔 넣음). 본 지도 WorldMap이 확대·끌기 미리보기에 쓴다.
- `usePolities(url)`: 정적 국경 TopoJSON 로더(뒤집힌 도형 제거). `loadJson`·`loadPolities`는 최근 24개만 보관하는 캐시(실패하면 빼서 다시 시도), `useSettled(값)`으로 슬라이더가 멈춘 값만 받는다(끄는 동안 요청 폭주 방지). `usePolityNames(locale)`: 언어별 나라 이름.
- `useMainBordersUrl(year)`: 본 지도 국경 스냅샷(public/borders) 중 그 해에 맞는 파일 — 주제 지도의 배경 국경용.
- `polityColor(key)`: 나라별 고정 색.
- WebGL 지도 공용(본 지도·주제 지도·전쟁 지도). 쓸지 말지는 `gl/support.ts`의 `glAvailable()`(WebGL2 없음·한 번 실패 `markGlFailed`·주소 `?svg`면 svg 지도).
  - `tiltStore`(`useMapTilt`): 주제·전쟁 지도 기울기 - useGlViewport와 설정 메뉴 `MapTiltSetting`(공용 components/ui/TiltSlider)이 같이 본다. 지도가 뜰 때 0, 슬라이더가 바꾸면 손짓·애니메이션 중이 아닐 때 판에 바로.
  - `useGlViewport(처음 {lon, lat, zoom}, onTap(cx, cy, nearest))`: 본 지도 WorldMap과 같은 손짓·카메라(끌기+관성, 휠, 핀치, 두 번 탭, 기울이기 0~55°·방향 아무 각도 - 오른쪽 단추·Ctrl(⌘)·Shift + 끌기, 두 손가락 비틀기(핀치·옮기기와 한꺼번에 - 돌리기는 핀치 중에도 15° 넘게 기울면 붙음)·나란히 위아래, 북쪽 4° 안이면 북쪽에). 화면 값은 ref로 두고 WebGL 판이 매 프레임 읽는다(`getView`), 배율 상태(`zoom`)는 쉴 때 한 번 바꾼다(글자 판·표식 다시 만들기). `focusTo`(가려지지 않은 영역 가운데로 0.7초), `nearest`(누른 자리에서 가장 가까운 점, 판 위에서 재서 기울여도 맞음), `compass`(나침반에 펼쳐 넣을 값·조작 - 되돌리기는 0.45초, 축은 가려지지 않은 영역 가운데). 지도 칸 div에 `hostProps`를 펼치고 WebGL 판에 `canvasRef`.
  - `Compass`: 나침반(늘 보임, 누르면 되돌리기, 잡고 돌리기) + 처음 한 번 방법 안내(localStorage `viewHint` - 어느 지도에서 봤든 한 번). 자리(`place`)·문구는 쓰는 쪽이 넘긴다. 옆(시작 쪽)에 늘 같이 보일 것은 `side`(세 지도 모두 유튜브 버튼 `components/ui/YoutubeButton`). 본 지도 `HeadingControl`도 이것.
  - `gl/GlCanvas`: 주제·전쟁 지도의 WebGL 판 - 땅·나라(나라마다 색·진하기 `GlArea`)·국경선 굵기·직선(점선 가능 `GlLine`)·글자 판(`AtlasSpec`). 연결 끊김 복구·테마 변화 반영·실패하면 `onFail`. 본 지도는 핀·나라 고르기가 있어 features/map `GlMap`.
  - `gl/atlas.ts`의 `buildAtlas(요소, AtlasSpec[], 취소)`: 글자(`text` - 테두리 먼저, 확대 중 자람 `grows`)·직접 그리는 그림(`shape` - 같은 `key`는 한 번만 그려 같이 씀, 점 수백 개)을 2048×256 장들에 그린다. `layer`(작을수록 아래)가 바뀌면 새 장 - 렌더러가 장 순서대로 그린다. 6ms마다 쉬고 새 것이 오면 버린다.
  - `gl/shapes.ts`: 도형 → 삼각형 캐시(`shapeFor`, 6ms씩 나눠 `shapeAll`, 해안선은 작업 스레드 `shapeAllOffThread` → `gl/triangulate.worker.ts` - 50m 유라시아 다각형 하나가 화면 스레드에서 170ms+ 멈췄다), `hit`(삼각형 안인지), CSS 색 → 숫자(`cssColor`, `var(--x)` 가능), 테마(`readTheme`).
  - `gl/renderer.ts`: 기울이면(`GlView.farSide`) 화면 네 모서리를 판 위로 펴서(`drawRange`) 판 밖 먼 쪽까지 그린다 - 바다는 85°N 너머까지, 85°S 너머는 땅 색, 경도 복사본도 그만큼. `setPolities(목록, {lineWidth, alpha})` - alpha를 주면 나라마다 색의 알파(주제·전쟁 지도), 없으면 테마 `--map-region-opacity`(본 지도). `setPaths`(선분마다 색, 화면 px 굵기·점선).
- `projection.ts`: 투영 상수·함수(`MAP_WIDTH`·`MAP_HEIGHT`(배율 기준 높이, 예전 82°N ~ 58°S)·`MAP_TOP`·`MAP_BOTTOM`(지도 범위 85°N ~ 85°S, 세로 이동 한계)·`makeProjection`·`yOfLat`·`normalizeLon` - React·데이터 없음, 작업 스레드도 씀). `useMapViewport`가 다시 내보낸다. `tilt.ts`: 기울이기 행렬·화면 점 펴기(`tiltTransform`·`untilt`). `detailedLand.ts`: 50m 해안선 받기(`loadDetailedLand`, 한 번만)·배율에 맞는 해안선(`useLandFor`).
- `gl/polygons.ts`(WebGL 지도용): 도형(경위도) → 지도 좌표 고리·삼각형(`shapeOf`, 투영·자르기는 d3 그대로라 SVG와 같은 모양, 삼각형은 earcut). 국경은 지금 스냅샷 TopoJSON을 받아 브라우저에서 이것으로 나눈다 - 바이너리 묶음을 따로 만들지 않는 이유(2026-10-21 측정): TopoJSON이 맞닿은 경계를 한 번만 저장하고 gzip이 잘 돼 첫 화면(1940년대) 42KB인데 묶음 바이너리는 114KB, 원본이 이미 약 1km로 단순화·반올림돼 있어 더 촘촘히 저장해도 얻는 게 없다(해안 50m도 TopoJSON gzip 170KB < 바이너리 202KB). 222장 전부 삼각형 넓이 = 도형 넓이(0.5% 안, 예외는 고리가 꼬인 1750·1770 무굴 제국), 한 장 처리 맥 중간 20ms(`scripts/dev/mesh-check.ts`).
- `useHydrated()`: 하이드레이션이 끝났는지. 해안선·경위선 경로(`landD`, `graticuleD`)는 하이드레이션 뒤에만 채운다 — 서버 HTML에 넣으면 복사본·clip·외곽선마다 반복돼 페이지가 수백 KB 커진다(같은 데이터가 JS 번들에 이미 있음). 본 지도 WorldMap도 같은 규칙.
- `swallowNextClick()`(ghostClick.ts): 지도 탭(pointerup)으로 패널을 열면 폰이 같은 자리에 click을 한 번 더 보내, 그 사이 펼쳐진 패널 머리줄을 눌러 바로 닫혀 버린다. 탭으로 연 직후 0.5초 안의 click 하나를 버린다 — `useMapViewport`의 onTap과 본 지도 WorldMap이 쓴다. 새로 pointerup에서 무언가를 여는 코드를 만들면 같이 부른다.
