/** Offscreen ANGLE WebGL 2/1 filtering, using the kit's prebuilt N-API binding. */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const vertex = version => `${version === 2 ? '#version 300 es\n' : ''}
${version === 2 ? 'in' : 'attribute'} vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }`;
const fragment = (version, taps) => `${version === 2 ? '#version 300 es\n' : ''}
precision highp float;
uniform sampler2D pixels;
uniform vec2 sourceSize;
uniform vec2 targetSize;
uniform int axis;
${version === 2 ? 'out vec4 result;' : ''}
float sinc(float x) {
  if (abs(x) < 0.00001) return 1.0;
  float angle = 3.14159265359 * x;
  return sin(angle) / angle;
}
void main() {
  vec2 dest = floor(gl_FragCoord.xy);
  float ratio = axis == 0 ? sourceSize.x / targetSize.x : sourceSize.y / targetSize.y;
  float center = ((axis == 0 ? dest.x : dest.y) + 0.5) * ratio - 0.5;
  float stretch = max(ratio, 1.0);
  float first = ceil(center - 3.0 * stretch);
  float last = floor(center + 3.0 * stretch);
  vec4 total = vec4(0.0);
  float weight = 0.0;
  for (int tap = 0; tap < ${taps}; tap++) {
    float i = first + float(tap);
    if (i > last) break;
    float x = (i - center) / stretch;
    float w = sinc(x) * sinc(x / 3.0);
    vec2 coord = dest;
    if (axis == 0) coord.x = clamp(i, 0.0, sourceSize.x - 1.0);
    else coord.y = clamp(i, 0.0, sourceSize.y - 1.0);
    total += ${version === 2 ? 'texelFetch(pixels, ivec2(coord), 0)' : 'texture2D(pixels, (coord + 0.5) / sourceSize)'} * w;
    weight += w;
  }
  ${version === 2 ? 'result' : 'gl_FragColor'} = clamp(total / weight, 0.0, 1.0);
}`;

/** Create a hardware context; absent prebuilds and software adapters are unavailable. */
export function createWebGlScaler(version) {
  const root = dirname(require.resolve('@deepseek-ai/libreoffice-kit-wasm/prebuilds.json'));
  const binding = require(join(root, 'assets/graphics', `${process.platform}-${process.arch}`, 'nodejs_gl_binding.node'));
  const gl = binding.createWebGLRenderingContext(1, 1, version + 1, 0, true, undefined, undefined);
  if (!gl) throw new Error(`No WebGL ${version} context is available.`);
  const programs = new Map();
  let buffer, framebuffer;
  try {
    const apiVersion = gl.getParameter(gl.VERSION);
    if (!apiVersion.includes(`OpenGL ES ${version + 1}.`)) throw new Error(`Expected WebGL ${version}; got ${apiVersion}.`);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
    if (/software|swiftshader|llvmpipe|softpipe|basic render/i.test(renderer)) throw new Error(`Software WebGL adapter: ${renderer}`);
    if (gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT).precision < 23) throw new Error('WebGL highp fragment precision is unavailable.');
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const compile = (kind, text) => {
      const shader = gl.createShader(kind);
      gl.shaderSource(shader, text);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = new Error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        throw error;
      }
      return shader;
    };
    const programFor = taps => {
      if (programs.has(taps)) return programs.get(taps);
      // A conversion can contain many image sizes; retain only the current pair of programs.
      if (programs.size === 2) { for (const program of programs.values()) gl.deleteProgram(program); programs.clear(); }
      const shaders = [];
      let program;
      try {
        shaders.push(compile(gl.VERTEX_SHADER, vertex(version)));
        shaders.push(compile(gl.FRAGMENT_SHADER, fragment(version, taps)));
        program = gl.createProgram();
        for (const shader of shaders) gl.attachShader(program, shader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        programs.set(taps, program);
        return program;
      } catch (error) { if (program) gl.deleteProgram(program); throw error; }
      finally { for (const shader of shaders) gl.deleteShader(shader); }
    };
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const program of programs.values()) gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteFramebuffer(framebuffer);
      gl.destroy();
    };
    return {
      adapter: { device: renderer, description: apiVersion, isFallbackAdapter: false },
      limits: { maxTextureSize },
      scale(layout, input, output) {
        if (disposed) throw new Error('WebGL scaler is disposed.');
        const textures = [];
        const texture = (width, height, data) => {
          const texture = gl.createTexture();
          textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, version === 2 ? gl.RGBA8 : gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
          return texture;
        };
        try {
          const { width, height, targetWidth, targetHeight } = layout;
          const source = texture(width, height, new Uint8Array(input));
          const intermediate = texture(targetWidth, height, null);
          const target = texture(targetWidth, targetHeight, null);
          const pass = (from, to, width, height, targetWidth, targetHeight, axis) => {
            const taps = Math.ceil(6 * (axis === 0 ? width / targetWidth : height / targetHeight)) + 2;
            const program = programFor(taps);
            gl.useProgram(program);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            const position = gl.getAttribLocation(program, 'position');
            gl.enableVertexAttribArray(position);
            gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
            gl.uniform2f(gl.getUniformLocation(program, 'sourceSize'), width, height);
            gl.uniform2f(gl.getUniformLocation(program, 'targetSize'), targetWidth, targetHeight);
            gl.uniform1i(gl.getUniformLocation(program, 'axis'), axis);
            gl.uniform1i(gl.getUniformLocation(program, 'pixels'), 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, from);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, to, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL framebuffer is incomplete.');
            gl.viewport(0, 0, targetWidth, targetHeight);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
          };
          pass(source, intermediate, width, height, targetWidth, height, 0);
          pass(intermediate, target, targetWidth, height, targetWidth, targetHeight, 1);
          gl.readPixels(0, 0, targetWidth, targetHeight, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(output));
          const error = gl.getError();
          if (error !== gl.NO_ERROR) throw new Error(`WebGL operation failed: ${error}.`);
        } finally { for (const texture of textures) gl.deleteTexture(texture); }
      },
      dispose,
    };
  } catch (error) {
    for (const program of programs.values()) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (framebuffer) gl.deleteFramebuffer(framebuffer);
    gl.destroy();
    throw error;
  }
}
