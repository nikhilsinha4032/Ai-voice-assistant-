export interface LanguageOption {
  value: string;
  label: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { value: 'auto', label: 'Auto (Match Caller)' },
  { value: 'English', label: 'English' },
  { value: 'Hindi', label: 'Hindi (हिन्दी)' },
  { value: 'Hinglish', label: 'Hinglish' },
  { value: 'Spanish', label: 'Spanish (Español)' },
  { value: 'French', label: 'French (Français)' },
  { value: 'German', label: 'German (Deutsch)' },
  { value: 'Marathi', label: 'Marathi (मराठी)' },
  { value: 'Tamil', label: 'Tamil (தமிழ்)' },
  { value: 'Telugu', label: 'Telugu (తెలుగు)' },
  { value: 'Bengali', label: 'Bengali (বাংলা)' },
  { value: 'Arabic', label: 'Arabic (العربية)' },
  { value: 'Portuguese', label: 'Portuguese' },
  { value: 'Japanese', label: 'Japanese (日本語)' },
];

const LANGUAGE_ALIASES: Record<string, string> = {
  en: 'English',
  eng: 'English',
  english: 'English',
  inglish: 'English',
  angrezi: 'English',
  angreji: 'English',
  'अंग्रेजी': 'English',
  'अंग्रेज़ी': 'English',
  'इंग्लिश': 'English',
  hi: 'Hindi',
  hin: 'Hindi',
  hindi: 'Hindi',
  'हिन्दी': 'Hindi',
  'हिंदी': 'Hindi',
  hinglish: 'Hinglish',
  'हिंग्लिश': 'Hinglish',
  es: 'Spanish',
  spa: 'Spanish',
  spanish: 'Spanish',
  espanol: 'Spanish',
  español: 'Spanish',
  'स्पैनिश': 'Spanish',
  'स्पेनिश': 'Spanish',
  fr: 'French',
  fra: 'French',
  french: 'French',
  francais: 'French',
  français: 'French',
  'फ्रेंच': 'French',
  de: 'German',
  deu: 'German',
  german: 'German',
  deutsch: 'German',
  'जर्मन': 'German',
  mr: 'Marathi',
  mar: 'Marathi',
  marathi: 'Marathi',
  'मराठी': 'Marathi',
  ta: 'Tamil',
  tam: 'Tamil',
  tamil: 'Tamil',
  'தமிழ்': 'Tamil',
  'तमिल': 'Tamil',
  te: 'Telugu',
  tel: 'Telugu',
  telugu: 'Telugu',
  'తెలుగు': 'Telugu',
  'तेलुगु': 'Telugu',
  bn: 'Bengali',
  ben: 'Bengali',
  bengali: 'Bengali',
  bangla: 'Bengali',
  'বাংলা': 'Bengali',
  'बंगाली': 'Bengali',
  'बांग्ला': 'Bengali',
  gu: 'Gujarati',
  gujarati: 'Gujarati',
  'ગુજરાતી': 'Gujarati',
  'गुजराती': 'Gujarati',
  pa: 'Punjabi',
  punjabi: 'Punjabi',
  'ਪੰਜਾਬੀ': 'Punjabi',
  'पंजाबी': 'Punjabi',
  ar: 'Arabic',
  ara: 'Arabic',
  arabic: 'Arabic',
  'العربية': 'Arabic',
  'अरबी': 'Arabic',
  ja: 'Japanese',
  jpn: 'Japanese',
  japanese: 'Japanese',
  '日本語': 'Japanese',
  'जापानी': 'Japanese',
  pt: 'Portuguese',
  por: 'Portuguese',
  portuguese: 'Portuguese',
  'português': 'Portuguese',
  'पुर्तगाली': 'Portuguese',
  zh: 'Mandarin',
  chinese: 'Mandarin',
  mandarin: 'Mandarin',
  '中文': 'Mandarin',
  'चाइनीज': 'Mandarin',
  it: 'Italian',
  italian: 'Italian',
  italiano: 'Italian',
  ko: 'Korean',
  korean: 'Korean',
  '한국어': 'Korean',
  ru: 'Russian',
  russian: 'Russian',
  kn: 'Kannada',
  kannada: 'Kannada',
  'ಕನ್ನಡ': 'Kannada',
  'कन्नड़': 'Kannada',
  ml: 'Malayalam',
  malayalam: 'Malayalam',
  'മലയാളം': 'Malayalam',
  'मलयालम': 'Malayalam',
  ur: 'Urdu',
  urdu: 'Urdu',
  'اردو': 'Urdu',
  'उर्दू': 'Urdu',
  or: 'Odia',
  odia: 'Odia',
  oriya: 'Odia',
  ne: 'Nepali',
  nepali: 'Nepali',
  'नेपाली': 'Nepali',
  nl: 'Dutch',
  dutch: 'Dutch',
  nederlands: 'Dutch',
  pl: 'Polish',
  polish: 'Polish',
  tr: 'Turkish',
  turkish: 'Turkish',
  vi: 'Vietnamese',
  vietnamese: 'Vietnamese',
  th: 'Thai',
  thai: 'Thai',
  id: 'Indonesian',
  indonesian: 'Indonesian',
  bahasa: 'Indonesian',
};

