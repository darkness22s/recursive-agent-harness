const DEFAULT_PROFANITY = ["fuck", "f*ck", "shit", "damn", "bullshit"];
const DEFAULT_ANGER = ["angry", "mad", "furious", "hate", "useless", "broken", "stupid"];

function includesTerm(text: string, terms: string[]): boolean {
  const normalized = text.toLowerCase();
  return terms.some((term) => normalized.includes(term.toLowerCase()));
}

export function detectProfanity(text: string, terms = DEFAULT_PROFANITY): boolean {
  return includesTerm(text, terms);
}

export function detectAnger(text: string, terms = DEFAULT_ANGER): boolean {
  return includesTerm(text, terms) || /!{2,}/.test(text);
}

export function defaultProfanityTerms(): string[] {
  return [...DEFAULT_PROFANITY];
}

export function defaultAngerTerms(): string[] {
  return [...DEFAULT_ANGER];
}
