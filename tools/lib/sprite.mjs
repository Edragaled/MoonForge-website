// Resolving a Unity sprite reference to something a browser can show.
//
// A reference with `fileID: 21300000` is the whole texture — serve the PNG as-is.
// Anything else is one sprite inside a sheet (`spriteMode: 2`), and serving the
// PNG would show the entire sheet. The sub-rect lives in the texture's `.meta`,
// keyed by `internalID`, so it is read from there and handed to the site, which
// crops with CSS rather than re-encoding the image.

import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';

/** fileID Unity gives the single sprite of a non-sheet texture. */
const WHOLE_TEXTURE_FILE_ID = '21300000';

/** Pixel size of a PNG, straight out of the IHDR chunk. */
export function pngSize(file) {
  const buffer = Buffer.alloc(24);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, buffer, 0, 24, 0) < 24) return null;
  } finally {
    closeSync(fd);
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * The sprite rects declared in a texture's `.meta`, by `internalID`. Parsed with
 * a line scanner rather than the YAML reader: importer metas nest `rect` under
 * `spriteSheet.sprites[]` alongside dozens of unrelated keys, and only four
 * numbers are wanted.
 */
function spriteRects(texture) {
  const meta = `${texture}.meta`;
  if (!existsSync(meta)) return new Map();

  const rects = new Map();
  let rect = null;

  for (const raw of readFileSync(meta, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();

    // Each sprite entry is `rect:` … then `internalID:` further down, with
    // unrelated keys in between (`serializedVersion`, `alignment`, `pivot`, …),
    // so collect the four numbers loosely and commit on the id. Only bare
    // `x: 3` style keys match — inline flow values like `pivot: {x: 0.5}` do not.
    if (line === 'rect:') { rect = {}; continue; }

    if (rect) {
      const field = /^(x|y|width|height):\s*(-?\d+(?:\.\d+)?)$/.exec(line);
      if (field) {
        if (rect[field[1]] === undefined) rect[field[1]] = Number(field[2]);
        continue;
      }
      const id = /^internalID:\s*(-?\d+)$/.exec(line);
      if (id) {
        if (rect.width && rect.height) rects.set(id[1], rect);
        rect = null;
      }
    }
  }
  return rects;
}

/**
 * `{ file, crop? }` for a sprite reference, or null when unresolvable.
 * `crop` is in CSS coordinates (origin top-left); Unity's rects start at the
 * texture's bottom-left, so y is flipped here.
 */
export function resolveSprite(spriteRef, guidIndex) {
  const guid = spriteRef?.guid;
  if (!guid) return null;

  const file = guidIndex.get(guid);
  if (!file) return { error: `sprite guid ${guid} not found in project` };

  const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) return { error: `sprite is ${ext}, not a plain image` };

  if (String(spriteRef.fileID) === WHOLE_TEXTURE_FILE_ID) return { file };

  const rect = spriteRects(file).get(String(spriteRef.fileID));
  if (!rect) return { error: `no sprite rect for fileID ${spriteRef.fileID} in ${file}` };

  const size = pngSize(file);
  if (!size) return { error: `could not read pixel size of ${file}` };

  return {
    file,
    crop: {
      x: rect.x,
      y: size.height - (rect.y + rect.height),
      w: rect.width,
      h: rect.height,
      sheetW: size.width,
      sheetH: size.height,
    },
  };
}
