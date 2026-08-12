/**
 * Voice, via the browser's own speech engine.
 *
 * Deliberately not a server-side STT integration yet. The Web Speech API needs
 * no key, no audio upload and no extra latency hop, which makes it the right
 * thing to ship first — and it keeps voice audio off our infrastructure
 * entirely, which is the better default for a hotel dictating commercial
 * decisions.
 *
 * The important part is architectural and already true: voice does not get its
 * own path. It produces text, that text goes through the same
 * intent → policy → simulation → confirmation chain as anything typed, and the
 * audit record is identical apart from the channel. Swapping in a server-side
 * STT provider later changes this file and nothing else.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = {
  input: () => recognitionCtor() != null,
  output: () => typeof window !== 'undefined' && 'speechSynthesis' in window,
};

export interface DictationHandle {
  stop(): void;
}

export function startDictation(opts: {
  lang?: string;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): DictationHandle | null {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    opts.onError('This browser has no speech recognition. Chrome and Edge do.');
    return null;
  }

  const recognition = new Ctor();
  recognition.lang = opts.lang ?? navigator.language ?? 'es-CO';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = '';

  recognition.onresult = (event: any) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    opts.onPartial((finalText + interim).trim());
  };

  recognition.onerror = (event: any) => {
    // "aborted" and "no-speech" are normal ways for a push-to-talk session to
    // end; surfacing them as errors would just be noise.
    if (event?.error === 'aborted' || event?.error === 'no-speech') return;
    opts.onError(
      event?.error === 'not-allowed'
        ? 'Microphone access was denied.'
        : `Speech recognition failed: ${event?.error ?? 'unknown'}`,
    );
  };

  recognition.onend = () => {
    if (finalText.trim()) opts.onFinal(finalText.trim());
    opts.onEnd();
  };

  try {
    recognition.start();
  } catch {
    opts.onError('Could not start the microphone.');
    return null;
  }

  return { stop: () => recognition.stop() };
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export function speak(text: string, lang?: string): void {
  if (!voiceSupported.output()) return;
  cancelSpeech();

  // Read the prose, not the formatting. A screen reader saying "asterisk
  // asterisk" is worse than silence.
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\|[^\n]*\|/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return;

  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 4000));
  utterance.lang = lang ?? navigator.language ?? 'es-CO';
  utterance.rate = 1.05;
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
}

export function cancelSpeech(): void {
  if (!voiceSupported.output()) return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isSpeaking(): boolean {
  return voiceSupported.output() && window.speechSynthesis.speaking;
}
