/**
 * A dotted globe in plain WebGL 1: one quad for the sphere and its halo, and point sprites for everything else
 * (land dots, places, visitors, rings). Two draw calls for the dots, one for the sphere, no textures, no network.
 * The caller owns the animation and passes one frame's points at a time; this file only draws them.
 *
 * Coordinates: a point on the unit sphere has x to the right, y up and z toward the viewer at longitude 0
 * (lib/geo.ts toVector). The view turns the globe by `phi` around y, then tilts it by `theta` around x, so a
 * positive theta brings the north pole toward the viewer. `fill` is the sphere's radius as a share of half the
 * canvas, leaving room for the halo and for rings at the edge.
 */

/** How the fragment shader draws a point: a land dot, a soft place dot, a glowing marker, or a ring on the surface. */
export const Kind = { Land: 0, Place: 1, Glow: 2, Ring: 3 } as const;

/** Floats per point: x, y, z, size (CSS px), r, g, b, a (straight alpha), kind. */
export const STRIDE = 9;

export interface GlobeColors {
  sphereCenter: [number, number, number];
  sphereEdge: [number, number, number];
  rim: [number, number, number];
  halo: [number, number, number];
  haloAlpha: number;
}

const SPHERE_VS = `
attribute vec2 aQuad;
uniform float uFill;
varying vec2 vP;
void main() {
  vP = aQuad / uFill;
  gl_Position = vec4(aQuad, 0.0, 1.0);
}`;

const SPHERE_FS = `
precision mediump float;
varying vec2 vP;
uniform vec3 uCenter;
uniform vec3 uEdge;
uniform vec3 uRim;
uniform vec3 uHalo;
uniform float uHaloA;
uniform float uPx;
uniform float uEdgeR;
void main() {
  float r = length(vP);
  float inside = 1.0 - smoothstep(1.0 - uPx, 1.0 + uPx, r);
  vec3 n = vec3(vP, sqrt(max(0.0, 1.0 - r * r)));
  float light = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0);
  vec3 c = mix(uEdge, uCenter, light) + uRim * pow(1.0 - n.z, 3.0);
  float out1 = max(r - 1.0, 0.0);
  float halo = uHaloA * (exp(-out1 * 14.0) * 0.75 + exp(-out1 * 4.0) * 0.25) * (1.0 - inside) * (1.0 - smoothstep(uEdgeR - 0.14, uEdgeR, r));
  gl_FragColor = vec4(c * inside + uHalo * halo, inside + halo);
}`;

const POINT_VS = `
attribute vec3 aPos;
attribute float aSize;
attribute vec4 aColor;
attribute float aKind;
uniform mat3 uRot;
uniform float uFill;
uniform float uDpr;
uniform vec2 uAspect;
varying vec4 vColor;
varying float vKind;
varying vec3 vN;
varying float vSize;
void main() {
  vec3 p = uRot * aPos;
  if (p.z < 0.0 && length(p.xy) < 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vN = normalize(p);
  vKind = aKind;
  float a = aColor.a;
  if (aKind < 0.5) {
    // Land: fade toward the edge of the disc, and shade with the same light as the sphere.
    a *= smoothstep(0.0, 0.32, vN.z) * (0.55 + 0.45 * clamp(dot(vN, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0));
  } else {
    a *= smoothstep(-0.04, 0.16, p.z);
  }
  vColor = vec4(aColor.rgb * a, a);
  vSize = aSize * uDpr;
  gl_Position = vec4(p.xy * uFill * uAspect, 0.0, 1.0);
  gl_PointSize = vSize;
}`;

