import process from 'node:process'

import { createPosixPlatform, posixPlatform } from './posix.js'
import { createWin32Platform, win32Platform } from './win32.js'
import { createWindowsTts } from './voice/windows-tts.js'

/**
 * 平台层唯一入口：业务模块只 import 这里，不自己判断 process.platform。
 *
 * 目前平台差异只覆盖「文件系统持久化原语」。以后如果出现别的操作系统差异
 * （进程、信号、路径规则），按同样的形状在这里加能力，而不是在业务模块里分支。
 */
export const PLATFORM_NAMES = Object.freeze(['posix', 'win32'])

/** host 可以是 process.platform，也可以是测试里伪造的字符串。 */
export function platformNameFor(host = process.platform) {
  return host === 'win32' ? 'win32' : 'posix'
}

export function createPlatform(name = platformNameFor()) {
  if (!PLATFORM_NAMES.includes(name)) throw new TypeError(`Unknown platform: ${name}`)
  return name === 'win32' ? createWin32Platform() : createPosixPlatform()
}

/** 当前进程选择的实现；只在这里根据操作系统分派。 */
export const platform = platformNameFor() === 'win32' ? win32Platform : posixPlatform

/** Host identity for authenticated capability reporting; keep process probes here. */
export function runtimeInfo() { return Object.freeze({ os: process.platform, arch: process.arch }) }

/** 诊断用：面板/日志可以报出实际生效的平台模块与能力。 */
export function describePlatform(value = platform) {
  return { name: value.name, directorySync: value.directorySync === true, caseInsensitivePaths: value.caseInsensitivePaths === true }
}

/** Native activity collection capability; file existence is checked by the host. */
export function perceptionTarget(host = process.platform, arch = process.arch) {
  return {
    os: host,
    arch,
    supported: host === 'darwin' && ['arm64', 'x64'].includes(arch),
    reason: host === 'darwin' && ['arm64', 'x64'].includes(arch) ? null : '当前版本仅支持 macOS arm64 / x64 活动采集',
  }
}

/** Native voice provider selection is distinct from the filesystem posix/win32 label. */
export function voiceTtsTarget(host = process.platform, arch = process.arch) {
  if (host !== 'win32' || arch !== 'x64') return {
    inspect: () => ({ supported: false, providerId: 'windows-system-speech', reason: 'WINDOWS_X64_REQUIRED' }),
    listVoices: async () => [],
    synthesize: async () => { throw Object.assign(new Error('Windows x64 System.Speech is unavailable'), { code: 'TTS_UNSUPPORTED' }) },
    close() {},
  }
  const executable = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
  return createWindowsTts({ executable })
}

export { createPosixPlatform, createWin32Platform }
export default platform
