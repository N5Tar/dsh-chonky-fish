import assert from 'node:assert/strict';
import { createTurnState } from '../turns.js';
import { DEFAULT_VOICE_CONFIG, validateVoiceConfig } from '../config.js';
import { parseSpeechReply } from '../speech-text.js';
import { VOICE_LIMITS } from '../limits.js';

let groups = 0;
function test(name, run) { run(); groups++; console.log(`ok ${groups} - ${name}`); }

test('voice config accepts supported defaults and rejects unsupported versions', () => {
  assert.deepEqual(validateVoiceConfig({ version: 1 }), { ...DEFAULT_VOICE_CONFIG, tts: { ...DEFAULT_VOICE_CONFIG.tts } });
  assert.throws(() => validateVoiceConfig({ version: 2 }), { code: 'VOICE_CONFIG_UNSUPPORTED' });
  assert.throws(() => validateVoiceConfig({ version: 1, endSilenceMs: 900 }), { code: 'VOICE_CONFIG_INVALID' });
  assert.equal(validateVoiceConfig({ version: 1 }).duplexPreference, 'speaker-duplex');
  assert.equal(validateVoiceConfig({ version: 1, duplexPreference: 'speaker-duplex' }).duplexPreference, 'speaker-duplex');
});

test('turn splitter seals after silence following an earlier 15 second cut', () => {
  const turns = createTurnState({ endSilenceMs: 1200 });
  turns.start(0);
  assert.deepEqual(turns.advance(240000), [{ type: 'cut', startSample: 0, endSample: 240000, reason: 'max-clip' }]);
  turns.end(250000);
  assert.deepEqual(turns.advance(269200), [{ type: 'seal', startSample: 240000, endSample: 250000, reason: 'silence' }]);
});

test('continuous speech has an absolute 90 second cap despite repeated clip cuts', () => {
  const turns = createTurnState();
  turns.start(0);
  assert.equal(turns.advance(240000)[0].type, 'cut');
  assert.equal(turns.advance(480000)[0].type, 'cut');
  assert.equal(turns.advance(720000)[0].type, 'cut');
  const final = turns.advance(1440000);
  assert.deepEqual(final.map((x) => x.type), ['cut', 'cut', 'seal', 'new-turn']);
  assert.equal(final[2].reason, 'max-turn');
  assert.ok([...turns.advance(1450000)].length === 0);
});

test('delayed sample watermarks still produce contiguous clips no longer than 15 seconds', () => {
  const turns = createTurnState(); turns.start(0);
  const actions = turns.advance(600000);
  const cuts = actions.filter((x) => x.type === 'cut');
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every((x) => x.endSample - x.startSample <= 240000));
  assert.deepEqual(cuts.map((x) => [x.startSample, x.endSample]), [[0, 240000], [240000, 480000]]);
});

test('short speech seals at the configured sample-clock silence threshold', () => {
  const turns = createTurnState({ endSilenceMs: 800 });
  turns.start(10000, 5200); turns.end(14000);
  assert.deepEqual(turns.advance(26799), []);
  assert.deepEqual(turns.advance(26800), [{ type: 'seal', startSample: 5200, endSample: 14000, reason: 'silence' }]);
});

test('speech conversion cleans Markdown, keeps full replies, and handles provider tags', () => {
  const text = parseSpeechReply('# 你好\n\n点[这里](https://example.com)。\n```js\nsecret()\n```').synthesisText;
  assert.ok(text.includes('你好'));
  assert.ok(text.includes('这里'));
  assert.ok(!text.includes('example.com'));
  assert.ok(!text.includes('secret'));
  assert.equal(parseSpeechReply('好。'.repeat(140)).synthesisText, '好。'.repeat(140));
  const controlled = parseSpeechReply('你好 [happy] [unknown] ` [sad] `', { allowedTags: ['happy', 'sad'], maxChars: 100 });
  assert.equal(controlled.plainText, '你好 [unknown] ` [sad] `');
  assert.ok(controlled.synthesisText.includes('[happy]'));
  assert.ok(controlled.synthesisText.includes('方括号 unknown'));
  assert.equal(controlled.controls.length, 1);
  assert.equal(parseSpeechReply('好'.repeat(121), { maxChars: 120 }).overLimit, true);
  const link = parseSpeechReply('[link](https://example.com) [happy](https://example.com)', { allowedTags: ['happy'] });
  assert.equal(link.synthesisText, 'link happy');
  assert.equal(link.controls.length, 0, 'a Markdown link label is not a provider tag');
  assert.equal(VOICE_LIMITS.unresolvedInputs, 8);
  assert.equal('replySentenceChars' in VOICE_LIMITS, false);
});

console.log(`voice core: ${groups} groups passed`);
