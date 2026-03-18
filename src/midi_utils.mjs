/*
 * midi_utils.mjs — Pure MIDI infrastructure for MoveMap
 *
 * Contains:
 *   - Math utilities (clamp, clampMidi)
 *   - Move↔LPP delta decoder
 *   - Move hardware CC/note constants
 *   - LPP note grid and value map
 *   - Move↔LPP translation maps
 *   - LED color palette
 *   - Color lookup maps
 *   - MIDI send helpers
 *
 * No business logic. All exports are pure data or thin MIDI wrappers.
 * Send helpers call move_midi_internal_send / move_midi_external_send from globalThis.
 */

/* ── Math utilities ──────────────────────────────────────────────────────── */

export function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

export function clampMidi(value) {
    return clamp(value, 0, 127);
}

/* ── Delta decoder ───────────────────────────────────────────────────────── */
// Decodes Move encoder relative values into signed deltas.
// Value 1 → +1, 127 → -1, 2-63 → +N, 65-127 → N-128.

export function decodeMoveKnobDelta(value) {
    if (value === 1)   return 1;
    if (value === 127) return -1;
    if (value > 1 && value < 64)  return value;
    if (value > 64) return value - 128;
    return 0;
}

/* ── Move hardware CC/note constants ─────────────────────────────────────── */
// Source: [ABLETON] — CC and note numbers for Move hardware controls, as
// documented in the Ableton Move manual.

export const moveLOGO    = 99;
export const moveMENU    = 50;
export const moveBACK    = 51;
export const moveCAP     = 52;
export const moveSHIFT   = 49;
export const moveWHEEL   = 3;
export const movePLAY    = 85;
export const moveREC     = 86;
export const moveLOOP    = 58;
export const moveMUTE    = 88;
export const moveUNDO    = 56;
export const moveTRACK1  = 16;
export const moveSAMPLE  = 118;
export const moveWHEELTouch = 9;

/* ── Move grid layout ────────────────────────────────────────────────────── */

export const moveGridRows = [
    [92, 93, 94, 95, 96, 97, 98, 99],
    [84, 85, 86, 87, 88, 89, 90, 91],
    [76, 77, 78, 79, 80, 81, 82, 83],
    [68, 69, 70, 71, 72, 73, 74, 75]
];

export const moveKnobCcs = [71, 72, 73, 74, 75, 76, 77, 78, 79, 80];

/* ── LPP note grid ───────────────────────────────────────────────────────── */
// Source: [LPP3] §4 — standard 10×10 Launchpad Pro note layout.
// The M8 uses this layout to address its display cells over USB MIDI.
// See also [M8-LPP] for the M8-specific mapping on top of this grid.

export const lppNotes = [
    90, 91, 92, 93, 94, 95, 96, 97, 98, 99,
    80, 81, 82, 83, 84, 85, 86, 87, 88, 89,
    70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
    60, 61, 62, 63, 64, 65, 66, 67, 68, 69,
    50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
    40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19,
    101, 102, 103, 104, 105, 106, 107, 108,
    1, 2, 3, 4, 5, 6, 7, 8
];

// Mutated at runtime by ui.mjs handlers — ES module exports are live references.
export const lppNoteValueMap = new Map([...lppNotes.map((a) => [a, [0, 0, 0]])]);

/* ── Move ↔ LPP control mappings ────────────────────────────────────────── */
// Source: [M8-LPP] — maps Move hardware button/encoder CCs to LPP note numbers
// as expected by the M8's control surface mode. Two layouts exist because Move
// has 4 pad rows while LPP has 8; top and bottom halves cover different octaves.

export const moveControlToLppNoteMapTop = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 89], [42, 79], [41, 69], [40, 59],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [99, 99]
]);

export const lppNoteToMoveControlMapTop = new Map(
    [...moveControlToLppNoteMapTop.entries()].map((a) => [a[1], a[0]])
);

export const moveControlToLppNoteMapBottom = new Map([
    [55, 80], [54, 70], [62, 91], [63, 92], [85, 20],
    [43, 49], [42, 39], [41, 29], [40, 19],
    [50, 94], [49, 90], [119, 60], [51, 93], [52, 97],
    [88, 2], [56, 1], [86, 10], [60, 50], [58, 3],
    [118, 98], [99, 99]
]);

