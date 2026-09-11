/** Stable render failure categories shared across the Node worker and native helper transports. */
const CODES = new Set(['input-too-large', 'output-too-large', 'invalid-document', 'unsupported-format', 'invalid-output', 'timeout', 'unavailable', 'failed']);

/** An actionable converter failure; operating-system errors and caller abort reasons remain unchanged. */
export class ConversionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ConversionError';
    this.code = code;
  }
}

/** Only published categories cross worker/helper messages; unknown errors use the generic failure category. */
export function failureCode(error) {
  return CODES.has(error?.code) ? error.code : 'failed';
}
