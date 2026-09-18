import { openDb } from './db.js';

// English is the implicit default: nothing stored, no line in the session
// prompt (current behavior, unchanged). Only override languages are stored.
export const LANGUAGES = [
  { code: 'nl', label: 'Nederlands' },
  { code: 'de', label: 'Deutsch' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
] as const;

export interface Settings {
  language: string | null;
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
}

function assertLanguage(language: unknown): string | null {
  if (language === null || language === undefined || language === '') return null;
  if (typeof language !== 'string' || !LANGUAGES.some((l) => l.code === language)) {
    throw new Error(`Invalid language '${language}'. Use one of: ${LANGUAGES.map((l) => l.code).join(', ')}`);
  }
  return language;
}

export function getSettings(): Settings {
  const db = openDb();
  try {
    return db.prepare('SELECT language FROM settings WHERE id = 1').get() as Settings;
  } finally {
    db.close();
  }
}

export function updateSettings(language: unknown): Settings {
  const value = assertLanguage(language);
  const db = openDb();
  try {
    db.prepare('UPDATE settings SET language = ? WHERE id = 1').run(value);
    return db.prepare('SELECT language FROM settings WHERE id = 1').get() as Settings;
  } finally {
    db.close();
  }
}

export { assertLanguage };
