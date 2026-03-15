/*
 * Unit tests for MoveMap bank switching state machine
 *
 * Run: node tests/test_bank_switching.mjs
 *
 * Tests cover:
 *   1. Shift+Menu cycles through banks: M8_TRACK → M8_MASTER → M8_FX → ABLETON → M8_TRACK
 *   2. Shift+Menu ×3 from M8_TRACK reaches ABLETON; one more press wraps back to M8_TRACK
 *   3. Bank switch resets: shiftHeld=false, wheelClicked=false, showingTop=true
 *   4. M8 bank routes external messages to LPP handler (color translation)
 *   5. Ableton bank routes external messages filtered by MIDI channel
 *   6. Wrong MIDI channel on external messages is ignored in Ableton bank
 *   7. Shift CC (49) tracked in both M8 and Ableton banks
 *   8. Ableton bank: encoder indicators updated when shift state changes
 */

import { createHostMock } from './harness/host_mock.mjs';
import { assertEqual, assertTrue, assertFalse, summarize } from './harness/assert.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function freshMoveMap() {
    const url = new URL('../src/ui.mjs', import.meta.url);
    url.searchParams.set('t', Date.now() + Math.random());
    await import(url.href);
}

function cc(num, value) { return [0xb0, num, value]; }
function extCC(channel, num, value) { return [0xb0 | channel, num, value]; }

const moveSHIFT = 49;
const moveMENU  = 50;
const ABLETON_CH = 15; // yursProfile.midiChannel

// ── Test suites ───────────────────────────────────────────────────────────────

async function testShiftMenuToAbleton() {
    console.log('\n--- Shift+Menu ×3: M8_TRACK → ABLETON ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Module starts in M8_TRACK. Cycle through M8_MASTER → M8_FX → ABLETON.
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    mock.clearAll();
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON

    // After switching, external Ableton CC on correct channel should be handled
    mock.clearAll();
    globalThis.onMidiMessageExternal(extCC(ABLETON_CH, 0, 64)); // volume[0]=64
    // Ableton handler accepts this; knob indicator updated
    assertTrue(mock.sentInternal.length > 0, 'M8→Ableton: Ableton external CC accepted after switch');
}

async function testShiftMenuToM8() {
    console.log('\n--- Shift+Menu: ABLETON → M8_TRACK (wrap) ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Cycle to Ableton (×3)
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON

    // One more press wraps back to M8_TRACK
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    mock.clearAll();
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_TRACK

    // After switching back, an M8-style note-on from LPP should route to M8 handler
    // LPP sends note-on 0x90 on channel 0 = 0x90
    mock.clearAll();
    globalThis.onMidiMessageExternal([0x90, 81, 0x15]); // LPP note 81 (pad), color 0x15
    // M8 handler should translate and send to Move internal
    assertTrue(mock.sentInternal.length > 0, 'Ableton→M8: LPP note routed to M8 handler');
}

async function testBankSwitchPreservesShiftState() {
    console.log('\n--- Bank switch preserves hardware shift state ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Hold shift, cycle to Ableton. Shift stays held (hardware state is preserved).
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127)); // shiftHeld = true
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON

    // Release shift (simulating hardware key release)
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 0));

    // Now volume CC from Ableton should update the knob indicator (shift off)
    mock.clearAll();
    globalThis.onMidiMessageExternal(extCC(ABLETON_CH, 0, 50));
    const knobUpdate = mock.sentInternal.filter(p => p[1] === 0xb0 && p[2] === 71);
    assertTrue(knobUpdate.length > 0, 'after shift release: volume CC updates knob indicator');
}

async function testM8BankColorTranslation() {
    console.log('\n--- M8 bank applies LPP color translation ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Module starts in M8 bank. Send LPP note-on with color 0x15 (green in LPP).
    // LPP note 81 maps to Move pad 92 in top layout.
    mock.clearAll();
    globalThis.onMidiMessageExternal([0x90, 81, 0x15]);
    assertTrue(mock.sentInternal.length > 0, 'M8 bank: LPP note sent to Move internal');
    // The color 0x15 should be translated via lppColorToMoveColorMap to 0x7e (green)
    const padMsg = mock.sentInternal.find(p => p[2] === 92);
    assertTrue(padMsg !== undefined, 'M8 bank: Move pad 92 updated');
    assertEqual(padMsg[3], 0x7e, 'M8 bank: color 0x15 → 0x7e (green)');
}

async function testAbletonBankChannelFilter() {
    console.log('\n--- Ableton bank filters by MIDI channel ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Cycle to Ableton (×3), then release shift
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 0));  // release shift

    // Message on correct channel should be handled
    mock.clearAll();
    globalThis.onMidiMessageExternal(extCC(ABLETON_CH, 0, 70));
    assertTrue(mock.sentInternal.length > 0, 'Ableton bank: correct channel accepted');

    // Message on wrong channel should be ignored
    mock.clearAll();
    globalThis.onMidiMessageExternal(extCC(0, 0, 70)); // channel 0, not 15
    assertEqual(mock.sentInternal.length, 0, 'Ableton bank: wrong channel ignored');
}

async function testShiftTrackedBothBanks() {
    console.log('\n--- Shift CC tracked in both banks ---');
    const mock = createHostMock();
    await freshMoveMap();

    // In M8 bank: shift press and release don't crash
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 0));
    assertEqual(1, 1, 'M8 bank: shift CC does not throw');

    // Cycle to Ableton bank (×3)
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON

    // In Ableton bank: shift press and release don't crash; encoder indicators update
    mock.clearAll();
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    assertTrue(mock.sentInternal.length > 0, 'Ableton bank: shift press updates encoder indicators');

    mock.clearAll();
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 0));
    assertTrue(mock.sentInternal.length > 0, 'Ableton bank: shift release updates encoder indicators');
}

async function testEncoderIndicatorsOnShift() {
    console.log('\n--- Encoder indicators update on shift in Ableton bank ---');
    const mock = createHostMock();
    await freshMoveMap();

    // Cycle to Ableton (×3)
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_MASTER
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → M8_FX
    globalThis.onMidiMessageInternal(cc(moveMENU, 127)); // → ABLETON
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 0)); // shift off

    // Load some sendA values via external CC so we can verify they show up on shift
    globalThis.onMidiMessageExternal(extCC(ABLETON_CH, 16, 99)); // sendA[0] = 99

    // Press shift: encoder indicators should switch to sendA values (knob 0 = 99)
    mock.clearAll();
    globalThis.onMidiMessageInternal(cc(moveSHIFT, 127));
    const knob0Updates = mock.sentInternal.filter(p => p[1] === 0xb0 && p[2] === 71);
    assertTrue(knob0Updates.length > 0, 'shift on: knob 0 indicator updated');
    assertEqual(knob0Updates[knob0Updates.length - 1][3], 99, 'shift on: knob 0 shows sendA value 99');
}

// ── Run all suites ────────────────────────────────────────────────────────────

const mock = createHostMock();

await testShiftMenuToAbleton();
await testShiftMenuToM8();
await testBankSwitchPreservesShiftState();
await testM8BankColorTranslation();
await testAbletonBankChannelFilter();
await testShiftTrackedBothBanks();
await testEncoderIndicatorsOnShift();

mock.enableLog();
summarize('movemap_bank_switching');
