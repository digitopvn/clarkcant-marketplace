import { ORB_FRAGMENT_SHADER, ORB_PALETTE, ORB_SHAPE, ORB_VERTEX_SHADER, type Rgb } from "./orb-shader";

/*
 * Draws the Orb on a `<canvas data-orb>` with WebGL, the same renderer as clarkcant.cc (same spring, same pointer
 * mapping). It animates only while the canvas is on screen; with reduced motion it draws one still frame and never
 * loops. Without WebGL the wrapper gets `orb--fallback` and CSS paints a static Orb instead.
 */

const UNIFORMS = [
  "u_resolution", "u_time", "u_radius", "u_exposure", "u_chromatic", "u_glow", "u_sheen", "u_pointer",
  "u_pointerStrength", "u_wobble", "u_canvas", "u_glowColor", "u_highlight", "u_shellMid", "u_shellEdge",
  "u_sheenColor", "u_colorA", "u_colorB", "u_colorC", "u_colorD",
] as const;

const PHYSICS = { stiffness: 90, damping: 7.5 };
const SPEED = 1.23;
const MAX_PIXEL_RATIO = 2;

interface PointerSample {
  x: number;
  y: number;
  strength: number;
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("orb shader could not be created");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    throw new Error("orb shader did not compile");
  }
  return shader;
}

/** Page pointer → the shader's space (y up, x scaled by aspect), plus a proximity strength. */
function pointerFromClient(rect: DOMRect, clientX: number, clientY: number): PointerSample {
  const width = Math.max(rect.width, 1);
  const height = Math.max(rect.height, 1);
  const u = (clientX - rect.left) / width;
  const v = 1 - (clientY - rect.top) / height;
  const distance = Math.hypot(clientX - rect.left - width / 2, clientY - rect.top - height / 2);
  const radius = (Math.min(width, height) / 2) * ORB_SHAPE.radius;
  const strength = Math.max(0, Math.min(1, (radius * 2.4 - distance) / (radius * 1.6)));
  return { x: (u - 0.5) * 2 * (width / height), y: (v - 0.5) * 2, strength };
}

