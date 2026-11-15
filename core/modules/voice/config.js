export const DEFAULT_VOICE_CONFIG = Object.freeze({
  version: 1,
  endSilenceMs: 1200,
  replyAudioEnabled: true,
  duplexPreference: 'speaker-turn-taking',
  tts: Object.freeze({ providerId: 'windows-system-speech', voiceId: null, rate: 0 }),
});

const fail = (code, message) => Object.assign(new TypeError(message), { code });
export function validateVoiceConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('VOICE_CONFIG_INVALID', 'Voice config must be an object');
  if (value.version !== 1) throw fail('VOICE_CONFIG_UNSUPPORTED', `Unsupported voice config version: ${String(value.version)}`);
  const endSilenceMs = value.endSilenceMs ?? DEFAULT_VOICE_CONFIG.endSilenceMs;
  if (![800, 1200, 1800].includes(endSilenceMs)) throw fail('VOICE_CONFIG_INVALID', 'endSilenceMs must be 800, 1200, or 1800');
  if (typeof (value.replyAudioEnabled ?? true) !== 'boolean') throw fail('VOICE_CONFIG_INVALID', 'replyAudioEnabled must be boolean');
  const duplexPreference = value.duplexPreference ?? DEFAULT_VOICE_CONFIG.duplexPreference;
  if (duplexPreference === 'speaker-duplex') throw fail('VOICE_DUPLEX_UNVERIFIED', 'Speaker full-duplex requires live device calibration and cannot be stored as a preference');
  if (!['headphones', 'speaker-turn-taking'].includes(duplexPreference)) throw fail('VOICE_CONFIG_INVALID', 'duplexPreference is invalid');
  const tts = value.tts ?? {};
  if (!tts || typeof tts !== 'object' || Array.isArray(tts)) throw fail('VOICE_CONFIG_INVALID', 'tts must be an object');
  const providerId = tts.providerId ?? DEFAULT_VOICE_CONFIG.tts.providerId;
  const voiceId = tts.voiceId ?? null;
  const rate = tts.rate ?? 0;
  if (typeof providerId !== 'string' || !providerId || providerId.length > 100) throw fail('VOICE_CONFIG_INVALID', 'tts.providerId is invalid');
  if (voiceId !== null && (typeof voiceId !== 'string' || voiceId.length > 200)) throw fail('VOICE_CONFIG_INVALID', 'tts.voiceId is invalid');
  if (!Number.isInteger(rate) || rate < -10 || rate > 10) throw fail('VOICE_CONFIG_INVALID', 'tts.rate must be an integer from -10 to 10');
  return { version: 1, endSilenceMs, replyAudioEnabled: value.replyAudioEnabled ?? true, duplexPreference, tts: { providerId, voiceId, rate } };
}
