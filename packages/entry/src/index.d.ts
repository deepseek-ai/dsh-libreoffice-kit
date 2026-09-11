/** Host limits used by both native and Node WASM conversions. All byte limits are positive safe integers. */
export interface ConverterOptions {
  /** Deadline after a queued conversion starts, including font work and output. Default: 120000 ms. */
  timeoutMs?: number;
  /** Maximum source bytes. Default: 64 MiB. */
  maxInputBytes?: number;
  /** Maximum generated PDF bytes. Default: 128 MiB. */
  maxOutputBytes?: number;
  /** PDF export image resolution in DPI. Default: 144. */
  maxImageResolution?: number;
  /** Maximum ZIP entries. Default: 20000. */
  maxArchiveEntries?: number;
  /** Maximum declared uncompressed archive bytes. Default: 512 MiB. */
  maxUncompressedBytes?: number;
  /** Font roots; defaults to conventional platform and user directories. */
  fontDirectories?: string[];
  /** Ordered font substitutions; exact installed family matches take priority. */
  fontFallbacks?: string[][];
  /** Families imported before loading a document. Defaults to none. */
  initialFontFamilies?: string[];
  /** Maximum visited physical font files. Default: 20000. */
  maxFontFiles?: number;
  /** Files exceeding this limit are omitted. Default: 256 MiB. */
  maxFontFileBytes?: number;
  /** Complete original font bytes imported per conversion. Default: 512 MiB. Native platform fonts remain OS-managed. */
  maxLoadedFontBytes?: number;
  /** Optional Node WebGPU image scaling; unavailable adapters use the existing CPU filter. Default: auto. */
  gpu?: 'auto' | 'off';
  /** Maximum CPU/GPU staging bytes for one image operation. Default: 256 MiB. */
  maxGpuBytes?: number;
  /** Deadline for one GPU operation; timeout resumes the CPU filter. Default: 5000 ms. */
  gpuTimeoutMs?: number;
  /** Deadline for adapter initialization. Default: 10000 ms. */
  gpuInitializationTimeoutMs?: number;
}

/** Conversion diagnostics; native engines do not use the WASM image callback counters. */
export interface ImageScaling {
  backend: 'native' | 'cpu' | 'webgpu';
  reason?: string;
  adapter?: unknown;
  attempted: number;
  accelerated: number;
  declined: number;
  failed: number;
}

/** A converter serializes document operations; cancellation and disposal await process/worker exit. */
export interface Converter {
  readonly backend: 'native' | 'wasm';
  /**
   * Convert a private, caller-authorized regular OOXML file to a fresh exclusive PDF path.
   * The caller owns both directories and must prevent concurrent path changes.
   * Rejects existing output paths; removes a newly created output on failure or cancellation.
   * @param request Absolute input and output paths. Input extension is docx, xlsx, or pptx.
   * @param signal Optional cancellation, including while queued.
   * @returns Engine choice, missing declared font families, and image scaling counters.
   */
  render(request: { inputPath: string; outputPath: string }, signal?: AbortSignal): Promise<{
    backend: 'native' | 'wasm'; missingFonts: string[]; imageScaling: ImageScaling;
  }>;
  /** Abort queued and active work, await exit and cleanup, and permanently reject further renders. */
  dispose(): Promise<void>;
}

/**
 * Resolve validated defaults and the installed platform engine, or required WASM assets when absent.
 * Installed but corrupt, incompatible, or unusable native packages reject; they never select fallback.
 * @param options Optional host limits and font/GPU settings.
 * @returns A serial converter that must be disposed after use.
 */
export function createConverter(options?: ConverterOptions): Promise<Converter>;