export const lppNoteToMoveControlMapBottom = new Map(
    [...moveControlToLppNoteMapBottom.entries()].map((a) => [a[1], a[0]])
);

/* ── Move ↔ LPP pad mappings ─────────────────────────────────────────────── */
// Source: [M8-LPP] — maps LPP pad note numbers to Move pad note numbers.
// Steps row (notes 101–108) maps to Move's step buttons (notes 16–30 even).
// Two layouts (top/bottom) cover the full LPP 8×8 pad grid across Move's 4×8.

export const lppPadToMovePadMapTop = new Map([
    [81, 92], [82, 93], [83, 94], [84, 95], [85, 96], [86, 97], [87, 98], [88, 99],
    [71, 84], [72, 85], [73, 86], [74, 87], [75, 88], [76, 89], [77, 90], [78, 91],
    [61, 76], [62, 77], [63, 78], [64, 79], [65, 80], [66, 81], [67, 82], [68, 83],
    [51, 68], [52, 69], [53, 70], [54, 71], [55, 72], [56, 73], [57, 74], [58, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

export const moveToLppPadMapTop = new Map(
    [...lppPadToMovePadMapTop.entries()].map((a) => [a[1], a[0]])
);

export const lppPadToMovePadMapBottom = new Map([
    [41, 92], [42, 93], [43, 94], [44, 95], [45, 96], [46, 97], [47, 98], [48, 99],
    [31, 84], [32, 85], [33, 86], [34, 87], [35, 88], [36, 89], [37, 90], [38, 91],
    [21, 76], [22, 77], [23, 78], [24, 79], [25, 80], [26, 81], [27, 82], [28, 83],
    [11, 68], [12, 69], [13, 70], [14, 71], [15, 72], [16, 73], [17, 74], [18, 75],
    [101, 16], [102, 18], [103, 20], [104, 22], [105, 24], [106, 26], [107, 28], [108, 30]
]);

export const moveToLppPadMapBottom = new Map(
    [...lppPadToMovePadMapBottom.entries()].map((a) => [a[1], a[0]])
);

/* ── LED color palette ───────────────────────────────────────────────────── */
// Move LED color values are Move-specific constants derived from [MOVE].
// LPP color index keys used in lppColorToMoveColorMap below are from
// [LPP3] §7 (Colour Palette), translated to the nearest Move LED value.

export const light_grey = 0x7c;
export const dim_grey   = 0x10;
export const green      = 0x7e;
export const navy       = 0x7d;
export const sky        = 0x5f;
export const red        = 0x7f;
export const azure      = 0x63;
export const white      = 0x7a;
export const pink       = 0x6d;
export const aqua       = 0x5a;
export const black      = 0x00;
export const lemonade   = 0x6b;
export const lime       = 0x20;
export const fern       = 0x55;

/* ── Color lookup maps ───────────────────────────────────────────────────── */

export const lppColorToMoveColorMap = new Map([
    [0x15, green], [0x17, lime], [0x1, light_grey], [0x05, red], [0x03, white],
    [0x4e, sky], [0x47, pink], [0x13, aqua], [0x27, navy], [0x2b, azure], [0x16, fern]
]);

export const lppColorToMoveMonoMap = new Map([
    [0x05, 0x7f], [0x78, 0x7f], [0x01, 0x10], [0x07, 0x0f]
]);

/* ── MIDI send helpers ───────────────────────────────────────────────────── */
// These call move_midi_internal_send / move_midi_external_send from globalThis,
// matching the same pattern used in move_virtual_knobs.mjs.

export function sendMovePad(note, color) {
    move_midi_internal_send([0 << 4 | 0x9, 0x90, note, clampMidi(color)]);
}

export function sendMoveControl(controlNumber, value) {
    move_midi_internal_send([0 << 4 | 0xb, 0xB0, controlNumber, clampMidi(value)]);
}

export function sendExternalMidi(status, data1, data2) {
    const cin = (status & 0xf0) >> 4;
    move_midi_external_send([2 << 4 | cin, status, data1, data2]);
}

// Poly aftertouch → modwheel on external channel 3
export function aftertouchToModwheel(data, channel = 3) {
    if (data[0] !== 0xa0) return false;
    move_midi_external_send([(2 << 4) | 0xb, 0xb0 | channel, 1, data[2]]);
    return true;
}