const NON_LANGUAGE_WORDS = new Set([
  'auto',
  'unknown',
  'none',
  'null',
  'undefined',
  'other',
  'another',
  'different',
  'new',
  'same',
  'any',
  'aur',
  'doosri',
  'dusri',
  'kisi',
  'koi',
  'और',
  'दूसरी',
  'नई',
  'अन्य',
  'किसी',
  'this',
  'that',
  'it',
  'me',
  'you',
  'language',
  'bhasha',
  'zubaan',
  'baat',
  'bat',
  'topic',
  'लैंग्वेज',
  'भाषा',
  'जुबान',
  'ज़ुबान',
  'बात',
  'टॉपिक',
]);

export function normalizeLanguageName(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/[.,!?;:।"'()\[\]]+/g, '')
    .trim();
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase();
  if (NON_LANGUAGE_WORDS.has(lower)) return null;
  if (LANGUAGE_ALIASES[lower]) return LANGUAGE_ALIASES[lower];

  // Check if any known alias appears as a token inside the string
  for (const token of lower.split(/[\s/_-]+/)) {
    if (LANGUAGE_ALIASES[token]) {
      return LANGUAGE_ALIASES[token];
    }
  }

  return null;
}

export interface SwitchIntentResult {
  requestedLanguage: string | null;
  switchPending: boolean;
}

const VAGUE_SWITCH_PATTERNS: RegExp[] = [
  /(?:switch|change)\s+(?:to\s+)?(?:a\s+)?(?:different|another|other|new)\s+language/i,
  /(?:speak|talk|reply|respond|continue|chat)\s+(?:in\s+)?(?:a\s+)?(?:different|another|other)\s+language/i,
  /(?:change|switch)\s+(?:the\s+)?language\b/i,
  /(?:kisi\s+aur|doosri|dusri|other|another)\s+(?:language|bhasha|zubaan)\s+(?:mein|me|mai)\s+(?:baat|bat|bolo|speak|talk)/i,
  /(?:language|bhasha)\s+(?:change|badlo|badal|switch)/i,
  /(?:किसी\s+और|दूसरी|अन्य|नयी|नई)\s+(?:लैंग्वेज|भाषा|ज़ुबान|जुबान)\s+(?:में|मे)/u,
  /(?:लैंग्वेज|भाषा)\s+(?:बदल|चेंज|स्विच)/u,
];

const EXPLICIT_TARGET_PATTERNS: RegExp[] = [
  /(?:speak|talk|switch|change|continue|reply|respond|chat|converse)\s+(?:to\s+me\s+|with\s+me\s+|now\s+)?(?:in|to)\s+([\p{L}\p{M}-]+)/iu,
  /(?:change|switch|set)\s+(?:the\s+|my\s+|our\s+)?language\s+(?:to|in)\s+([\p{L}\p{M}-]+)/iu,
  /(?:prefer|want\s+to\s+(?:speak|talk|use)|need)\s+(?:in\s+)?([\p{L}\p{M}-]+)(?:\s+language)?/iu,
  /([\p{L}\p{M}-]+)\s+(?:mein|me|mai)\s+(?:baat|bat|bolo|boliye|batao|reply|continue|karni|karna)/iu,
  /(?:ab|mujhe|humko|hame|please)\s+([\p{L}\p{M}-]+)\s+(?:mein|me|mai)\s+(?:baat|bat|bolo|boliye|reply)/iu,
  /([\p{L}\p{M}-]+)\s+(?:में|मे)\s+(?:बात|बोल|बोलें|बोलिए|बताएं|जवाब|कंटिन्यू|रिप्लाई)/u,
  /(?:अब|मुझे|हमको|हमें|कृपया)\s+([\p{L}\p{M}-]+)\s+(?:में|मे)\s+(?:बात|बोल|जवाब)/u,
];

export function detectLanguageSwitchIntent(
  utterance: string,
  options?: { switchPending?: boolean }
): SwitchIntentResult {
  const text = utterance.trim();
  if (!text) {
    return { requestedLanguage: null, switchPending: false };
  }

  // If the agent just asked which language the caller wants, accept short direct answers
  if (options?.switchPending) {
    for (const token of text.split(/[\s,।.?!]+/)) {
      const candidate = normalizeLanguageName(token);
      if (candidate && LANGUAGE_ALIASES[token.toLowerCase()]) {
        return { requestedLanguage: candidate, switchPending: false };
      }
    }
  }

  for (const pattern of VAGUE_SWITCH_PATTERNS) {
    if (pattern.test(text)) {
      return { requestedLanguage: null, switchPending: true };
    }
  }

  for (const pattern of EXPLICIT_TARGET_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const normalized = normalizeLanguageName(match[1]);
      if (normalized) {
        return { requestedLanguage: normalized, switchPending: false };
      }
    }
  }

  return { requestedLanguage: null, switchPending: false };
}

