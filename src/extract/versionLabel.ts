// Version labels: "v3", "v3.5", "v3_5", and the LHCb style "v4r1" (version 4, release 1).

/** Digits of a version, with `.`/`_` or `r` between the parts ("4r1", "3.5.1"). */
const NUM = String.raw`\d+(?:(?:[._]|r(?=\d))\d+)*`;
export const VERSION_IN_NAME = new RegExp(String.raw`(?:^|[^a-z])v(${NUM})`, 'i');
export const VERSION_ON_TITLE = new RegExp(String.raw`\b(?:version|draft)\s*v?(${NUM})\b`, 'i');
/** A version at the end of a file-name stem, for stripping it ("note-v4r1"). */
export const VERSION_SUFFIX = new RegExp(String.raw`[-_ ]?v?${NUM}$`, 'i');

const fmt = (digits: string) => `v${digits.replace(/_/g, '.').replace(/R/g, 'r')}`;

export function versionInName(name: string): string | null {
  const m = VERSION_IN_NAME.exec(name);
  return m ? fmt(m[1]) : null;
}

export function versionOnTitle(text: string): string | null {
  const m = VERSION_ON_TITLE.exec(text);
  return m ? fmt(m[1]) : null;
}

/** Numeric parts for sorting: v4r1 → [4, 1], v3.5 → [3, 5]. */
export function versionKey(label: string): number[] {
  const m = new RegExp(NUM, 'i').exec(label);
  return m ? m[0].split(/[._r]/i).map(Number) : [Infinity];
}

/** v1, v1.0 and v1.0.0 are the same version; so are v4r1 and v4.1. */
export function sameVersion(a: string, b: string): boolean {
  const k = (l: string) => {
    const parts = versionKey(l);
    while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
    return parts.join('.');
  };
  return k(a) === k(b);
}
