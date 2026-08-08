// Photon Quantum identifies assets by a 64-bit AssetGuid derived from the Unity
// asset guid, so a reference like `LootTable.Id.Value: 534217536395022092` cannot
// be resolved by grepping — the number appears nowhere near the target asset.
//
// ScriptableObjects store their own AssetGuid in an `Identifier` block, so those
// are read directly. Prefab EntityPrototypes do not: each prefab has a sibling
// `<Name>EntityPrototype.qprototype` file, and the AssetGuid is the hash of *that*
// file's Unity guid. So the hash below is reimplemented from
// `QuantumUnityDBUtilities.CreateDeterministicAssetGuid`
// (Photon/Quantum/Editor/QuantumUnityEditor.cs).
//
// Verified against every Identifier in the project: 1278 of 1279 match exactly.
// The one outlier has a manual guid override in QuantumEditorSettings, which is
// why `Identifier` values always win over a computed hash.

import { readFileSync, existsSync } from 'node:fs';

const U64 = (1n << 64n) - 1n;
const SIGN_BIT = 0x7fffffffffffffffn;
/** AssetGuid.ReservedBits — bit 62. Lives in Quantum.Engine.dll; recovered by
 *  diffing computed against stored guids (255 samples differed by exactly this). */
const RESERVED_BITS = 0x4000000000000000n;

/** fileId Quantum uses for a prefab's EntityPrototype asset. */
export const PREFAB_PROTOTYPE_FILE_ID = 3097001405596171208n;

/**
 * Unity writes a GUID as four uint32s, each rendered as 8 hex chars
 * *low-nibble first* — so the text is not a plain big-endian hex dump.
 */
function guidWords(hex) {
  const words = [];
  for (let i = 0; i < 4; i++) {
    let value = 0n;
    for (let j = 0; j < 8; j++) {
      value |= BigInt(parseInt(hex[i * 8 + j], 16)) << BigInt(4 * j);
    }
    words.push(value);
  }
  return words;
}

/** The deterministic AssetGuid for a Unity guid + fileId, as a decimal string. */
export function assetGuid(unityGuid, fileId) {
  let hash = BigInt.asUintN(64, BigInt(fileId));
  for (const word of guidWords(unityGuid)) {
    hash = BigInt.asUintN(64, (hash * 397n) & U64) ^ word;
  }
  return String((hash & SIGN_BIT) & ~RESERVED_BITS);
}

export function readMetaGuid(assetPath) {
  const meta = `${assetPath}.meta`;
  if (!existsSync(meta)) return null;
  const m = /^guid:\s*([0-9a-f]{32})\s*$/m.exec(readFileSync(meta, 'utf8').slice(0, 400));
  return m ? m[1] : null;
}

/**
 * AssetGuid -> prefab path, for every `.qprototype` in the project. The
 * `.qprototype` file's only content is the Unity guid of the prefab it wraps.
 */
export function buildPrototypeIndex(qprototypeFiles, unityGuidToPath) {
  const index = new Map();
  for (const file of qprototypeFiles) {
    const ownGuid = readMetaGuid(file);
    if (!ownGuid) continue;
    const prefabGuid = readFileSync(file, 'utf8').trim();
    const prefab = unityGuidToPath.get(prefabGuid);
    if (prefab) index.set(assetGuid(ownGuid, PREFAB_PROTOTYPE_FILE_ID), prefab);
  }
  return index;
}