const POINT_FS = `
precision mediump float;
varying vec4 vColor;
varying float vKind;
varying vec3 vN;
varying float vSize;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  d.y = -d.y;
  // Dots and rings lie on the surface: squash them along the radius as the surface turns away.
  if (vKind < 1.5 || vKind > 2.5) {
    float rr = length(vN.xy);
    if (rr > 0.001) {
      vec2 u = vN.xy / rr;
      d = vec2(dot(d, u) / max(vN.z, 0.18), dot(d, vec2(-u.y, u.x)));
    }
  }
  float r = length(d) * 2.0;
  float a;
  vec3 extra = vec3(0.0);
  if (vKind < 0.5) {
    a = 1.0 - smoothstep(0.62, 1.0, r);
  } else if (vKind < 1.5) {
    a = 1.0 - smoothstep(0.15, 1.0, r);
    a *= a;
  } else if (vKind < 2.5) {
    float core = 1.0 - smoothstep(0.17, 0.25, r);
    a = max(core, exp(-r * r * 9.0) * 0.6);
    extra = vec3(core * 0.2) * vColor.a;
  } else {
    float w = clamp(3.0 / max(vSize, 1.0), 0.02, 0.5);
    a = 1.0 - smoothstep(w * 0.35, w, abs(r - (1.0 - w)));
  }
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor.rgb * a + extra * a, vColor.a * a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
  return s;
}

function program(gl: WebGLRenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  return p;
}

/** Turn then tilt, as a column-major mat3 for the shader. */
export function rotation(phi: number, theta: number): Float32Array {
  const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
  // Rows of Rx(theta) * Ry(phi).
  const m = [
    [cp, 0, sp],
    [st * sp, ct, -st * cp],
    [-ct * sp, st, ct * cp],
  ];
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]]);
}

/** Where a unit-sphere point lands after the view's turn and tilt. */
export function rotate(v: readonly number[], phi: number, theta: number): [number, number, number] {
  const cp = Math.cos(phi), sp = Math.sin(phi), ct = Math.cos(theta), st = Math.sin(theta);
  const x = cp * v[0] + sp * v[2];
  const z1 = -sp * v[0] + cp * v[2];
  return [x, ct * v[1] - st * z1, st * v[1] + ct * z1];
}

export class GlobeGL {
  private gl: WebGLRenderingContext;
  private sphere: WebGLProgram;
  private points: WebGLProgram;
  private quad: WebGLBuffer;
  private landBuf: WebGLBuffer;
  private dynBuf: WebGLBuffer;
  private landCount = 0;
  private dynCapacity = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private a: Record<string, number> = {};
  readonly maxPointSize: number;
  width = 1;
  height = 1;
  dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {
    // preserveDrawingBuffer: a still globe (reduced motion, or paused off screen) draws one frame and stops; without
    // it the browser may drop that frame when it recomposites the page, leaving an empty canvas.
    const gl = canvas.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    this.sphere = program(gl, SPHERE_VS, SPHERE_FS);
    this.points = program(gl, POINT_VS, POINT_FS);
    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    this.landBuf = gl.createBuffer()!;
    this.dynBuf = gl.createBuffer()!;
    for (const n of ['uFill', 'uCenter', 'uEdge', 'uRim', 'uHalo', 'uHaloA', 'uPx', 'uEdgeR']) this.u['s' + n] = gl.getUniformLocation(this.sphere, n);
    for (const n of ['uRot', 'uFill', 'uDpr', 'uAspect']) this.u['p' + n] = gl.getUniformLocation(this.points, n);
    this.a.quad = gl.getAttribLocation(this.sphere, 'aQuad');
    for (const n of ['aPos', 'aSize', 'aColor', 'aKind']) this.a[n] = gl.getAttribLocation(this.points, n);
    this.maxPointSize = (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array)[1] ?? 64;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  get lost() {
    return this.gl.isContextLost();
  }

  resize(cssW: number, cssH: number, dpr: number) {
    this.dpr = Math.min(2, Math.max(1, dpr));
    this.width = Math.max(1, cssW);
    this.height = Math.max(1, cssH);
    const w = Math.round(this.width * this.dpr);
    const h = Math.round(this.height * this.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /** The static land dots, already packed (STRIDE floats each). */
  setLand(data: Float32Array) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.landBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.landCount = data.length / STRIDE;
  }

  private bindPoints(buf: WebGLBuffer) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const s = STRIDE * 4;
    const attr = (loc: number, size: number, offset: number) => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, s, offset * 4);
    };
    attr(this.a.aPos, 3, 0);
    attr(this.a.aSize, 1, 3);
    attr(this.a.aColor, 4, 4);
    attr(this.a.aKind, 1, 8);
  }

  draw(phi: number, theta: number, fill: number, colors: GlobeColors, dyn: Float32Array, dynCount: number) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // The globe is round in CSS pixels whatever the canvas shape: scale the short side to fit.
    const side = Math.min(this.width, this.height);
    const ax = side / this.width;
    const ay = side / this.height;

    gl.useProgram(this.sphere);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(this.a.quad);
    gl.vertexAttribPointer(this.a.quad, 2, gl.FLOAT, false, 0, 0);
    // The quad covers the canvas; dividing by fill and the aspect gives sphere units in the shader.
    gl.uniform1f(this.u.suFill, fill);
    gl.uniform3fv(this.u.suCenter, colors.sphereCenter);
    gl.uniform3fv(this.u.suEdge, colors.sphereEdge);
    gl.uniform3fv(this.u.suRim, colors.rim);
    gl.uniform3fv(this.u.suHalo, colors.halo);
    gl.uniform1f(this.u.suHaloA, colors.haloAlpha);
    // The halo fades out before the edge of the quad, so no straight edge shows.
    gl.uniform1f(this.u.suEdgeR, Math.min(1.24, 1 / fill - 0.01));
    gl.uniform1f(this.u.suPx, 1.2 / (fill * side * this.dpr * 0.5));
    if (ax !== 1 || ay !== 1) {
      // Non-square canvas: draw the sphere quad in a square viewport centred on the canvas.
      const s = Math.round(side * this.dpr);
      gl.viewport(Math.round((this.canvas.width - s) / 2), Math.round((this.canvas.height - s) / 2), s, s);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.disableVertexAttribArray(this.a.quad);

    gl.useProgram(this.points);
    gl.uniformMatrix3fv(this.u.puRot, false, rotation(phi, theta));
    gl.uniform1f(this.u.puFill, fill);
    gl.uniform1f(this.u.puDpr, this.dpr);
    gl.uniform2f(this.u.puAspect, ax, ay);
    if (this.landCount) {
      this.bindPoints(this.landBuf);
      gl.drawArrays(gl.POINTS, 0, this.landCount);
    }
    if (dynCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dynBuf);
      if (dyn.length > this.dynCapacity) {
        gl.bufferData(gl.ARRAY_BUFFER, dyn.byteLength, gl.DYNAMIC_DRAW);
        this.dynCapacity = dyn.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dyn.subarray(0, dynCount * STRIDE));
      this.bindPoints(this.dynBuf);
      gl.drawArrays(gl.POINTS, 0, dynCount);
    }
  }

  /** Frees the GPU objects and hands the context back, so a remount does not pile up contexts. */
  dispose() {
    const gl = this.gl;
    if (!gl.isContextLost()) {
      gl.deleteBuffer(this.quad);
      gl.deleteBuffer(this.landBuf);
      gl.deleteBuffer(this.dynBuf);
      gl.deleteProgram(this.sphere);
      gl.deleteProgram(this.points);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
