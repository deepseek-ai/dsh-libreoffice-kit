/** Validate native hosts and the explicitly supported cross-compilation pairs. */
import { hostTarget } from '../../scripts/platform-matrix.mjs';

/**
 * Require a matching host, or an explicitly selected supported cross-build.
 * @param platform - Engine target identifier.
 * @param options - Build host, cross-compilation selection, and compiler environment.
 */
export function verifyBuildPlatform(platform, { host = hostTarget(), crossCompile = false, env = process.env } = {}) {
  if (!crossCompile && platform && platform === host) return;
  if (crossCompile && host === 'darwin-arm64' && platform === 'darwin-x64') return;
  if (!crossCompile || host !== 'win32-x64' || platform !== 'win32-arm64')
    throw new Error('Native builds require a matching host; --cross supports macOS ARM64 to x64 or Windows x64 to ARM64');
  if (env.VSCMD_ARG_HOST_ARCH !== 'x64' || env.VSCMD_ARG_TGT_ARCH !== 'arm64')
    throw new Error('Windows ARM64 cross-builds require the MSVC x64_arm64 developer environment');
}
