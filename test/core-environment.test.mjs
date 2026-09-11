import assert from 'node:assert/strict';
import test from 'node:test';
import { windowsCoreEnvironment } from '../engine/native/core-environment.mjs';

// Windows exports from the pinned Core's config_host.mk.in; SDK discovery names retain their spelling.
const configHostTemplate = [
  'PATH', 'UCRTSDKDIR', 'UCRTVERSION', 'COMPATH', 'VCTOOLSET', 'VCVER',
  'WINDOWS_SDK_HOME', 'WINDOWS_SDK_LIB_SUBDIR', 'WINDOWS_SDK_VERSION',
].map(key => `export ${key}=@${key}@`).join('\n') + '\n$(if $(T_USE_CLANG), export SHOWINCLUDES_PREFIX="${LO_CLANG_SHOWINCLUDES_PREFIX}" &&)';

test('Core removes confirmed MSVC conflicts while preserving helper and SDK discovery inputs', () => {
  const environment = Object.freeze({
    INCLUDE: 'C:\\Program Files (x86)\\Windows Kits\\include;C:\\VC\\include',
    UCRTVersion: '10.0.22621.0',
    Path: 'C:\\VC\\bin;C:\\cygwin64\\bin',
    LIB: 'C:\\VC\\lib',
    WindowsSdkDir: 'C:\\Windows Kits\\10',
    WindowsSDKVersion: '10.0.22621.0',
    VCInstallDir: 'C:\\VC',
    VCToolsInstallDir: 'C:\\VC\\Tools',
    VisualStudioVersion: '17.0',
    UniversalCRTSdkDir: 'C:\\Windows Kits\\10',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  });
  const result = windowsCoreEnvironment(environment, configHostTemplate);
  assert.equal(result.INCLUDE, undefined);
  assert.equal(result.UCRTVersion, undefined);
  assert.equal(result.Path, undefined);
  assert.equal(result.PATH, environment.Path);
  for (const key of ['LIB', 'WindowsSdkDir', 'WindowsSDKVersion', 'VCInstallDir', 'VCToolsInstallDir', 'VisualStudioVersion', 'UniversalCRTSdkDir', 'ProgramFiles(x86)']) assert.equal(result[key], environment[key]);
  assert.equal(environment.UCRTVersion, '10.0.22621.0');
  assert.ok(environment.INCLUDE.includes(';'));
});

test('an unknown case alias of a Core export stops before compilation without exposing its value', () => {
  assert.throws(() => windowsCoreEnvironment({ Windows_Sdk_Home: 'private-environment-value' }, configHostTemplate), error => {
    assert.match(error.message, /Windows_Sdk_Home\/WINDOWS_SDK_HOME/);
    assert.ok(!error.message.includes('private-environment-value'));
    return true;
  });
  assert.deepEqual(windowsCoreEnvironment({ WINDOWS_SDK_HOME: 'canonical' }, configHostTemplate), { WINDOWS_SDK_HOME: 'canonical' });
  assert.throws(() => windowsCoreEnvironment({ ShowIncludes_Prefix: 'private-environment-value' }, configHostTemplate), /ShowIncludes_Prefix\/SHOWINCLUDES_PREFIX/);
});
