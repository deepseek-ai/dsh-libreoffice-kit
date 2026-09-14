/** Stable render failure categories shared across the Node worker and native helper transports. */

/** Categories a conversion can report across the worker and native helper messages. */
export type ConversionErrorCode = 'input-too-large' | 'output-too-large' | 'invalid-document'
  | 'unsupported-format' | 'invalid-output' | 'timeout' | 'unavailable' | 'failed'

const CODES: ReadonlySet<string> = new Set<ConversionErrorCode>(['input-too-large', 'output-too-large', 'invalid-document',
  'unsupported-format', 'invalid-output', 'timeout', 'unavailable', 'failed'])

/** An actionable converter failure; operating-system errors and caller abort reasons remain unchanged. */
export class ConversionError extends Error {
  /** Published failure category carried across worker and helper transports. */
  readonly code: ConversionErrorCode

  /**
   * @param code - Published failure category.
   * @param message - Consumer-facing failure description.
   * @param options - Standard error options; a cause is preserved for diagnostics.
   */
  constructor(code: ConversionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ConversionError'
    this.code = code
  }
}

/**
 * Only published categories cross worker/helper messages; unknown errors use the generic failure category.
 * @param error - The thrown value, which may be any type and may carry an unpublished `code`.
 * @returns The published category, or `failed` when no published category is present.
 */
export function failureCode(error: unknown): ConversionErrorCode {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && CODES.has(code) ? code as ConversionErrorCode : 'failed'
}
