export const DEFAULT_VOICE_CONFIG = Object.freeze({
  version: 1,
  endSilenceMs: 1200,
  replyAudioEnabled: true,
  duplexPreference: 'speaker-duplex',
  tts: Object.freeze({
    providerId: 'windows-system-speech', voiceId: null, rate: 0,
    credentialRef: null, region: 'cn-beijing', workspaceId: '', modelId: 'qwen-audio-3.1-tts-flash',
  }),
});

const fail = (code, message) => Object.assign(new TypeError(message), { code });
export function validateVoiceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('VOICE_CONFIG_INVALID', 'Voice config must be an object');
  if (value.version !== 1) throw fail('VOICE_CONFIG_UNSUPPORTED', `Unsupported voice config version: ${String(value.version)}`);
  const endSilenceMs = value.endSilenceMs ?? DEFAULT_VOICE_CONFIG.endSilenceMs;
  if (![800, 1200, 1800].includes(endSilenceMs)) throw fail('VOICE_CONFIG_INVALID', 'endSilenceMs must be 800, 1200, or 1800');
  if (typeof (value.replyAudioEnabled ?? true) !== 'boolean') throw fail('VOICE_CONFIG_INVALID', 'replyAudioEnabled must be boolean');
  const duplexPreference = value.duplexPreference ?? DEFAULT_VOICE_CONFIG.duplexPreference;
  // A preference is not a device certification. Speaker duplex capture must
  // separately require an enabled AEC track before it acquires call readiness.
  if (!['headphones', 'speaker-turn-taking', 'speaker-duplex'].includes(duplexPreference)) throw fail('VOICE_CONFIG_INVALID', 'duplexPreference is invalid');
  const tts = value.tts ?? {};
  if (!tts || typeof tts !== 'object' || Array.isArray(tts)) throw fail('VOICE_CONFIG_INVALID', 'tts must be an object');
  const providerId = tts.providerId ?? DEFAULT_VOICE_CONFIG.tts.providerId;
  const voiceId = tts.voiceId ?? null;
  const rate = tts.rate ?? 0;
  const credentialRef = tts.credentialRef ?? null;
  const region = tts.region ?? DEFAULT_VOICE_CONFIG.tts.region;
  const workspaceId = tts.workspaceId ?? '';
  const modelId = tts.modelId ?? DEFAULT_VOICE_CONFIG.tts.modelId;
  if (!['windows-system-speech', 'aliyun-qwen-tts'].includes(providerId)) throw fail('VOICE_CONFIG_INVALID', 'tts.providerId is unsupported');
  if (voiceId !== null && (typeof voiceId !== 'string' || voiceId.length > 200)) throw fail('VOICE_CONFIG_INVALID', 'tts.voiceId is invalid');
  if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw fail('VOICE_CONFIG_INVALID', 'tts.rate must be an integer from -10 to 10');
  if (credentialRef !== null && credentialRef !== 'DASHSCOPE_API_KEY') throw fail('VOICE_CONFIG_INVALID', 'tts.credentialRef is unsupported');
  if (!['cn-beijing', 'ap-southeast-1'].includes(region)) throw fail('VOICE_CONFIG_INVALID', 'tts.region is unsupported');
  if (typeof workspaceId !== 'string' || workspaceId.length > 128 || workspaceId && !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(workspaceId)) throw fail('VOICE_CONFIG_INVALID', 'tts.workspaceId is invalid');
  if (!['qwen-audio-3.1-tts-flash', 'qwen-audio-3.1-tts-plus'].includes(modelId)) throw fail('VOICE_CONFIG_INVALID', 'tts.modelId is unsupported');
  return {
    version: 1, endSilenceMs, replyAudioEnabled: value.replyAudioEnabled ?? true, duplexPreference,
    tts: { providerId, voiceId, rate, credentialRef, region, workspaceId, modelId },
  };
}
