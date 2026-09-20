/** Emscripten operations used by the single owning engine Worker. */
export interface EmscriptenModule {
  readonly FS: {
    mkdirTree(path: string): void
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array<ArrayBuffer>
    unlink(path: string): void
  }
  readonly ENV: Record<string, string>
  readonly HEAPU32: Uint32Array
  readonly PThread: { terminateAllThreads(): void }
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number
  UTF8ToString(pointer: number): string
}
