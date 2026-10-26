import type { Ring, Shape } from "./polygons";
import { cubicBezier } from "./ease";
import { MAP_BOTTOM, MAP_TOP } from "../projection";

/**
 * WebGL2 지도 판(도메인 모름): 지도 좌표(경도 0 메르카토르, 가로 width) 도형을 지금 SVG 지도와 같은 식으로 화면에 그린다.
 *   지도 좌표 → 판(지도 칸 또는 돌린 정사각형) px: (X + 복사본 위치 - view.x) × 판 폭 / view.w
 *   판 px → 지도 칸 px: 판을 가운데 맞춤으로 놓고 가운데를 축으로 -heading 회전
 *   → 기울이기: CSS와 같은 행렬(tilt, 원점 = 지도 칸 아래 가운데)을 그대로 곱해 원근
 * 선 굵기는 화면 px(기울이기 전 판 위에서 - 그래서 기울이면 CSS처럼 원근으로 줄어든다). 나라 색은 해안선 안쪽만(스텐실).
 * 기울이면(farSide) 판 밖 먼 쪽도 화면 끝까지 그린다(drawRange). 지도 위 끝(85°N) 너머는 바다, 아래 끝(85°S) 너머는 땅 색(남극 얼음).
 * 그릴 일이 있을 때만 그린다(request).
 */
export type GlView = {
  /** 보이는 범위(지도 좌표) */
  v: { x: number; y: number; w: number; h: number };
  /** 경도 0에서 지금 경도로 옮기는 양(지도 좌표, 복사본 0번 위치) */
  shift: number;
  /** 판 크기(CSS px) - 돌렸으면 지도 칸 대각선 정사각형 */
  size: { w: number; h: number };
  /** 지도 칸 크기(CSS px) */
  frame: { w: number; h: number };
  heading: number;
  /** 기울이기 행렬(CSS transform 문자열 - 원점은 지도 칸 아래 가운데), 없으면 "" */
  tilt: string;
  /** 기울였을 때 판(보이는 범위) 밖 먼 쪽까지 화면 끝까지 이어 그린다 - 판 끝 너머가 비어 보이지 않게(영상 장면은 장면 층이 따로 그려 false) */
  farSide: boolean;
  /** 나침반 되돌리기 애니메이션 중: 판 가운데를 축으로 더 돌릴 각도(도)와 옮길 양(px, 기울이기 전) */
  turn?: { rot: number; tx: number; ty: number };
  /** 지금 배율(확대하는 동안의 값까지) - 글자는 글자 판을 만든 배율 대비 배율^0.2로 자란다(svg 이름과 같은 규칙) */
  zoom: number;
  /** 화면에 멈춰 있음(글자를 화면 픽셀에 맞춰 선명하게) */
  still: boolean;
};
export type GlTheme = {
  ocean: number[];
  land: number[];
  border: number[];
  graticule: number[];
  label: number[];
  pinStroke: number[];
  pinRing: number[];
  regionOpacity: number;
};
/** 핀 하나: 지도 좌표, 지역 색, 고른 핀인지 */
export type GlPin = {
  x: number;
  y: number;
  color: number[];
  selected: boolean;
};
/** 글자 판(canvas)에서 잘라 붙일 그림 하나: 지도 좌표 기준점, 기준점에서의 사각형(px), 글자 판 안 자리(px) */
export type GlSprite = {
  x: number;
  y: number;
  /** 글자 판 몇 번째 장 */
  page: number;
  rect: [number, number, number, number];
  src: [number, number, number, number];
  /** 확대하는 동안 글자처럼 자라는지(나라 이름) - 아니면 화면 크기 고정(말풍선) */
  grows: boolean;
};
/** 나라 하나: 도형과 색 [r, g, b, a?] - a는 그 나라만의 진하기(주제·전쟁 지도, 없으면 1) */
export type GlPolity = { shape: Shape; color: number[] };
/** 지도 위 직선 하나(지도 좌표 a → b)와 색 [r, g, b, a] - 확산 경로 같은 것 */
export type GlPath = {
  a: [number, number];
  b: [number, number];
  color: number[];
};

