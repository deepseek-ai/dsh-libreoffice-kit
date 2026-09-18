/** Portable HarfBuzz sfnt subsetting, preserving shaping features and variable axes. */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** Exact upstream subset source and heap-growth recipe, included in generated subset identities. */
export const FONT_SUBSET_VERSION = 'harfbuzzjs-1.6.1-hb-36cb489-growth-v1'

interface HarfBuzz {
  readonly memory: WebAssembly.Memory
  _initialize(): void
  malloc(bytes: number): number
  free(pointer: number): void
  hb_blob_create(pointer: number, bytes: number, mode: number, userData: number, destroy: number): number
  hb_blob_destroy(blob: number): void
  hb_blob_get_data(blob: number, length: number): number
  hb_blob_get_length(blob: number): number
  hb_face_create(blob: number, index: number): number
  hb_face_destroy(face: number): void
  hb_face_reference_blob(face: number): number
  hb_subset_input_create_or_fail(): number
  hb_subset_input_destroy(input: number): void
  hb_subset_input_unicode_set(input: number): number
  hb_subset_input_set(input: number, kind: number): number
  hb_subset_input_set_flags(input: number, flags: number): void
  hb_set_add(set: number, point: number): void
  hb_set_invert(set: number): void
  hb_set_clear(set: number): void
  hb_subset_or_fail(face: number, input: number): number
}
let engine: Promise<HarfBuzz> | undefined

function load(): Promise<HarfBuzz> {
  return engine ??= (async () => {
    const [bytes, manifest] = await Promise.all([
      readFile(new URL('../assets/font-subset.wasm', import.meta.url)),
      readFile(new URL('../assets/font-subset.json', import.meta.url), 'utf8'),
    ])
    const receipt = JSON.parse(manifest) as { schemaVersion?: number; source?: { algorithm?: string }; files?: Record<string, { bytes?: number; sha256?: string }> }
    const entry = receipt.files?.['assets/font-subset.wasm']
    if (receipt.schemaVersion !== 1 || receipt.source?.algorithm !== FONT_SUBSET_VERSION || entry?.bytes !== bytes.byteLength
      || entry.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('The packaged font subset module does not match its receipt.')
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { emscripten_notify_memory_growth: () => {} },
    })
    const hb = instance.exports as unknown as HarfBuzz
    hb._initialize()
    return hb
  })()
}

/**
 * Extract and subset one physical face without renaming it or instancing variable axes.
 * @param original - TTF, OTF, or collection bytes.
 * @param faceIndex - Collection face index; zero for a standalone face.
 * @param points - Unicode scalars, including any required variation selectors.
 * @returns caller-owned sfnt bytes; all layout scripts/features and glyph closure remain enabled.
 */
export async function subsetFont(original: Uint8Array, faceIndex: number, points: readonly number[]): Promise<Uint8Array> {
  const hb = await load()
  let allocation = 0
  let blob = 0
  let face = 0
  let input = 0
  let subset = 0
  let result = 0
  try {
    allocation = hb.malloc(original.byteLength)
    if (!allocation) throw new Error('The font subsetter could not allocate its input.')
    new Uint8Array(hb.memory.buffer).set(original, allocation)
    blob = hb.hb_blob_create(allocation, original.byteLength, 2, 0, 0)
    face = hb.hb_face_create(blob, faceIndex)
    input = hb.hb_subset_input_create_or_fail()
    if (!input) throw new Error('The font subsetter could not create its input.')
    // HarfBuzz set kinds: name IDs, name languages, layout features, layout scripts.
    for (const kind of [4, 5, 6, 7]) {
      const set = hb.hb_subset_input_set(input, kind)
      hb.hb_set_clear(set)
      hb.hb_set_invert(set)
    }
    // Preserve legacy names and .notdef's outline; layout, bidi and composite closure keep their defaults.
    hb.hb_subset_input_set_flags(input, 0x48)
    const unicode = hb.hb_subset_input_unicode_set(input)
    for (const point of points) hb.hb_set_add(unicode, point)
    subset = hb.hb_subset_or_fail(face, input)
    if (!subset) throw new Error('The font subsetter rejected the selected face.')
    result = hb.hb_face_reference_blob(subset)
    const offset = hb.hb_blob_get_data(result, 0)
    const length = hb.hb_blob_get_length(result)
    if (!length) throw new Error('The font subsetter returned no sfnt bytes.')
    // Subsetting can grow Wasm memory, invalidating every previously captured view.
    return new Uint8Array(hb.memory.buffer).slice(offset, offset + length)
  } finally {
    if (result) hb.hb_blob_destroy(result)
    if (subset) hb.hb_face_destroy(subset)
    if (input) hb.hb_subset_input_destroy(input)
    if (face) hb.hb_face_destroy(face)
    if (blob) hb.hb_blob_destroy(blob)
    if (allocation) hb.free(allocation)
  }
}
