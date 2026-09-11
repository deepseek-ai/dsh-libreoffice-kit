/** Device-backed compute only; no canvas, DOM globals, or browser process. */
import { shader } from './shader.mjs';

/**
 * Create one reusable pipeline in its owning Node worker.
 * @param {object} binding Dawn's optional webgpu package exports.
 * @returns {Promise<object>} GPU state and asynchronous pixel scaling.
 */
export async function createWebGpuScaler(binding) {
  const gpu = binding.create([]);
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance', forceFallbackAdapter: false });
  if (!adapter) throw new Error('No WebGPU adapter is available.');
  if (adapter.info.isFallbackAdapter) throw new Error('WebGPU selected a software fallback adapter.');
  const device = await adapter.requestDevice();
  const { GPUBufferUsage: usage, GPUMapMode: mapMode } = binding.globals;
  let deviceError;
  device.lost.then(info => { deviceError = new Error(`WebGPU device lost: ${info.message}`); });
  device.addEventListener('uncapturederror', event => { deviceError = event.error; });
  let pipeline;
  try {
    pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: shader }), entryPoint: 'main' },
    });
  } catch (error) {
    device.destroy();
    throw error;
  }
  return {
    // Dawn's native instance must outlive every adapter, device and queued operation.
    gpu,
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter,
    },
    limits: {
      maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      maxBufferSize: device.limits.maxBufferSize,
      maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
    },
    async scale(layout, input, output) {
      if (deviceError) throw deviceError;
      const buffers = [];
      const buffer = (size, flags, mappedAtCreation = false) => {
        const value = device.createBuffer({ size, usage: flags, mappedAtCreation });
        buffers.push(value);
        return value;
      };
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      let failure;
      try {
        const source = buffer(layout.inputBytes, usage.STORAGE, true);
        const intermediate = buffer(layout.intermediateBytes, usage.STORAGE);
        const target = buffer(layout.outputBytes, usage.STORAGE | usage.COPY_SRC);
        const readback = buffer(layout.outputBytes, usage.COPY_DST | usage.MAP_READ);
        new Uint8Array(source.getMappedRange()).set(new Uint8Array(input));
        source.unmap();
        const encoder = device.createCommandEncoder();
        const pass = (from, to, width, height, targetWidth, targetHeight, axis) => {
          const parameters = buffer(32, usage.UNIFORM | usage.COPY_DST);
          device.queue.writeBuffer(parameters, 0, new Uint32Array([width, height, targetWidth, targetHeight, axis, 0, 0, 0]));
          const group = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [from, to, parameters].map((value, binding) => ({ binding, resource: { buffer: value } })),
          });
          const compute = encoder.beginComputePass();
          compute.setPipeline(pipeline);
          compute.setBindGroup(0, group);
          compute.dispatchWorkgroups(Math.ceil(targetWidth / 8), Math.ceil(targetHeight / 8));
          compute.end();
        };
        const { width, height, targetWidth, targetHeight } = layout;
        pass(source, intermediate, width, height, targetWidth, height, 0);
        pass(intermediate, target, targetWidth, height, targetWidth, targetHeight, 1);
        encoder.copyBufferToBuffer(target, 0, readback, 0, layout.outputBytes);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(mapMode.READ);
        if (deviceError) throw deviceError;
        new Uint8Array(output).set(new Uint8Array(readback.getMappedRange()));
        readback.unmap();
      } catch (error) {
        failure = error;
      } finally {
        for (const value of buffers) value.destroy();
        const memoryError = await device.popErrorScope();
        const validationError = await device.popErrorScope();
        failure ??= memoryError ?? validationError;
      }
      if (failure) throw failure;
    },
    dispose() { device.destroy(); },
  };
}
