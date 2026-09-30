/**
 * The Orb's shader, the same one the ClarkCant app and clarkcant.cc draw, so the identity is one thing and not two.
 * GLSL ES 1.00 so it runs wherever WebGL1 does.
 */

export const ORB_VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

export const ORB_FRAGMENT_SHADER = `
precision highp float;

uniform vec2  u_resolution;
uniform float u_time;
uniform float u_radius;
uniform float u_exposure;
uniform float u_chromatic;
uniform float u_glow;
uniform float u_sheen;
uniform vec2  u_pointer;
uniform float u_pointerStrength;
uniform float u_wobble;

uniform vec3  u_canvas;
uniform vec3  u_glowColor;
uniform vec3  u_highlight;
uniform vec3  u_shellMid;
uniform vec3  u_shellEdge;
uniform vec3  u_sheenColor;
uniform vec3  u_colorA;
uniform vec3  u_colorB;
uniform vec3  u_colorC;
uniform vec3  u_colorD;

varying vec2 v_uv;

vec3 spectrum(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c = mix(u_colorB, u_highlight, smoothstep(0.00, 0.28, t));
  c = mix(c, u_colorA, smoothstep(0.28, 0.52, t));
  c = mix(c, u_colorC, smoothstep(0.52, 0.76, t));
  return mix(c, u_colorD, smoothstep(0.76, 1.00, t));
}

void main() {
  float aspect = u_resolution.x / max(u_resolution.y, 1.0);
  vec2 raw = (v_uv - 0.5) * vec2(aspect, 1.0) * 2.0;
  float R = u_radius;

  // Squash along the push, bulge across it: jelly rather than a dent.
  vec2 direction = length(u_pointer) > 0.0001 ? normalize(u_pointer) : vec2(1.0, 0.0);
  float squash = clamp(u_wobble, -1.0, 1.0) * max(u_pointerStrength, 0.35);
  float along = dot(raw, direction);
  vec2 sideways = raw - direction * along;
  vec2 p = direction * (along * (1.0 - 0.20 * squash)) + sideways * (1.0 + 0.14 * squash);
  float r = length(p);

  float pointerDist = length(raw - u_pointer);
  float touch = exp(-pointerDist * 2.4);
  float pointerLight = u_pointerStrength * (0.55 + 0.45 * abs(u_wobble));

  float ripple = sin(pointerDist * 13.0 - u_time * 5.0) * 0.022 * abs(u_wobble) * exp(-pointerDist * 2.0);
  float R_local = R + ripple;

  float edge = 0.006;
  float inside = 1.0 - smoothstep(R_local - edge, R_local + edge, r);
  float outside = 1.0 - inside;

  // The lens-shaped spectral band across the equator.
  float nx = p.x / R;
  float lens = sqrt(max(0.0, 1.0 - nx * nx));
  float sway = pow(lens, 1.30);
  float drift = sin(nx * 3.2 + u_time * 1.15) * 0.045 * sway
              + sin(nx * 6.1 - u_time * 0.70) * 0.016 * sway;
  float pull = clamp(u_pointer.y - p.y, -0.16, 0.16) * 0.9 * touch * u_pointerStrength;
  float y = p.y - drift - pull;

  float haloH = 0.270 * pow(lens, 1.40);
  float coreH = 0.056 * pow(lens, 1.90);
  float gate = step(abs(nx), 1.0) * smoothstep(0.30, 0.78, lens);
  float halo = exp(-pow(y / max(haloH, 1e-4), 2.0)) * gate;
  float core = exp(-pow(y / max(coreH, 1e-4), 2.0)) * gate;

  float t = nx * 0.5 + 0.5;
  float disp = 0.055 * u_chromatic;
  vec3 band = vec3(spectrum(t + disp).r, spectrum(t).g, spectrum(t - disp).b);

  vec3 body = u_canvas + u_shellEdge * (0.020 + 0.090 * lens);
  vec3 emissive = band * halo * 0.42 + band * core * 0.32 + u_highlight * pow(core, 2.6) * 0.55;

  float rim = smoothstep(R_local * 0.88, R_local, r) * inside;
  vec3 rimTint = mix(u_shellMid, u_shellEdge, 0.35) * rim * (0.14 + 0.55 * touch * u_pointerStrength);

  float sheen = pow(max(0.0, 1.0 - length(p - vec2(-R * 0.42, R * 0.52)) / (R * 0.95)), 3.0);
  vec3 sheenTint = u_sheenColor * sheen * inside * u_sheen * 0.30;

  vec3 glass = body + emissive * inside * (u_exposure * 0.5) + rimTint + sheenTint;

  float pointerReach = clamp(length(u_pointer) / max(R, 0.0001), 0.0, 1.4);
  float reachFalloff = 1.0 - smoothstep(0.60, 0.97, pointerReach);
  vec3 flare = (u_highlight * 0.30 + u_glowColor * 0.45)
             * pow(touch, mix(1.5, 4.5, 1.0 - reachFalloff)) * pointerLight * reachFalloff;
  glass += flare;

  // Premultiplied output so the Orb composites over any surface, light or dark.
  float glowMask = exp(-max(0.0, r - R) * 16.0) * outside;
  vec3 col = mix(u_glowColor * u_glow * 1.1 + flare, glass, inside);
  float flareAlpha = clamp(dot(flare, vec3(0.3333)) * 1.8, 0.0, 0.85) * outside;
  float alpha = clamp(inside + glowMask * 0.9 * min(u_glow * 3.4, 1.0) + flareAlpha, 0.0, 1.0);

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

export type Rgb = readonly [number, number, number];

/** The product's signature palette (Clark preset). */
export const ORB_PALETTE = {
  canvas: [0.012, 0.016, 0.035],
  glowColor: [0.584, 0.424, 1.0],
  highlight: [1.0, 1.0, 1.0],
  shellMid: [0.608, 0.957, 1.0],
  shellEdge: [0.773, 0.663, 1.0],
  sheenColor: [0.918, 0.957, 1.0],
  colorA: [1.0, 0.847, 0.42],
  colorB: [0.51, 0.957, 1.0],
  colorC: [1.0, 0.482, 1.0],
  colorD: [0.557, 0.424, 1.0],
} satisfies Record<string, Rgb>;

/** The shipped shape. */
export const ORB_SHAPE = { radius: 0.72, exposure: 2.0, chromatic: 0.42, glow: 0.3, sheen: 0.28 };