/** 지도 좌표 → 지도 칸 px(기울이기 전): 판 위 자리 → 지도 칸 가운데를 축으로 회전 → 애니메이션 옮김 (영상 장면 판도 같이 쓴다) */
export const TO_FRAME = `
uniform vec4 u_view;   // x, y, w, h
uniform vec4 u_plane;  // 판 w, h, 판 왼쪽, 판 위(지도 칸 기준)
uniform vec2 u_frame;
uniform vec2 u_rot;    // cos, sin(회전 각)
uniform vec2 u_tr;     // 애니메이션 옮김(px)
uniform float u_off;   // 복사본 위치(지도 좌표)
uniform mat4 u_m;      // 지도 칸 px(기울이기 전) → clip
vec2 toFrame(vec2 m) {
  vec2 p = vec2((m.x + u_off - u_view.x) * u_plane.x / u_view.z, (m.y - u_view.y) * u_plane.y / u_view.w) + u_plane.zw;
  vec2 c = u_frame * 0.5;
  vec2 d = p - c;
  return c + vec2(d.x * u_rot.x - d.y * u_rot.y, d.x * u_rot.y + d.y * u_rot.x) + u_tr;
}`;
const FILL_VS = `#version 300 es
precision highp float;
in vec2 a_pos;
in vec4 a_col;
${TO_FRAME}
out vec4 v_col;
out vec2 v_p;
void main() {
  vec2 p = toFrame(a_pos);
  v_p = p;
  v_col = a_col;
  gl_Position = u_m * vec4(p, 0.0, 1.0);
}`;
const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_corner;      // (0|1 = 시작|끝, -1|1 = 옆)
in vec4 a_seg;         // 시작 x, y, 끝 x, y (지도 좌표)
in vec4 a_col;         // 선분마다 색(경로 setPaths만 - 나머지는 u_color)
${TO_FRAME}
uniform float u_width;
out vec2 v_p;
out vec4 v_col;
out float v_along;     // 선분 시작에서 잰 거리(px, 점선)
void main() {
  vec2 a = toFrame(a_seg.xy);
  vec2 b = toFrame(a_seg.zw);
  vec2 dir = b - a;
  float len = length(dir);
  dir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  float h = u_width * 0.5;
  // 끝을 굵기 절반만큼 늘려 꺾이는 곳이 비지 않게
  vec2 p = mix(a - dir * h, b + dir * h, a_corner.x) + n * h * a_corner.y;
  v_p = p;
  v_col = a_col;
  v_along = mix(-h, len + h, a_corner.x);
  gl_Position = u_m * vec4(p, 0.0, 1.0);
}`;
const FS = `#version 300 es
precision highp float;
in vec2 v_p;
in vec4 v_col;
uniform vec4 u_color;      // a < 0 이면 정점 색(a_col) 사용
uniform float u_alpha;     // 정점 색일 때 진하기
out vec4 o;
void main() {
  vec4 c = u_color.a < 0.0 ? vec4(v_col.rgb, u_alpha * v_col.a) : u_color;
  float a = c.a;
  o = vec4(c.rgb * a, a);
}`;
const LINE_FS = `#version 300 es
precision highp float;
in vec2 v_p;
in vec4 v_col;
in float v_along;
uniform vec4 u_color;      // a < 0 이면 선분 색(a_col)
uniform vec2 u_dash;       // 점선: 칠한 길이·빈 길이(px), 0이면 실선
out vec4 o;
void main() {
  if (u_dash.x > 0.0 && mod(v_along, u_dash.x + u_dash.y) > u_dash.x) discard;
  vec4 c = u_color.a < 0.0 ? v_col : u_color;
  float a = c.a;
  o = vec4(c.rgb * a, a);
}`;

/** 글자 판에서 잘라 붙이기: 기준점(지도 좌표)을 지도 칸 px로 옮긴 뒤 화면 축에 맞춘 사각형 - 늘 똑바로 서고 기울이면 원근으로 눌린다 */
const SPRITE_VS = `#version 300 es
precision highp float;
in vec2 a_corner;      // 0~1
in vec2 a_anchor;
in vec4 a_rect;        // 기준점에서 x, y, w, h(px)
in vec4 a_src;         // 글자 판 안 x, y, w, h(px)
in float a_grows;
${TO_FRAME}
uniform float u_labelScale;
uniform vec2 u_atlas;
uniform float u_dpr;
uniform bool u_snap;
out vec2 v_p;
out vec2 v_uv;
void main() {
  vec2 a = toFrame(a_anchor);
  float k = a_grows > 0.5 ? u_labelScale : 1.0;
  vec2 o = a_rect.xy * k;
  // 멈춰 있으면 화면 픽셀에 맞춰 글자가 흐려지지 않게
  if (u_snap) o = floor((a + o) * u_dpr + 0.5) / u_dpr - a;
  vec2 p = a + o + a_corner * a_rect.zw * k;
  v_p = p;
  v_uv = (a_src.xy + a_corner * a_src.zw) / u_atlas;
  gl_Position = u_m * vec4(p, 0.0, 1.0);
}`;
const SPRITE_FS = `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 o;
void main() {
  o = texture(u_tex, v_uv);
}`;
/** 핀(지금 svg 핀과 같은 원들): 바깥 흰 원 r6(고르면 7.5), 안쪽 지역 색 r4(5) + 테두리 1(1.5), 고른 핀은 물결 원(r7.5, 2) */
const PIN_VS = `#version 300 es
precision highp float;
in vec2 a_corner;      // -1~1
in vec2 a_anchor;
in vec3 a_color;
in float a_sel;
${TO_FRAME}
uniform float u_unit;  // 핀 그림 1단위 = px
uniform float u_pulse; // 물결 배율(1~3.2)
out vec2 v_p;
out vec2 v_q;          // 핀 그림 단위 좌표
out vec3 v_color;
out float v_sel;
void main() {
  vec2 a = toFrame(a_anchor);
  float r = a_sel > 0.5 ? max(9.0, 7.5 * u_pulse + 1.5) : 7.0;
  v_q = a_corner * r;
  vec2 p = a + v_q * u_unit;
  v_p = p;
  v_color = a_color;
  v_sel = a_sel;
  gl_Position = u_m * vec4(p, 0.0, 1.0);
}`;
const PIN_FS = `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_q;
in vec3 v_color;
in float v_sel;
uniform vec4 u_stroke;
uniform vec4 u_ring;
uniform float u_unit;
uniform float u_pulse;
uniform float u_pulseAlpha;
out vec4 o;
// 원 안쪽 덮임(가장자리 1px 부드럽게)
float disk(float d, float r) { return clamp((r - d) * u_unit + 0.5, 0.0, 1.0); }
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
void main() {
  float d = length(v_q);
  bool sel = v_sel > 0.5;
  float ro = sel ? 7.5 : 6.0;
  float ri = sel ? 5.0 : 4.0;
  float sw = sel ? 1.5 : 1.0;
  vec4 c = vec4(0.0);
  if (sel && u_pulseAlpha > 0.0) {
    // 물결: 반지름 7.5·굵기 2인 고리를 배율만큼 키운다(svg scale과 같음)
    float rr = 7.5 * u_pulse;
    float hw = u_pulse;
    float ring = disk(d, rr + hw) - disk(d, rr - hw);
    c = over(vec4(v_color, 1.0) * ring * u_pulseAlpha, c);
  }
  c = over(u_stroke * disk(d, ro), c);
  c = over(vec4(v_color, 1.0) * disk(d, ri), c);
  float edge = disk(d, ri + sw * 0.5) - disk(d, ri - sw * 0.5);
  c = over(u_ring * edge, c);
  o = c;
}`;

/** 지도 칸 px(기울이기 전) → clip: 기울이기(CSS 행렬, 원점 지도 칸 아래 가운데) 다음 clip 좌표로 */
export function frameMatrix(view: GlView): Float32Array {
  const { w: fw, h: fh } = view.frame;
  let m = new DOMMatrix();
  m = m.multiply(new DOMMatrix([2 / fw, 0, 0, -2 / fh, -1, 1]));
  if (view.tilt)
    m = m
      .translate(fw / 2, fh)
      .multiply(new DOMMatrix(view.tilt))
      .translate(-fw / 2, -fh);
  const mat = m.toFloat32Array();
  // 깊이(z)는 쓰지 않는다 - 기울이면 z가 수백 px라 그대로 두면 GPU가 잘라 버린다. 대신 z = w - 2δ로 두어 눈 바로 앞(w = δ)에
  // 가까운 면을 만든다: z를 0으로 두면 가까운 면이 w = 0이 되어, 눈 뒤로 넘어가는 삼각형(영상 장면의 먼 땅 부채꼴)을 자를 때
  // 무한대 꼭짓점이 생겨 칠하기가 엉뚱하게 번졌다. w > δ인 점은 그대로 그려진다
  const near = 0.01;
  mat[2] = mat[3];
  mat[6] = mat[7];
  mat[10] = mat[11];
  mat[14] = mat[15] - 2 * near;
  return mat;
}
/**
 * 그릴 범위(지도 좌표, view.v와 같은 기준): 보통은 보이는 범위 view.v, 기울였으면(farSide) 화면 네 모서리를 판 위로 펴서
 * 먼 쪽까지 - 판 밖도 화면 끝까지 지도가 이어진다. 기울기 55°까지는 지평선이 화면 위에 있어 모서리가 늘 판 앞쪽에 떨어진다
 * (눈 거리 = 지도 칸 높이 2배, tilt.ts). 그래도 혹시 지평선 너머면 보이는 범위의 몇 배로 끊는다.
 */
export function drawRange(view: GlView) {
  const { v, size, frame } = view;
  const r = { x0: v.x, x1: v.x + v.w, y0: v.y, y1: v.y + v.h };
  if (!view.farSide || !view.tilt) return r;
  const { w: fw, h: fh } = frame;
  const m = new DOMMatrix()
    .translate(fw / 2, fh)
    .multiply(new DOMMatrix(view.tilt))
    .translate(-fw / 2, -fh);
  // 판(z = 0) → 화면은 3×3 사영 변환 - 거꾸로 풀어 화면 점을 판 위 점(지도 칸 px, 기울이기 전)으로
  const [a, b, c, d, e, f, g, h, i] = [
    m.m11,
    m.m21,
    m.m41,
    m.m12,
    m.m22,
    m.m42,
    m.m14,
    m.m24,
    m.m44,
  ];
  const A = e * i - f * h,
    B = c * h - b * i,
    C = b * f - c * e;
  const D = f * g - d * i,
    E = a * i - c * g,
    F = c * d - a * f;
  const G = d * h - e * g,
    H = b * g - a * h,
    I = a * e - b * d;
  const rad = ((-view.heading + (view.turn?.rot ?? 0)) * Math.PI) / 180;
  const cos = Math.cos(rad),
    sin = Math.sin(rad);
  const tx = view.turn?.tx ?? 0,
    ty = view.turn?.ty ?? 0;
  const limit = 6 * Math.max(v.w, v.h);
  for (const [sx, sy] of [
    [0, 0],
    [fw, 0],
    [0, fh],
    [fw, fh],
  ]) {
    const w = G * sx + H * sy + I;
    if (w <= 1e-9) continue;
    // 지도 칸 px → 회전·옮김을 되돌려 판 px → 지도 좌표(TO_FRAME의 거꾸로)
    const qx = (A * sx + B * sy + C) / w - fw / 2 - tx;
    const qy = (D * sx + E * sy + F) / w - fh / 2 - ty;
    const px = fw / 2 + qx * cos + qy * sin - (fw - size.w) / 2;
    const py = fh / 2 - qx * sin + qy * cos - (fh - size.h) / 2;
    const mx = Math.min(
      v.x + v.w + limit,
      Math.max(v.x - limit, v.x + (px * v.w) / size.w),
    );
    const my = Math.min(
      v.y + v.h + limit,
      Math.max(v.y - limit, v.y + (py * v.h) / size.h),
    );
    r.x0 = Math.min(r.x0, mx);
    r.x1 = Math.max(r.x1, mx);
    r.y0 = Math.min(r.y0, my);
    r.y1 = Math.max(r.y1, my);
  }
  return r;
}
/** TO_FRAME이 쓰는 값(u_view·u_plane·u_frame·u_rot·u_tr·u_m)을 지금 프로그램에 */
export function setFrameUniforms(
  gl: WebGL2RenderingContext,
  u: (name: string) => WebGLUniformLocation | null,
  view: GlView,
) {
  const { w: fw, h: fh } = view.frame;
  const rad = ((-view.heading + (view.turn?.rot ?? 0)) * Math.PI) / 180;
  gl.uniform4f(u("u_view"), view.v.x, view.v.y, view.v.w, view.v.h);
  gl.uniform4f(
    u("u_plane"),
    view.size.w,
    view.size.h,
    (fw - view.size.w) / 2,
    (fh - view.size.h) / 2,
  );
  gl.uniform2f(u("u_frame"), fw, fh);
  gl.uniform2f(u("u_rot"), Math.cos(rad), Math.sin(rad));
  gl.uniform2f(u("u_tr"), view.turn?.tx ?? 0, view.turn?.ty ?? 0);
  gl.uniformMatrix4fv(u("u_m"), false, frameMatrix(view));
}

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const u = new Map<string, WebGLUniformLocation | null>();
  return {
    p,
    u: (name: string) =>
      u.has(name)
        ? u.get(name)!
        : (u.set(name, gl.getUniformLocation(p, name)), u.get(name)!),
  };
}

type Fill = {
  vao: WebGLVertexArrayObject;
  count: number;
  buf: WebGLBuffer;
  idx: WebGLBuffer;
};
type Lines = { vao: WebGLVertexArrayObject; count: number; buf: WebGLBuffer };
type SpriteSet = {
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
  pages: {
    tex: WebGLTexture;
    size: [number, number];
    first: number;
    count: number;
  }[];
  zoom: number;
};

export class MapRenderer {
  private gl: WebGL2RenderingContext;
  private fill: ReturnType<typeof compile>;
  private line: ReturnType<typeof compile>;
  private corner: WebGLBuffer;
  private land: Fill | null = null;
  private coast: Lines | null = null;
  private polities: Fill | null = null;
  private polityLines: Lines | null = null;
  /** 국경선 굵기(px)·나라 색 진하기(없으면 테마 regionOpacity) */
  private polityStyle: { lineWidth: number; alpha?: number } = {
    lineWidth: 0.6,
  };
  private paths: Lines | null = null;
  private pathStyle = { width: 1, dash: [0, 0] };
  private selected: { fill: Fill; line: Lines } | null = null;
  private graticule: Lines | null = null;
  private ocean: WebGLBuffer;
  private oceanVao: WebGLVertexArrayObject;
  private theme: GlTheme | null = null;
  private sprite: ReturnType<typeof compile>;
  private pin: ReturnType<typeof compile>;
  private unitCorner: WebGLBuffer;
  private pinCorner: WebGLBuffer;
  private pins: {
    vao: WebGLVertexArrayObject;
    buf: WebGLBuffer;
    count: number;
  } | null = null;
  /** 그리는 글자 판(장마다 텍스처·그릴 범위) */
  private sprites: SpriteSet | null = null;
  /** 올리는 중인 다음 글자 판 - 한 프레임에 한 장씩 올리고 다 되면 바꿔 끼운다 */
  private pendingSprites: {
    set: SpriteSet;
    pages: HTMLCanvasElement[];
    next: number;
  } | null = null;
  /** 고른 핀이 나타난 시각(물결 애니메이션 시작) */
  private pulseFrom = 0;
  private reduceMotion = false;
  private frame = 0;
  private getView: () => GlView | null = () => null;
  constructor(
    private canvas: HTMLCanvasElement,
    private mapWidth: number,
    private mapHeight: number,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      stencil: true,
      premultipliedAlpha: true,
      alpha: true,
    });
    if (!gl) throw new Error("WebGL2 없음");
    this.gl = gl;
    this.fill = compile(gl, FILL_VS, FS);
    this.line = compile(gl, LINE_VS, LINE_FS);
    this.corner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.ocean = gl.createBuffer()!;
    this.oceanVao = gl.createVertexArray()!;
    this.sprite = compile(gl, SPRITE_VS, SPRITE_FS);
    this.pin = compile(gl, PIN_VS, PIN_FS);
    this.unitCorner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitCorner);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.pinCorner = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pinCorner);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    this.reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  setViewSource(get: () => GlView | null) {
    this.getView = get;
  }
  setTheme(theme: GlTheme) {
    this.theme = theme;
    this.request();
  }

  /** 도형들 → 채우기(정점 색, 정점마다 [r,g,b,번호]) */
  private makeFill(items: { shape: Shape; color: number[] }[]): Fill {
    const gl = this.gl;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    items.forEach(({ shape, color }) => {
      const base = pos.length / 2;
      for (const r of shape.rings)
        for (const [x, y] of r) {
          pos.push(x, y);
          col.push(color[0], color[1], color[2], color[3] ?? 1);
        }
      for (const i of shape.tris) idx.push(base + i);
    });
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const data = new Float32Array(pos.length * 3);
    for (let i = 0, n = pos.length / 2; i < n; i++) {
      data.set(
        [
          pos[i * 2],
          pos[i * 2 + 1],
          col[i * 4],
          col[i * 4 + 1],
          col[i * 4 + 2],
          col[i * 4 + 3],
        ],
        i * 6,
      );
    }
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(this.fill.p, "a_pos");
    const aCol = gl.getAttribLocation(this.fill.p, "a_col");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(aCol);
    gl.vertexAttribPointer(aCol, 4, gl.FLOAT, false, 24, 8);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint32Array(idx),
      gl.STATIC_DRAW,
    );
    gl.bindVertexArray(null);
    return { vao, count: idx.length, buf, idx: ib };
  }
  /** 꺾은선·고리 → 선분 묶음(선분마다 사각형 하나를 그린다) */
  private makeLines(lines: Ring[], closed: boolean): Lines {
    const gl = this.gl;
    const seg: number[] = [];
    for (const l of lines) {
      for (let i = 0; i < l.length - 1; i++)
        seg.push(l[i][0], l[i][1], l[i + 1][0], l[i + 1][1]);
      if (closed && l.length > 2) {
        const a = l[l.length - 1];
        const b = l[0];
        if (a[0] !== b[0] || a[1] !== b[1]) seg.push(a[0], a[1], b[0], b[1]);
      }
    }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    const aC = gl.getAttribLocation(this.line.p, "a_corner");
    gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aC, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(seg), gl.STATIC_DRAW);
    const aS = gl.getAttribLocation(this.line.p, "a_seg");
    gl.enableVertexAttribArray(aS);
    gl.vertexAttribPointer(aS, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(aS, 1);
    gl.bindVertexArray(null);
    return { vao, count: seg.length / 4, buf };
  }
  private dropFill(f: Fill | null) {
    if (!f) return;
    this.gl.deleteBuffer(f.buf);
    this.gl.deleteBuffer(f.idx);
    this.gl.deleteVertexArray(f.vao);
  }
  private dropLines(l: Lines | null) {
    if (!l) return;
    this.gl.deleteBuffer(l.buf);
    this.gl.deleteVertexArray(l.vao);
  }

  setLand(shapes: Shape[]) {
    this.dropFill(this.land);
    this.dropLines(this.coast);
    this.land = this.makeFill(
      shapes.map((shape) => ({ shape, color: [0, 0, 0] })),
    );
    this.coast = this.makeLines(
      shapes.flatMap((s) => s.rings),
      true,
    );
    this.request();
  }
  setGraticule(lines: Ring[]) {
    this.dropLines(this.graticule);
    this.graticule = this.makeLines(lines, false);
    this.request();
  }
  setPolities(
    list: GlPolity[],
    style: { lineWidth?: number; alpha?: number } = {},
  ) {
    this.polityStyle = {
      lineWidth: style.lineWidth ?? 0.6,
      alpha: style.alpha,
    };
    this.dropFill(this.polities);
    this.dropLines(this.polityLines);
    this.polities = this.makeFill(list);
    this.polityLines = this.makeLines(
      list.flatMap((p) => p.shape.rings),
      true,
    );
    this.request();
  }
  /** 지도 위 직선들(나라 위·핀 아래). width·dash는 화면 px(dash = [칠한 길이, 빈 길이]) */
  setPaths(list: GlPath[], width: number, dash: [number, number] = [0, 0]) {
    const gl = this.gl;
    this.dropLines(this.paths);
    this.pathStyle = { width, dash };
    const data = new Float32Array(list.length * 8);
    list.forEach((p, i) =>
      data.set(
        [
          p.a[0],
          p.a[1],
          p.b[0],
          p.b[1],
          p.color[0],
          p.color[1],
          p.color[2],
          p.color[3] ?? 1,
        ],
        i * 8,
      ),
    );
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner);
    const aC = gl.getAttribLocation(this.line.p, "a_corner");
    gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aC, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, off: number) => {
      const loc = gl.getAttribLocation(this.line.p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr("a_seg", 0);
    attr("a_col", 16);
    gl.bindVertexArray(null);
    this.paths = { vao, count: list.length, buf };
    this.request();
  }
  /** 고른 나라: 더 진하게(+0.3) + 테두리(라벨 색 1.6px) - 그 나라 자리에 한 번 더 그린다 */
  setSelected(p: GlPolity | null) {
    if (this.selected) {
      this.dropFill(this.selected.fill);
      this.dropLines(this.selected.line);
    }
    this.selected = p
      ? { fill: this.makeFill([p]), line: this.makeLines(p.shape.rings, true) }
      : null;
    this.request();
  }

  /** 핀(지금 svg 핀과 같은 순서로 - 뒤의 것이 위). 고른 핀이 바뀌면 물결을 처음부터 */
  setPins(list: GlPin[], selectedChanged: boolean) {
    const gl = this.gl;
    if (this.pins) {
      gl.deleteBuffer(this.pins.buf);
      gl.deleteVertexArray(this.pins.vao);
    }
    const data = new Float32Array(list.length * 6);
    list.forEach((p, i) =>
      data.set(
        [p.x, p.y, p.color[0], p.color[1], p.color[2], p.selected ? 1 : 0],
        i * 6,
      ),
    );
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pinCorner);
    const aC = gl.getAttribLocation(this.pin.p, "a_corner");
    gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aC, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, n: number, off: number) => {
      const loc = gl.getAttribLocation(this.pin.p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 24, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr("a_anchor", 2, 0);
    attr("a_color", 3, 8);
    attr("a_sel", 1, 20);
    gl.bindVertexArray(null);
    this.pins = { vao, buf, count: list.length };
    if (selectedChanged && list.some((p) => p.selected))
      this.pulseFrom = performance.now();
    this.request();
  }
  /**
   * 글자 판(나라 이름·말풍선을 브라우저 글꼴로 그린 canvas 여러 장)과 붙일 자리들. zoom: 글자 판을 만든 배율.
   * 처음이 아니면 한 프레임에 한 장씩 GPU로 올리고(한 번에 올리면 그 프레임이 멈췄다) 다 올라가면 바꿔 끼운다 - 그동안 전 글자 판
   */
  setSprites(pages: HTMLCanvasElement[], list: GlSprite[], zoom: number) {
    const gl = this.gl;
    if (this.pendingSprites) this.dropSprites(this.pendingSprites.set);
    // 장 순서로 모아(말풍선 장이 마지막 - 이름보다 위)
    const order = list
      .map((sp, i) => [sp, i] as const)
      .sort((a, b) => a[0].page - b[0].page || a[1] - b[1])
      .map(([sp]) => sp);
    const data = new Float32Array(order.length * 11);
    order.forEach((sp, i) =>
      data.set([sp.x, sp.y, ...sp.rect, ...sp.src, sp.grows ? 1 : 0], i * 11),
    );
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitCorner);
    const aC = gl.getAttribLocation(this.sprite.p, "a_corner");
    gl.enableVertexAttribArray(aC);
    gl.vertexAttribPointer(aC, 2, gl.FLOAT, false, 0, 0);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const attr = (name: string, n: number, off: number) => {
      const loc = gl.getAttribLocation(this.sprite.p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 44, off);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr("a_anchor", 2, 0);
    attr("a_rect", 4, 8);
    attr("a_src", 4, 24);
    attr("a_grows", 1, 40);
    gl.bindVertexArray(null);
    let first = 0;
    const set: SpriteSet = {
      vao,
      buf,
      zoom,
      pages: pages.map((c, pi) => {
        const count = order.filter((sp) => sp.page === pi).length;
        const pg = {
          tex: gl.createTexture()!,
          size: [c.width, c.height] as [number, number],
          first,
          count,
        };
        first += count;
        return pg;
      }),
    };
    this.pendingSprites = { set, pages, next: 0 };
    // 처음은 한 번에(첫 화면에 이름이 바로 보이게)
    if (!this.sprites) while (this.pendingSprites) this.uploadSpritePage();
    this.request();
  }
  /** 올리는 중인 글자 판 한 장을 GPU로(다 올라가면 바꿔 끼운다) */
  private uploadSpritePage() {
    const p = this.pendingSprites;
    if (!p) return;
    const gl = this.gl;
    const pg = p.set.pages[p.next];
    if (pg) {
      gl.bindTexture(gl.TEXTURE_2D, pg.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        p.pages[p.next],
      );
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      p.next++;
    }
    if (p.next >= p.set.pages.length) {
      if (this.sprites) this.dropSprites(this.sprites);
      this.sprites = p.set;
      this.pendingSprites = null;
      this.request();
    }
  }
  private dropSprites(set: SpriteSet) {
    const gl = this.gl;
    gl.deleteBuffer(set.buf);
    gl.deleteVertexArray(set.vao);
    for (const pg of set.pages) gl.deleteTexture(pg.tex);
  }

  /** 다음 프레임에 한 번 그린다 */
  request() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }
  destroy() {
    cancelAnimationFrame(this.frame);
    // 연결을 일부러 끊지 않는다 - 같은 캔버스로 다시 만들면(개발 모드 StrictMode 두 번 실행) 끊긴 연결이 돌아와 셰이더가 실패했다.
    // 캔버스가 사라지면 브라우저가 거둔다
  }

  draw() {
    const view = this.getView();
    const theme = this.theme;
    const gl = this.gl;
    if (!view || !theme) return;
    const dpr = devicePixelRatio || 1;
    const W = Math.round(view.frame.w * dpr);
    const H = Math.round(view.frame.h * dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);

    const fh = view.frame.h;
    const common = (prog: ReturnType<typeof compile>) => {
      gl.useProgram(prog.p);
      setFrameUniforms(gl, prog.u, view);
    };
    const color = (
      prog: ReturnType<typeof compile>,
      c: number[],
      alpha = 1,
    ) => {
      gl.uniform4f(prog.u("u_color"), c[0], c[1], c[2], (c[3] ?? 1) * alpha);
    };

    // 바다: 그릴 범위 가로 전체, 세로는 지도 위 끝(85°N) 너머까지. 아래 끝(85°S) 너머는 땅 색(남극 얼음이 이어지게)
    const range = drawRange(view);
    common(this.fill);
    gl.uniform1f(this.fill.u("u_off"), 0);
    gl.bindVertexArray(this.oceanVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ocean);
    const aPos = gl.getAttribLocation(this.fill.p, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(gl.getAttribLocation(this.fill.p, "a_col"));
    const band = (y0: number, y1: number, c: number[]) => {
      if (y1 <= y0) return;
      color(this.fill, c);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([
          range.x0,
          y0,
          range.x1,
          y0,
          range.x0,
          y1,
          range.x1,
          y1,
        ]),
        gl.DYNAMIC_DRAW,
      );
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    band(Math.min(range.y0, MAP_TOP), MAP_BOTTOM, theme.ocean);
    band(MAP_BOTTOM, range.y1, theme.land);

    // 복사본(경도 한 바퀴씩): 그릴 범위에 걸치는 것만(기울이면 먼 쪽이 넓어 여러 바퀴)
    const copiesIn = (x0: number, x1: number) => {
      const out: number[] = [];
      const k0 = Math.floor((x0 - view.shift) / this.mapWidth);
      const k1 = Math.floor((x1 - view.shift) / this.mapWidth);
      for (let k = Math.max(k0, -12); k <= Math.min(k1, 12); k++)
        out.push(view.shift + k * this.mapWidth);
      return out;
    };
    const offs = copiesIn(range.x0, range.x1);
    const lines = (
      l: Lines | null,
      width: number,
      c: number[],
      off: number,
    ) => {
      if (!l || !l.count) return;
      common(this.line);
      gl.uniform1f(this.line.u("u_off"), off);
      gl.uniform1f(this.line.u("u_width"), width);
      gl.uniform2f(this.line.u("u_dash"), 0, 0);
      color(this.line, c);
      gl.bindVertexArray(l.vao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, l.count);
    };
    const fill = (
      f: Fill | null,
      c: number[] | null,
      off: number,
      alpha = 1,
    ) => {
      if (!f || !f.count) return;
      common(this.fill);
      gl.uniform1f(this.fill.u("u_off"), off);
      if (c) color(this.fill, c);
      else {
        gl.uniform4f(this.fill.u("u_color"), 0, 0, 0, -1);
        gl.uniform1f(this.fill.u("u_alpha"), alpha);
      }
      gl.bindVertexArray(f.vao);
      gl.drawElements(gl.TRIANGLES, f.count, gl.UNSIGNED_INT, 0);
    };
    for (const off of offs) {
      gl.disable(gl.STENCIL_TEST);
      lines(this.graticule, 0.5, theme.graticule, off);
      // 땅을 칠하며 스텐실에 표시 → 나라 색·국경선은 땅 안쪽만
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
      fill(this.land, theme.land, off);
      gl.stencilFunc(gl.EQUAL, 1, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      fill(
        this.polities,
        null,
        off,
        this.polityStyle.alpha ?? theme.regionOpacity,
      );
      lines(this.polityLines, this.polityStyle.lineWidth, theme.border, off);
      if (this.selected) {
        // 그 위에 한 번 더 칠해 합이 진하기 + 0.3이 되게(1 - (1-a)(1-b) = a + 0.3)
        const a = theme.regionOpacity;
        fill(
          this.selected.fill,
          null,
          off,
          Math.min(1, 0.3 / Math.max(0.01, 1 - a)),
        );
        lines(this.selected.line, 1.6, theme.label, off);
      }
      gl.disable(gl.STENCIL_TEST);
      lines(this.coast, 0.5, theme.border, off);
      if (this.paths && this.paths.count) {
        common(this.line);
        gl.uniform1f(this.line.u("u_off"), off);
        gl.uniform1f(this.line.u("u_width"), this.pathStyle.width);
        gl.uniform2f(
          this.line.u("u_dash"),
          this.pathStyle.dash[0],
          this.pathStyle.dash[1],
        );
        gl.uniform4f(this.line.u("u_color"), 0, 0, 0, -1);
        gl.bindVertexArray(this.paths.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.paths.count);
      }
    }

    // 핀·나라 이름·말풍선(지금 핀·이름 svg와 같은 층 순서). 화면 밖 핀도 끄는 동안 보이게 복사본은 넓게
    const rw = range.x1 - range.x0;
    const overlayOffs = copiesIn(range.x0 - rw * 0.5, range.x1 + rw * 0.5);
    // 물결: 1.6초 ease-out × 3번(globals.css pin-pulse와 같게), 움직임 줄이기면 없음
    const since = (performance.now() - this.pulseFrom) / 1600;
    const pulsing = !this.reduceMotion && this.pulseFrom > 0 && since < 3;
    const e = pulsing ? cubicBezier(0, 0, 0.58, 1, since % 1) : 1;
    const pre = (c: number[]) => [
      c[0] * (c[3] ?? 1),
      c[1] * (c[3] ?? 1),
      c[2] * (c[3] ?? 1),
      c[3] ?? 1,
    ];
    if (this.pins && this.pins.count) {
      common(this.pin);
      // 핀 그림 1단위 = 화면 px: svg 핀(scale(1.2/배율))과 같은 크기 - 판 높이(지도 칸 높이)와 지도 높이로 정해진다
      const unit = (1.2 * fh) / this.mapHeight;
      gl.uniform1f(this.pin.u("u_unit"), unit);
      gl.uniform1f(this.pin.u("u_pulse"), 1 + 2.2 * e);
      gl.uniform1f(this.pin.u("u_pulseAlpha"), pulsing ? 0.8 * (1 - e) : 0);
      const st = pre(theme.pinStroke);
      const rg = pre(theme.pinRing);
      gl.uniform4f(this.pin.u("u_stroke"), st[0], st[1], st[2], st[3]);
      gl.uniform4f(this.pin.u("u_ring"), rg[0], rg[1], rg[2], rg[3]);
      gl.bindVertexArray(this.pins.vao);
      for (const off of overlayOffs) {
        gl.uniform1f(this.pin.u("u_off"), off);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.pins.count);
      }
    }
    if (this.sprites) {
      const sp = this.sprites;
      common(this.sprite);
      gl.uniform1f(this.sprite.u("u_labelScale"), (view.zoom / sp.zoom) ** 0.2);
      gl.uniform1f(this.sprite.u("u_dpr"), dpr);
      gl.uniform1i(
        this.sprite.u("u_snap"),
        view.still && !view.tilt && !(view.heading % 360) ? 1 : 0,
      );
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(this.sprite.u("u_tex"), 0);
      gl.bindVertexArray(sp.vao);
      for (const pg of sp.pages) {
        if (!pg.count) continue;
        gl.bindTexture(gl.TEXTURE_2D, pg.tex);
        gl.uniform2f(this.sprite.u("u_atlas"), pg.size[0], pg.size[1]);
        // 장마다 그릴 범위: 정점 속성을 그 장 첫 그림부터 읽게(instance 시작 위치)
        gl.bindBuffer(gl.ARRAY_BUFFER, sp.buf);
        const at = (name: string, n: number, off: number) => {
          const loc = gl.getAttribLocation(this.sprite.p, name);
          gl.vertexAttribPointer(
            loc,
            n,
            gl.FLOAT,
            false,
            44,
            pg.first * 44 + off,
          );
        };
        at("a_anchor", 2, 0);
        at("a_rect", 4, 8);
        at("a_src", 4, 24);
        at("a_grows", 1, 40);
        for (const off of overlayOffs) {
          gl.uniform1f(this.sprite.u("u_off"), off);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pg.count);
        }
      }
    }
    gl.bindVertexArray(null);
    // 물결이 도는 동안·글자 판을 올리는 동안은 계속 그린다(올리기는 그린 뒤 한 장씩)
    if (this.pendingSprites) this.uploadSpritePage();
    if (pulsing || this.pendingSprites) this.request();
  }
}
