// Full-screen colour field: soft blobs of colour that drift and blend, brighten and swirl faster while the
// voice speaks, with a thin ribbon drawing the live waveform. WebGL2; without it the CSS background stays.

const VERT = `#version 300 es
in vec2 a; void main() { gl_Position = vec4(a, 0., 1.); }`;

const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime, uFlow, uLevel, uPulse, uCharge, uMotion;
uniform sampler2D uWave;
out vec4 outColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0., a = .5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.02 + vec2(3.1, 7.7); a *= .5; }
  return v;
}

const vec3 PAL[5] = vec3[5](
  vec3(.43, .30, 1.00),   // violet
  vec3(1.00, .30, .62),   // pink
  vec3(1.00, .58, .22),   // tangerine
  vec3(.16, .78, .95),    // cyan
  vec3(.10, .12, .45)     // deep blue, the resting colour
);

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  float t = uFlow;

  // warp the plane, then blend the palette by inverse distance to moving colour centres: a mesh gradient
  vec2 warp = vec2(fbm(p * 1.3 + t * .35), fbm(p * 1.3 - t * .3 + 4.2)) - .5;
  vec2 r = p + warp * (.9 + .5 * uLevel);
  vec3 col = vec3(0.);
  float wsum = 0.;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = vec2(sin(t * (.21 + .05 * fi) + fi * 1.9), cos(t * (.17 + .04 * fi) + fi * 2.6)) * vec2(.85, .5);
    if (i == 4) c = vec2(0., -.55);
    float d = length(r - c);
    float wgt = 1. / (d * d * (i == 4 ? 1.4 : 2.4) + .05);
    col += PAL[i] * wgt;
    wsum += wgt;
  }
  col /= wsum;

  // a soft band of extra colour sweeps sideways on each word
  float hueBand = exp(-pow(p.x - (uPulse * 2.4 - 1.4), 2.) * 3.) * uPulse;
  col += hueBand * vec3(.25, .12, .3);

  float glow = .42 + uCharge * .1 + uLevel * .45;
  col *= glow;

  // the ribbon: the waveform, tinted by the colour under it
  float ends = smoothstep(.0, .22, uv.x) * smoothstep(1., .78, uv.x);
  float w = texture(uWave, vec2(uv.x, .5)).r * 2. - 1.;
  float y0 = -.2 + w * .1 * (.35 + .65 * ends) + (fbm(vec2(uv.x * 6., uTime * .4 * uMotion)) - .5) * .015;
  float d = abs(p.y - y0);
  vec3 tint = normalize(col + .05) * 1.4;
  col += ends * (.25 + uCharge * .2 + uLevel * 1.4) * (.0018 / (d + .0018)) * mix(vec3(1.), tint, .35);
  col += ends * (.08 + uLevel * .6) * (.03 / (d + .03)) * tint * .5;

  col *= 1. - .35 * dot(p * vec2(.6, 1.), p * vec2(.6, 1.));
  col = 1. - exp(-col * 1.6);
  col += (hash(gl_FragCoord.xy + fract(uTime) * 91.) - .5) * .02;
  outColor = vec4(col, 1.);
}`;

export function createAura(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
  if (!gl) return null;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U = {};
  for (const n of ["uRes", "uTime", "uFlow", "uLevel", "uPulse", "uCharge", "uMotion", "uWave"])
    U[n] = gl.getUniformLocation(prog, n);

  const N = 512;
  const wave = new Uint8Array(N).fill(128);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, 1, 0, gl.RED, gl.UNSIGNED_BYTE, wave);
  gl.uniform1i(U.uWave, 0);

  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const state = { level: 0, pulse: 0, charge: 0, flow: Math.random() * 50 };
  let analyser = null, samples = null;

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }

  function readAudio() {
    if (!analyser) { state.level *= 0.9; wave.fill(128); return; }
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    const target = Math.min(1, Math.sqrt(sum / samples.length) * 5.5);
    state.level += (target - state.level) * (target > state.level ? 0.35 : 0.08);
    // the middle ~12 ms of the buffer, box-smoothed, stretched across the screen: a few slow swells
    const span = 576, from = (samples.length - span) >> 1, R = 6;
    for (let i = 0; i < N; i++) {
      const c = from + Math.floor((i * span) / N);
      let v = 0;
      for (let j = c - R; j <= c + R; j++) v += samples[j];
      wave[i] = Math.round(Math.max(-1, Math.min(1, (v / (2 * R + 1)) * 2.2)) * 127 + 128);
    }
  }

  const t0 = performance.now();
  let last = t0;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();
    readAudio();
    const motion = reduced.matches ? 0.15 : 1;
    state.flow += dt * motion * (0.12 + state.level * 0.9);
    state.pulse = Math.max(0, state.pulse - dt * 1.1);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, 1, gl.RED, gl.UNSIGNED_BYTE, wave);
    gl.uniform2f(U.uRes, canvas.width, canvas.height);
    gl.uniform1f(U.uTime, (now - t0) / 1000);
    gl.uniform1f(U.uFlow, state.flow);
    gl.uniform1f(U.uLevel, state.level);
    gl.uniform1f(U.uPulse, state.pulse);
    gl.uniform1f(U.uCharge, state.charge);
    gl.uniform1f(U.uMotion, motion);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    setAnalyser(node) { analyser = node; samples = node ? new Float32Array(node.fftSize) : null; },
    setCharge(v) { state.charge = v; },
    // a soft sweep of colour across the screen on each spoken word
    pulse() { if (!reduced.matches) state.pulse = 1; },
  };
}