export function detectScriptLanguageHint(utterance: string): string | null {
  if (/[\u0900-\u097F]/.test(utterance)) return 'Hindi';
  if (/[\u0600-\u06FF]/.test(utterance)) return 'Arabic';
  if (/[\u0980-\u09FF]/.test(utterance)) return 'Bengali';
  if (/[\u0B80-\u0BFF]/.test(utterance)) return 'Tamil';
  if (/[\u0C00-\u0C7F]/.test(utterance)) return 'Telugu';
  if (/[\u3040-\u30FF]/.test(utterance)) return 'Japanese';
  return null;
}

export interface LanguageResolutionInput {
  currentLockedLanguage: string | null;
  detectedInputLanguage?: string | null;
  explicitRequestedLanguage?: string | null;
  switchPending?: boolean;
}

export interface LanguageResolutionResult {
  activeLanguage: string;
  switched: boolean;
  switchPending: boolean;
}

export function resolveConversationLanguage(
  input: LanguageResolutionInput
): LanguageResolutionResult {
  const current = normalizeLanguageName(input.currentLockedLanguage);
  const requested = normalizeLanguageName(input.explicitRequestedLanguage);
  const detected = normalizeLanguageName(input.detectedInputLanguage);

  // 1. Explicit request to switch to a named language always books the new language
  if (requested) {
    return {
      activeLanguage: requested,
      switched: current !== null ? current !== requested : false,
      switchPending: false,
    };
  }

  // 2. If a language is already locked for this topic, keep it locked
  if (current) {
    return {
      activeLanguage: current,
      switched: false,
      switchPending: Boolean(input.switchPending),
    };
  }

  // 3. Initial turn: lock onto detected language (or English fallback if unknown)
  return {
    activeLanguage: detected || 'English',
    switched: false,
    switchPending: Boolean(input.switchPending),
  };
}

export function upsertLanguageTag(tags: string[], activeLanguage: string): string[] {
  const slug = activeLanguage
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  const filtered = tags.filter((tag) => !tag.startsWith('lang:'));
  if (!slug) return filtered;
  return [...filtered, `lang:${slug}`];
}

export function mergeTranscriptChunk(existing: string, incoming: string): string {
  if (!existing) return incoming.trimStart();
  if (!incoming) return existing;

  // Preserve token-level spacing when Gemini streams chunks with leading spaces or punctuation
  if (
    /^\s/.test(incoming) ||
    /\s$/.test(existing) ||
    /^[.,!?;:।'"\)\]]/.test(incoming)
  ) {
    return `${existing}${incoming}`;
  }

  return `${existing}${incoming}`;
}

export interface MidStreamSwitchResult {
  switched: boolean;
  previousLanguage: string | null;
  nextLanguage: string | null;
  switchPending: boolean;
}

export function detectMidStreamLanguageSwitch(
  streamBuffer: string,
  options: {
    currentLanguage: string | null;
    switchPending?: boolean;
  }
): MidStreamSwitchResult {
  const current = normalizeLanguageName(options.currentLanguage);
  const intent = detectLanguageSwitchIntent(streamBuffer, {
    switchPending: options.switchPending,
  });

  if (intent.requestedLanguage) {
    const changed = current === null || current !== intent.requestedLanguage;
    return {
      switched: changed,
      previousLanguage: current,
      nextLanguage: intent.requestedLanguage,
      switchPending: false,
    };
  }

  return {
    switched: false,
    previousLanguage: current,
    nextLanguage: null,
    switchPending: intent.switchPending || Boolean(options.switchPending),
  };
}

export function buildLanguageTransitionMessage(
  previousLanguage: string | null,
  nextLanguage: string
): string {
  const target = normalizeLanguageName(nextLanguage) || nextLanguage;
  const prev = normalizeLanguageName(previousLanguage);

  switch (target) {
    case 'Hindi':
      return prev
        ? `बातचीत की भाषा ${prev} से बदलकर हिन्दी में बुक कर दी गई है — अब हम हिन्दी में जारी रखेंगे।`
        : `बातचीत की भाषा हिन्दी में बुक कर दी गई है — अब हम हिन्दी में जारी रखेंगे।`;
    case 'Hinglish':
      return prev
        ? `Language ${prev} se switch karke Hinglish mein book kar di gayi hai — ab hum Hinglish mein continue karenge.`
        : `Language Hinglish mein book kar di gayi hai — ab hum Hinglish mein continue karenge.`;
    case 'Spanish':
      return prev
        ? `Idioma cambiado de ${prev} a español — continuaremos la conversación en español.`
        : `Idioma fijado en español — continuaremos la conversación en español.`;
    case 'French':
      return prev
        ? `Langue modifiée de ${prev} vers le français — nous poursuivons la conversation en français.`
        : `Langue définie sur le français — nous poursuivons la conversation en français.`;
    case 'German':
      return prev
        ? `Sprache von ${prev} auf Deutsch umgestellt — wir setzen das Gespräch auf Deutsch fort.`
        : `Sprache auf Deutsch festgelegt — wir setzen das Gespräch auf Deutsch fort.`;
    default:
      return prev
        ? `Conversation language switched from ${prev} to ${target} — continuing in ${target}.`
        : `Conversation language locked to ${target} — continuing in ${target}.`;
  }
}

