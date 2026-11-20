/** Parse editable animal, group, day, and trial metadata from file names. */

import type { VideoMeta } from './schema';

export const EMPTY_META: VideoMeta = {
  animalId: '',
  group: '',
  day: null,
  trial: null,
  notes: '',
  parsedFromFilename: [],
};

/** Supported filename conventions. */
export interface NamingScheme {
  readonly id: string;
  readonly label: string;
  readonly example: string;
  readonly parse: (stem: string) => Partial<VideoMeta>;
}

const TOKEN_SPLIT = /[_\-\s.]+/;

/** Mutable metadata while parsing. */
type MetaDraft = { -readonly [K in keyof VideoMeta]?: VideoMeta[K] };

/** Parse common day, trial, animal, and group tokens. */
function parseTokens(stem: string): Partial<VideoMeta> {
  const tokens = stem.split(TOKEN_SPLIT).filter(Boolean);
  const out: MetaDraft = {};
  const parsed: (keyof VideoMeta)[] = [];
  const leftovers: string[] = [];

  for (const token of tokens) {
    let m: RegExpMatchArray | null;
    if ((m = /^(?:day|d)[-_]?(\d{1,2})$/i.exec(token))) {
      out.day = Number(m[1]);
      parsed.push('day');
      continue;
    }
    if ((m = /^(?:trial|tr|t)[-_]?(\d{1,2})$/i.exec(token))) {
      out.trial = Number(m[1]);
      parsed.push('trial');
      continue;
    }
    if ((m = /^(?:mouse|animal|subject|id|m)[-_]?(\d{1,4})$/i.exec(token))) {
      out.animalId = `${token.replace(/[-_]/g, '').toUpperCase()}`;
      parsed.push('animalId');
      continue;
    }
    leftovers.push(token);
  }

  // A leftover that is a bare number is most likely the animal, unless we
  // already have one, in which case it is a trial number.
  for (const token of leftovers) {
    if (!/^\d{1,4}$/.test(token)) continue;
    if (out.animalId === undefined) {
      out.animalId = token;
      parsed.push('animalId');
    } else if (out.trial === undefined) {
      out.trial = Number(token);
      parsed.push('trial');
    }
  }

  // A leading word made only of letters is the group.
  //
  // Require letters only so names such as `test50` do not become group labels.
  const words = leftovers.filter((t) => /^[A-Za-z]{2,}$/.test(t));
  if (words.length && out.group === undefined) {
    const candidate = words[0]!;
    // Skip words that are plainly not a group label.
    if (!/^(vid|video|clip|rec|test|trial|cam|movie|session)$/i.test(candidate)) {
      out.group = candidate;
      parsed.push('group');
    }
  }

  return { ...out, parsedFromFilename: parsed };
}

/** Fields at fixed token positions. Day and trial count only as whole numbers. */
function positional(fields: ReadonlyArray<'group' | 'animalId' | 'day' | 'trial'>) {
  return (stem: string): Partial<VideoMeta> => {
    const tokens = stem.split(TOKEN_SPLIT).filter(Boolean);
    const out: MetaDraft = {};
    const parsed: (keyof VideoMeta)[] = [];
    fields.forEach((field, i) => {
      const token = tokens[i];
      if (!token) return;
      if (field === 'day' || field === 'trial') {
        if (!/^\d+$/.test(token)) return;
        out[field] = Number(token);
      } else {
        out[field] = token;
      }
      parsed.push(field);
    });
    return { ...out, parsedFromFilename: parsed };
  };
}

export const NAMING_SCHEMES: ReadonlyArray<NamingScheme> = [
  {
    id: 'auto',
    label: 'Automatic',
    example: 'WT_M12_day3_trial2.mp4  →  group WT, animal M12, day 3, trial 2',
    parse: parseTokens,
  },
  {
    id: 'group-animal-day-trial',
    label: 'group, animal, day, trial',
    example: 'WT_M12_3_2.mp4',
    parse: positional(['group', 'animalId', 'day', 'trial']),
  },
  {
    id: 'animal-day-trial',
    label: 'animal, day, trial',
    example: 'M12_3_2.mp4',
    parse: positional(['animalId', 'day', 'trial']),
  },
  {
    id: 'none',
    label: 'Enter manually',
    example: '',
    parse: () => ({ parsedFromFilename: [] }),
  },
];

export function parseFilename(fileName: string, schemeId = 'auto'): VideoMeta {
  const stem = fileName.replace(/\.[^.]+$/, '');
  const scheme = NAMING_SCHEMES.find((s) => s.id === schemeId) ?? NAMING_SCHEMES[0]!;
  const guess = scheme.parse(stem);
  const usedFallbackAnimal = guess.animalId === undefined;
  return {
    ...EMPTY_META,
    ...guess,
    // Use the file stem as a fallback identity.
    animalId: guess.animalId ?? stem,
    parsedFromFilename: usedFallbackAnimal
      ? [...(guess.parsedFromFilename ?? []), 'animalId']
      : (guess.parsedFromFilename ?? []),
  };
}

/** Estimate whether filenames consistently contain parseable metadata. */
export function schemeConfidence(fileNames: ReadonlyArray<string>, schemeId = 'auto'): {
  fraction: number;
  fields: ReadonlyArray<keyof VideoMeta>;
} {
  if (fileNames.length === 0) return { fraction: 0, fields: [] };
  const counts = new Map<keyof VideoMeta, number>();
  let anyParsed = 0;
  for (const name of fileNames) {
    const meta = parseFilename(name, schemeId);
    const fields = meta.parsedFromFilename.filter((f) => f !== 'animalId' || meta.animalId !== name.replace(/\.[^.]+$/, ''));
    if (fields.length) anyParsed++;
    for (const f of fields) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const fields = [...counts.entries()]
    .filter(([, c]) => c >= fileNames.length * 0.8)
    .map(([f]) => f);
  return { fraction: anyParsed / fileNames.length, fields };
}
