import { afterEach, expect, it, vi } from 'vitest'
import { discoverRuntime } from '../src/runtime.ts'
import { ENGINE_VERSION, resolveEngine } from '../src/engine.ts'

vi.mock('../src/engine.ts', async original => ({ ...await original<typeof import('../src/engine.ts')>(), resolveEngine: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('discovers paths beside the installed API without launching the engine', async () => {
  vi.mocked(resolveEngine).mockResolvedValue({ backend: 'native', root: '/engine', executable: '/engine/helper', programDirectory: '/engine/program' })
  expect(await discoverRuntime()).toEqual({ backend: 'native', version: ENGINE_VERSION,
    cliPath: expect.stringMatching(/[\\/]cli\.js$/), nodeApiPath: expect.stringMatching(/[\\/]index\.js$/) })
})
it('preserves engine selection failures as unavailable errors', async () => {
  const cause = new Error('missing platform package')
  vi.mocked(resolveEngine).mockRejectedValue(cause)
  await expect(discoverRuntime()).rejects.toMatchObject({ code: 'unavailable', cause })
})