function createRenderer(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  let program: WebGLProgram;
  try {
    const vs = compile(gl, gl.VERTEX_SHADER, ORB_VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, ORB_FRAGMENT_SHADER);
    const linked = gl.createProgram();
    gl.attachShader(linked, vs);
    gl.attachShader(linked, fs);
    gl.linkProgram(linked);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(linked, gl.LINK_STATUS)) return null;
    program = linked;
  } catch {
    return null;
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  const loc = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >;

  const pointer = { x: 0, y: 0, target: 0, strength: 0 };
  let level = 0;
  let wobble = 0;
  let wobbleVelocity = 0;
  let lastX = 0;
  let lastY = 0;
  let lastMs: number | undefined;
  let lost = false;

  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    lost = true;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    lost = false;
  });

  const vec3 = (name: (typeof UNIFORMS)[number], value: Rgb) => gl.uniform3f(loc[name], value[0], value[1], value[2]);

  const frame = (timeMs: number) => {
    if (lost) return;
    const dt = lastMs === undefined ? 0 : Math.min(Math.max((timeMs - lastMs) / 1000, 0), 0.1);
    lastMs = timeMs;

    const ease = dt === 0 ? 1 : 1 - Math.exp(-dt / 0.1);
    pointer.strength += (pointer.target - pointer.strength) * ease;
    const travelled = Math.hypot(pointer.x - lastX, pointer.y - lastY);
    lastX = pointer.x;
    lastY = pointer.y;
    const travelSpeed = dt > 0 ? travelled / dt : 0;

    // Underdamped spring: overshoot and ring is what makes the shell read as jelly.
    const push = Math.min(0.6, travelSpeed * 0.1) * pointer.target + level * 0.55;
    wobbleVelocity += ((push - wobble) * PHYSICS.stiffness - wobbleVelocity * PHYSICS.damping) * dt;
    wobble += wobbleVelocity * dt;
    if (wobble > 1 || wobble < -1) {
      wobble = Math.sign(wobble);
      wobbleVelocity = 0;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    gl.uniform2f(loc.u_resolution, canvas.width, canvas.height);
    gl.uniform1f(loc.u_time, (timeMs / 1000) * SPEED);
    gl.uniform1f(loc.u_radius, ORB_SHAPE.radius);
    gl.uniform1f(loc.u_exposure, ORB_SHAPE.exposure + level * 1.4);
    gl.uniform1f(loc.u_chromatic, ORB_SHAPE.chromatic);
    gl.uniform1f(loc.u_glow, ORB_SHAPE.glow + level * 0.25);
    gl.uniform1f(loc.u_sheen, ORB_SHAPE.sheen);
    gl.uniform2f(loc.u_pointer, pointer.x, pointer.y);
    gl.uniform1f(loc.u_pointerStrength, pointer.strength);
    gl.uniform1f(loc.u_wobble, wobble);
    for (const [key, value] of Object.entries(ORB_PALETTE)) vec3(`u_${key}` as (typeof UNIFORMS)[number], value);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  return {
    frame,
    /** True while the shell is still ringing: worth another frame. */
    isSettling: () => Math.abs(wobble) > 0.002 || Math.abs(wobbleVelocity) > 0.002 || level > 0.002,
    setPointer(sample: PointerSample) {
      pointer.x = sample.x;
      pointer.y = sample.y;
      pointer.target = Math.max(0, Math.min(1, sample.strength));
    },
    setLevel(value: number) {
      level = Math.max(0, Math.min(1, value));
    },
    resize() {
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
      const w = Math.max(1, Math.round(rect.width * ratio));
      const h = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    },
  };
}

export function mountOrb(canvas: HTMLCanvasElement): void {
  const shell = canvas.closest<HTMLElement>(".orb") ?? canvas.parentElement;
  const orb = createRenderer(canvas);
  if (!orb) {
    shell?.classList.add("orb--fallback");
    return;
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let visible = false;
  let running = false;

  const loop = (now: number) => {
    if (!visible) {
      running = false;
      return;
    }
    orb.frame(now);
    if (!reducedMotion.matches || orb.isSettling()) requestAnimationFrame(loop);
    else running = false;
  };

  const kick = () => {
    if (running || !visible) return;
    running = true;
    requestAnimationFrame(loop);
  };

  const redraw = () => {
    if (!reducedMotion.matches) kick();
    else requestAnimationFrame((now) => orb.frame(now));
  };

  new ResizeObserver(() => {
    orb.resize();
    redraw();
  }).observe(canvas);

  new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (visible) {
        orb.resize();
        redraw();
      }
    },
    { rootMargin: "80px" },
  ).observe(canvas);

  reducedMotion.addEventListener("change", redraw);

  // Light arriving from nearby is the effect, so the pointer is tracked across the page, not only over the canvas.
  let pending: PointerEvent | null = null;
  window.addEventListener(
    "pointermove",
    (event) => {
      if (!visible || reducedMotion.matches || event.pointerType === "touch") return;
      pending = event;
      requestAnimationFrame(() => {
        if (!pending) return;
        orb.setPointer(pointerFromClient(canvas.getBoundingClientRect(), pending.clientX, pending.clientY));
        pending = null;
      });
    },
    { passive: true },
  );
  document.documentElement.addEventListener("pointerleave", () => orb.setPointer({ x: 0, y: 0, strength: 0 }));

  // A tap gives the shell a single poke, so touch screens get the jelly too.
  canvas.addEventListener("pointerdown", (event) => {
    if (reducedMotion.matches) return;
    orb.setPointer(pointerFromClient(canvas.getBoundingClientRect(), event.clientX, event.clientY));
    orb.setLevel(0.7);
    kick();
    setTimeout(() => orb.setLevel(0), 140);
    if (event.pointerType === "touch") setTimeout(() => orb.setPointer({ x: 0, y: 0, strength: 0 }), 600);
  });
}
