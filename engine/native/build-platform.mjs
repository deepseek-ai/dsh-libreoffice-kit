/** Validate native hosts and the explicit Windows ARM64 cross-compiler environment. */
import { hostTarget } from '../../scripts/platform-matrix.mjs';

/**
 * Require a matching host, or an explicitly selected x64 Windows ARM64 cross-build.
 * @param platform - Engine target identifier.
 * @param options - Build host, cross-compilation selection, and compiler environment.
 */
export function verifyBuildPlatform(platform, { host = hostTarget(), crossCompile = false, env = process.env } = {}) {
  if (!crossCompile && platform && platform === host) return;
  if (!crossCompile || host !== 'win32-x64' || platform !== 'win32-arm64')
    throw new Error('Native builds require a matching host; --cross supports only Windows x64 to ARM64');
  if (env.VSCMD_ARG_HOST_ARCH !== 'x64' || env.VSCMD_ARG_TGT_ARCH !== 'arm64')
    throw new Error('Windows ARM64 cross-builds require the MSVC x64_arm64 developer environment');
}
