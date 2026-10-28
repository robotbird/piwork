/** Synthetic quota fixtures: inflate only tiny real entries; override declared
 * central-directory sizes so boundary tests need not allocate hundreds of MB. */
export function withDeclaredSkillZipSizes(
  zip: Uint8Array,
  sizes: Record<string, number>
) {
  const copy = zip.slice();
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  let offset = view.getUint32(copy.length - 6, true);
  const count = view.getUint16(copy.length - 12, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
      throw new Error("Invalid test ZIP central directory");
    }
    const nameBytes = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      copy.subarray(offset + 46, offset + 46 + nameBytes)
    );
    if (sizes[name] !== undefined) {
      view.setUint32(offset + 24, sizes[name], true);
    }
    offset +=
      46 +
      nameBytes +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return copy;
}
