/**
 * Declarations for the fontkit surfaces the font catalog reads. fontkit 2.0.4
 * publishes no type declarations, and only these members are used here: a face
 * parsed through {@link create} plus the name, metric, and coverage tables the
 * catalog inspects.
 */
declare module 'fontkit' {
  /** One physical face's `OS/2` weight and width classes. */
  interface OS2Table {
    readonly usWeightClass: number
    readonly usWidthClass: number
    readonly sFamilyClass: number
    readonly panose: readonly number[]
  }

  /** One physical face's `post` table. */
  interface PostTable {
    readonly isFixedPitch: number
  }

  /** One physical font face. */
  interface Font {
    readonly characterSet: number[]
    /** Pinned fontkit parser's sfnt stream, used to extract Apple dfont resources. */
    readonly stream: { readonly buffer: Uint8Array }
    readonly familyName: string
    readonly fullName: string | null
    readonly postscriptName: string | null
    readonly subfamilyName: string
    readonly italicAngle: number
    readonly 'OS/2': OS2Table | undefined
    readonly post: PostTable | undefined
    readonly name?: { readonly records: Record<string, Record<string, unknown>> }
    /**
     * @param codePoint - Unicode scalar to look up.
     * @returns whether the face renders the scalar.
     */
    hasGlyphForCodePoint(codePoint: number): boolean
  }

  /** A face collection (`.ttc`/`.otc`) and the faces it contains. */
  interface FontCollection {
    readonly type: 'TTC' | 'DFont'
    readonly fonts: Font[]
  }

  /**
   * @param buffer - Complete original font bytes.
   * @returns the parsed face, or a collection when the bytes hold several.
   */
  export function create(buffer: Uint8Array): Font | FontCollection
}
