/** Separable Lanczos3 with RGBA8 quantization between passes, matching the browser kernel. */
export const shader = /* wgsl */ `
struct Parameters {
  sizes: vec4<u32>,
  axis: u32,
}
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(2) var<uniform> parameters: Parameters;

fn sinc(x: f32) -> f32 {
  if (abs(x) < 0.00001) { return 1.0; }
  let angle = 3.14159265359 * x;
  return sin(angle) / angle;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let sourceSize = parameters.sizes.xy;
  let targetSize = parameters.sizes.zw;
  let dest = invocation.xy;
  if (any(dest >= targetSize)) { return; }
  let axis = parameters.axis;
  let ratio = f32(sourceSize[axis]) / f32(targetSize[axis]);
  let center = (f32(dest[axis]) + 0.5) * ratio - 0.5;
  let stretch = max(ratio, 1.0);
  let radius = 3.0 * stretch;
  let first = i32(ceil(center - radius));
  let last = i32(floor(center + radius));
  var total = vec4<f32>(0.0);
  var weight = 0.0;
  for (var i = first; i <= last; i++) {
    let x = (f32(i) - center) / stretch;
    let w = sinc(x) * sinc(x / 3.0);
    var coord = dest;
    coord[axis] = u32(clamp(i, 0, i32(sourceSize[axis]) - 1));
    total += unpack4x8unorm(source[coord.y * sourceSize.x + coord.x]) * w;
    weight += w;
  }
  outputPixels[dest.y * targetSize.x + dest.x] = pack4x8unorm(clamp(total / weight, vec4<f32>(0.0), vec4<f32>(1.0)));
}
`;
