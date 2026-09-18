/** VCL attributes LibreOffice requests one family for. */
export interface FontMatchRequest {
  readonly family: string
  readonly style: string
  readonly weight: number
  readonly italic: number
  readonly width: number
  readonly pitch: number
  readonly language: string
  readonly codePoints: readonly number[]
}
