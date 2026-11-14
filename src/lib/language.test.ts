import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLanguageTransitionMessage,
  detectLanguageSwitchIntent,
  detectMidStreamLanguageSwitch,
  detectScriptLanguageHint,
  mergeTranscriptChunk,
  normalizeLanguageName,
  resolveConversationLanguage,
  upsertLanguageTag,
} from './language.ts';

test('normalizeLanguageName resolves English, Hindi, Hinglish, and regional aliases', () => {
  assert.equal(normalizeLanguageName('hindi'), 'Hindi');
  assert.equal(normalizeLanguageName('हिन्दी'), 'Hindi');
  assert.equal(normalizeLanguageName('अंग्रेजी'), 'English');
  assert.equal(normalizeLanguageName('español'), 'Spanish');
  assert.equal(normalizeLanguageName('auto'), null);
  assert.equal(normalizeLanguageName('another'), null);
});

test('resolveConversationLanguage keeps topic locked in single language despite mixed terms', () => {
  const turn1 = resolveConversationLanguage({
    currentLockedLanguage: null,
    detectedInputLanguage: 'Hindi',
  });
  assert.equal(turn1.activeLanguage, 'Hindi');
  assert.equal(turn1.switched, false);

  // Follow-up turn where NLU sees English technical terms ("502 API timeout") -> stays Hindi
  const turn2 = resolveConversationLanguage({
    currentLockedLanguage: turn1.activeLanguage,
    detectedInputLanguage: 'English',
  });
  assert.equal(turn2.activeLanguage, 'Hindi');
  assert.equal(turn2.switched, false);
});

test('detectLanguageSwitchIntent handles vague switch request then named target language', () => {
  const vague = detectLanguageSwitchIntent('मुझे किसी और लैंग्वेज में बात करनी है');
  assert.equal(vague.requestedLanguage, null);
  assert.equal(vague.switchPending, true);

  const followUp = detectLanguageSwitchIntent('English में बात करो', {
    switchPending: true,
  });
  assert.equal(followUp.requestedLanguage, 'English');
  assert.equal(followUp.switchPending, false);

  const resolved = resolveConversationLanguage({
    currentLockedLanguage: 'Hindi',
    detectedInputLanguage: 'English',
    explicitRequestedLanguage: followUp.requestedLanguage,
  });
  assert.equal(resolved.activeLanguage, 'English');
  assert.equal(resolved.switched, true);
});

test('detectLanguageSwitchIntent parses direct switch commands in English, Hinglish, and Hindi', () => {
  assert.equal(
    detectLanguageSwitchIntent('Can we switch to Spanish please?').requestedLanguage,
    'Spanish'
  );
  assert.equal(
    detectLanguageSwitchIntent('Ab mujhe Marathi mein baat karni hai').requestedLanguage,
    'Marathi'
  );
  assert.equal(
    detectLanguageSwitchIntent('अब मुझे अंग्रेजी में बात करनी है').requestedLanguage,
    'English'
  );
  assert.equal(detectScriptLanguageHint('मेरा सर्वर डाउन है'), 'Hindi');
});

test('upsertLanguageTag replaces old language tag and mergeTranscriptChunk preserves word boundaries', () => {
  const tags = upsertLanguageTag(['intent:outage', 'lang:hindi', 'sla:15m'], 'English');
  assert.deepEqual(tags, ['intent:outage', 'sla:15m', 'lang:english']);

  assert.equal(mergeTranscriptChunk('नम', 'स्ते'), 'नमस्ते');
  assert.equal(mergeTranscriptChunk('Hello', ' world'), 'Hello world');
  assert.equal(mergeTranscriptChunk('Hello', ','), 'Hello,');
});

test('detectMidStreamLanguageSwitch catches explicit switches mid-stream without false positives on mixed tech terms', () => {
  // Mixed tech terms inside locked Hindi stream should NOT switch
  const techMix = detectMidStreamLanguageSwitch('हमारे API में 502 error और webhook timeout आ रहा है', {
    currentLanguage: 'Hindi',
  });
  assert.equal(techMix.switched, false);
  assert.equal(techMix.nextLanguage, null);

  // Mid-stream buffered chunks forming a switch request SHOULD switch
  const buffered = mergeTranscriptChunk('Actually let us', ' switch to Spanish please');
  const midSwitch = detectMidStreamLanguageSwitch(buffered, {
    currentLanguage: 'Hindi',
  });
  assert.equal(midSwitch.switched, true);
  assert.equal(midSwitch.previousLanguage, 'Hindi');
  assert.equal(midSwitch.nextLanguage, 'Spanish');

  // Repeating the same language should NOT emit switched=true
  const sameLang = detectMidStreamLanguageSwitch('Continue in Hindi please', {
    currentLanguage: 'Hindi',
  });
  assert.equal(sameLang.switched, false);
  assert.equal(sameLang.nextLanguage, 'Hindi');
});

test('buildLanguageTransitionMessage generates graceful localized transition copy', () => {
  const toEnglish = buildLanguageTransitionMessage('Hindi', 'English');
  assert.ok(toEnglish.includes('Hindi'));
  assert.ok(toEnglish.includes('English'));

  const toHindi = buildLanguageTransitionMessage('English', 'Hindi');
  assert.ok(toHindi.includes('हिन्दी'));

  const toSpanish = buildLanguageTransitionMessage('English', 'Spanish');
  assert.ok(toSpanish.toLowerCase().includes('español'));
});

test('support urgency phrases do not trigger false language switch to non-language words', () => {
  const switchCheck = detectLanguageSwitchIntent(
    'Hello, my production API is returning 502 errors and I need urgent help.'
  );
  assert.equal(switchCheck.requestedLanguage, null);
  assert.equal(switchCheck.switchPending, false);
  assert.equal(normalizeLanguageName('Urgent'), null);
});

