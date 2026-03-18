/*
 * MoveMap — M8 tracker + Ableton Live dual-mode control surface
 *
 * Banks:
 *   M8 Track, M8 Master, M8 FX  — control the Dirtywave M8 via LPP protocol
 *   Custom device banks          — CC knob banks built with scripts/browse_devices.mjs
 *   Ableton (YURS)               — mixer / device control via YURS remote script
 *
 * Bank switching: Shift+Menu cycles through all banks in order.
 * Exit overtake:  Shift+Vol+Jog (host-level shortcut, always works).
 *
 * External sources used in this file (links appear once at first use):
 *   [LPP3]    LPP3 Programmer Reference Guide (Focusrite)
 *             https://fael-downloads-prod.focusrite.com/customer/prod/s3fs-public/downloads/LPP3_prog_ref_guide_200415.pdf
 *   [M8-LPP]  M8 + LPP recap by grahack — note grid and Move↔M8 control mappings
 *             https://grahack.github.io/M8_LPP_recap/
 *   [ABLETON] Ableton Move Manual — Move hardware CC/note assignments
 *             https://www.ableton.com/en/move/manual/
 *   [YURS]    YURS remote script protocol — CC/note assignments
 *             https://forum.yaeltex.com/t/yurs-yaeltex-universal-remote-script-for-ableton-live/161
 *   [MIDI]    MIDI Universal Device Inquiry (MIDI 1.0 Spec, SysEx ID Request F0 7E 7F 06 01 F7)
 */

import {
    handleMoveKnobs,
    getPotValue,
    setPotBank,
    setPotTrack,
    setTrackScopedPots,
    setPotShiftHeld,
    configurePotBank,
    POT_BANKS,
} from './move_virtual_knobs.mjs';

import { movemapConfig } from './config/movemap_config.mjs';
import { loadParams, getParam, setParam } from './params.mjs';

import {
    clamp, clampMidi, decodeMoveKnobDelta,
    moveLOGO, moveMENU, moveBACK, moveCAP, moveSHIFT, moveWHEEL,
    movePLAY, moveREC, moveLOOP, moveMUTE, moveUNDO,
    moveTRACK1, moveSAMPLE, moveWHEELTouch, moveKnobCcs, moveGridRows,
    light_grey, dim_grey, green, navy, sky, red, azure, white,
    pink, aqua, black, lemonade, lime, fern,
    lppColorToMoveColorMap, lppColorToMoveMonoMap,
    lppNotes, lppNoteValueMap,
    moveControlToLppNoteMapTop, lppNoteToMoveControlMapTop,
    moveControlToLppNoteMapBottom, lppNoteToMoveControlMapBottom,
    lppPadToMovePadMapTop, moveToLppPadMapTop,
    lppPadToMovePadMapBottom, moveToLppPadMapBottom,
    sendMovePad, sendMoveControl, sendExternalMidi, aftertouchToModwheel,
} from './midi_utils.mjs';

/* ── Bank aliases ────────────────────────────────────────────────────────── */

const BANK_M8_TRACK  = POT_BANKS.M8_TRACK;
const BANK_M8_MASTER = POT_BANKS.M8_MASTER;
const BANK_M8_FX     = POT_BANKS.M8_FX;
const BANK_ABLETON   = POT_BANKS.ABLETON;

function isM8Bank(bank) {
    return bank === BANK_M8_TRACK || bank === BANK_M8_MASTER || bank === BANK_M8_FX;
}

/* ── Custom device banks ─────────────────────────────────────────────────── */

const CUSTOM_BANKS_PATH = '/data/UserData/movemap/config/custom_banks.json';

let customBanks = [];

function loadCustomBanks() {
    try {
        const raw = typeof host_read_file !== 'undefined' ? host_read_file(CUSTOM_BANKS_PATH) : null;
        if (raw) customBanks = JSON.parse(raw);
    } catch (_) {
        customBanks = [];
    }
    for (const bank of customBanks) {
        // Support both flat { knobs } and multi-page { pages } schemas (backward compatible).
        const initialKnobs = (bank.pages ? (bank.pages[0]?.knobs ?? []) : (bank.knobs ?? []));
        configurePotBank(bank.id, {
            channel: bank.channel,
            volumeCcs: initialKnobs.map(k => k.cc),
        });
    }
}

function isCustomBank(bank) {
    return customBanks.some(b => b.id === bank);
}

function getCustomBank(bank) {
    return customBanks.find(b => b.id === bank) ?? null;
}

// Returns the active page object { name, knobs } for a bank.
// Falls back to a synthetic page from flat bank.knobs for backward compatibility.
function getActivePage(bankObj) {
    if (!bankObj) return { knobs: [] };
    if (!bankObj.pages) return { knobs: bankObj.knobs ?? [] };
    const idx = Math.min(activePage[bankObj.id] ?? 0, bankObj.pages.length - 1);
    return bankObj.pages[idx] ?? { knobs: [] };
}

// Built after loadCustomBanks() — fixed banks first, then custom, then ABLETON at end.
let BANK_ORDER = [BANK_M8_TRACK, BANK_M8_MASTER, BANK_M8_FX, BANK_ABLETON];

function buildBankOrder() {
    const m8Banks = movemapConfig.m8Enabled ? [BANK_M8_TRACK, BANK_M8_MASTER, BANK_M8_FX] : [];
    BANK_ORDER = [...m8Banks, ...customBanks.map(b => b.id), BANK_ABLETON];
}

/* ── YURS / Ableton config ───────────────────────────────────────────────── */

const { yursProfile, clipWarningThreshold } = movemapConfig;

configurePotBank(POT_BANKS.ABLETON, {
    channel: yursProfile.midiChannel,
    volumeCcs: yursProfile.ccs.volume,
    sendACcs: yursProfile.ccs.sendA,
    masterCc: yursProfile.ccs.masterVolume,
    returnCc: yursProfile.ccs.returnVolume,
    encoderMode: yursProfile.encoderMode,
});

const abletonState = {
    volumes:      new Array(8).fill(64),
    sendsA:       new Array(8).fill(0),
    mutes:        new Array(8).fill(false),
    solos:        new Array(8).fill(false),
    arms:         new Array(8).fill(false),
    masterVolume: 64,
    returnVolume: 0,
    macros:       new Array(8).fill(0)
};

const abletonColors = {
    muteOn:      red,
    muteOff:     light_grey,
    muteClip:    lemonade,
    soloOn:      lime,
    soloOff:     dim_grey,
    armOn:       aqua,
    armOff:      dim_grey,
    bankM8:      green,
    bankAbleton: azure,
    panic:       red
};

const bankIndicatorNote = 31; // rightmost step LED

/* ── Module state ────────────────────────────────────────────────────────── */

let showingTop        = true;
let activeBank        = BANK_M8_TRACK;
let abletonDeviceMode = false;
let selectedTrackIndex = 0;
let shiftHeld         = false;
let liveMode          = false;
let isPlaying         = false;
let currentView       = moveBACK;
let wheelClicked      = false;
let abletonMacroValues = new Array(8).fill(0);
let sysexBuffer       = [];

// Track → custom bank bindings: { "0": "juno-60", "1": "dx7", ... }
let trackBankBindings = {};

// Active page per custom bank: { [bankId]: pageIndex }
let activePage = {};

// Knob value overlay: set when a knob is touched or turned in a custom bank.
// { potIndex, clearAt } — clearAt is a tick count after which overlay redraws the label grid.
let knobOverlay = null;
let tickCount   = 0;
const OVERLAY_TICKS = 88; // ~2 seconds at 44 ticks/sec

setPotBank(activeBank);

/* ── Progressive LED queue ───────────────────────────────────────────────── */

const LEDS_PER_FRAME = 8;
let ledQueue = [];

function drainLedQueue() {
    const count = Math.min(LEDS_PER_FRAME, ledQueue.length);
    for (let i = 0; i < count; i++) {
        ledQueue.shift()();
    }
}

function buildClearQueue() {
    ledQueue = [];
    for (let note = 16; note <= 31; note++) {
        ledQueue.push(() => sendMovePad(note, 0));
    }
    for (const row of moveGridRows) {
        for (const note of row) {
            ledQueue.push(() => sendMovePad(note, 0));
        }
    }
    const controls = [moveSHIFT, moveMENU, moveBACK, moveCAP, movePLAY, moveREC,
                      moveLOOP, moveMUTE, moveUNDO, moveSAMPLE, moveLOGO];
    for (const cc of controls) {
        ledQueue.push(() => sendMoveControl(cc, 0));
    }
    for (const cc of moveKnobCcs) {
        ledQueue.push(() => sendMoveControl(cc, 0));
    }
}

function buildM8BankQueue() {
    for (const data of lppNoteValueMap.values()) {
        if (data[0] === 0 && data[1] === 0 && data[2] === 0) continue;
        const d = data;
        ledQueue.push(() => handleM8ExternalMessage(d));
    }
    ledQueue.push(() => updateMoveViewPulse());
    ledQueue.push(() => updatePLAYLed());
    ledQueue.push(() => drawBankIndicator());
}

function buildAbletonBankQueue() {
    for (let i = 0; i < 8; i++) {
        const idx = i;
        ledQueue.push(() => updateAbletonMuteLed(idx));
        ledQueue.push(() => updateAbletonSoloLed(idx));
        ledQueue.push(() => updateAbletonArmLed(idx));
    }
    for (let i = 0; i < moveKnobCcs.length; i++) {
        const idx = i;
        ledQueue.push(() => {
            const vals = shiftHeld ? abletonState.sendsA : abletonState.volumes;
            if (idx < 8) sendMoveControl(moveKnobCcs[idx], vals[idx]);
            else if (moveKnobCcs[idx] !== undefined) {
                sendMoveControl(moveKnobCcs[idx], shiftHeld ? abletonState.returnVolume : abletonState.masterVolume);
            }
        });
    }
    ledQueue.push(() => sendMoveControl(moveMUTE, abletonColors.panic));
    ledQueue.push(() => drawBankIndicator());
}

/* ── Ableton send helpers ────────────────────────────────────────────────── */

function sendAbletonCC(cc, value) {
    sendExternalMidi(0xb0 | yursProfile.midiChannel, cc, clampMidi(value));
}

function sendAbletonMacroCC(index, value) {
    const macroCcs = yursProfile.ccs.macros ?? [];
    if (index < 0 || index >= macroCcs.length) return;
    sendAbletonCC(macroCcs[index], value);
}

function sendAbletonNote(note, pressed) {
    const status = (pressed ? 0x90 : 0x80) | yursProfile.midiChannel;
    const velocity = pressed ? yursProfile.feedback.noteOn : yursProfile.feedback.noteOff;
    sendExternalMidi(status, note, clampMidi(velocity));
}

/* ── Display helpers ─────────────────────────────────────────────────────── */

function drawAbletonMacroDisplay() {
    if (!abletonDeviceMode) return;
    if (typeof clear_screen !== "function" || typeof print !== "function") return;
    clear_screen();
    print(0, 0, `Ableton Dev T${selectedTrackIndex + 1}`, 1);
    for (let i = 0; i < 8; i++) {
        const line = Math.floor(i / 4);
        const col  = i % 4;
        print(col * 30, 16 + line * 16, `M${i + 1}:${abletonMacroValues[i].toString().padStart(3, " ")}`, 1);
    }
}

function drawCustomBankDisplay() {
    const bankObj = getCustomBank(activeBank);
    if (!bankObj) return;
    if (typeof clear_screen !== 'function' || typeof print !== 'function') return;
    const page = getActivePage(bankObj);
    clear_screen();
    // Line 0: bank name + either page indicator (multi-page) or channel number
    if (bankObj.pages && bankObj.pages.length > 1) {
        const pageIdx = (activePage[bankObj.id] ?? 0) + 1;
        const pageTotal = bankObj.pages.length;
        print(0, 0, `${bankObj.name.slice(0, 8)}  [${pageIdx}/${pageTotal}]`, 1);
    } else {
        print(0, 0, `${bankObj.name.slice(0, 12)}  ch${bankObj.channel + 1}`, 1);
    }
    // Lines 1-4: knob labels in 2-column layout
    for (let i = 0; i < page.knobs.length && i < 8; i++) {
        const row = Math.floor(i / 2);
        const col = i % 2;
        print(col * 64, 10 + row * 13, `${i + 1}:${page.knobs[i].label}`, 1);
    }
    // Knob 9 (index 8) on its own line if present
    if (page.knobs.length >= 9) {
        print(0, 10 + 4 * 13, `9:${page.knobs[8].label}`, 1);
    }
}

function showKnobOverlay(potIndex) {
    knobOverlay = { potIndex, clearAt: tickCount + OVERLAY_TICKS };
    const bankObj = getCustomBank(activeBank);
    if (!bankObj || typeof clear_screen !== 'function' || typeof print !== 'function') return;
    const page = getActivePage(bankObj);
    const knob = page.knobs[potIndex];
    if (!knob) return;
    const value = getPotValue(activeBank, potIndex);
    clear_screen();
    print(0, 0, bankObj.name.slice(0, 12), 1);
    print(0, 20, knob.label, 1);
    // Value bar: fill proportional to value/127 across 120px
    const barW = Math.round((value / 127) * 120);
    if (typeof fill_rect === 'function') {
        fill_rect(0, 40, barW, 8, 1);
        fill_rect(barW, 40, 120 - barW, 8, 0);
    }
    print(0, 52, `CC${knob.cc}  ${value}`, 1);
}

/* ── LED draw functions ──────────────────────────────────────────────────── */

function drawBankIndicator() {
    let color;
    if (isM8Bank(activeBank))   color = abletonColors.bankM8;
    else if (isCustomBank(activeBank)) color = lime;
    else                        color = abletonColors.bankAbleton;
    sendMovePad(bankIndicatorNote, color);
}

function updateMoveViewPulse() {
    sendMoveControl(moveBACK,  dim_grey);
    sendMoveControl(moveMENU,  dim_grey);
    sendMoveControl(moveCAP,   dim_grey);
    sendMoveControl(currentView, light_grey);
    if (!showingTop) {
        move_midi_internal_send([0 << 4 | 0xb, 0xBA, currentView, black]);
    }
}

function updatePLAYLed() {
    if (!liveMode && !isPlaying) { sendMoveControl(movePLAY, light_grey); return; }
    if (!liveMode &&  isPlaying) { sendMoveControl(movePLAY, green);      return; }
    if ( liveMode && !isPlaying) { sendMoveControl(movePLAY, sky);        return; }
    if ( liveMode &&  isPlaying) { sendMoveControl(movePLAY, navy);       return; }
}

function updateAbletonMuteLed(index) {
    let color = abletonState.mutes[index] ? abletonColors.muteOn : abletonColors.muteOff;
    if (!abletonState.mutes[index] && abletonState.volumes[index] >= clipWarningThreshold) {
        color = abletonColors.muteClip;
    }
    sendMovePad(moveGridRows[0][index], color);
}

function updateAbletonSoloLed(index) {
    const color = abletonState.solos[index] ? abletonColors.soloOn : abletonColors.soloOff;
    sendMovePad(moveGridRows[1][index], color);
}

function updateAbletonArmLed(index) {
    const color = abletonState.arms[index] ? abletonColors.armOn : abletonColors.armOff;
    sendMovePad(moveGridRows[2][index], color);
}

function updateAbletonEncoderIndicators() {
    if (abletonDeviceMode) {
        for (let i = 0; i < 8; i++) sendMoveControl(moveKnobCcs[i], abletonMacroValues[i]);
        return;
    }
    const values = shiftHeld ? abletonState.sendsA : abletonState.volumes;
    for (let i = 0; i < 8; i++) sendMoveControl(moveKnobCcs[i], values[i]);
    const masterValue = shiftHeld ? abletonState.returnVolume : abletonState.masterVolume;
    if (moveKnobCcs[9] !== undefined) sendMoveControl(moveKnobCcs[9], masterValue);
}

/* ── LPP init ────────────────────────────────────────────────────────────── */

function initLPP() {
    const out_cable = 2;
    // Source: [LPP3] §2.1 — Universal Device Inquiry SysEx (F0 7E 7F 06 01 F7),
    // packed into USB-MIDI cable 2 using 4-byte packet format per USB-MIDI spec.
    // The M8 listens for this to confirm Launchpad Pro presence before entering
    // LPP control surface mode.
    const LPPInitSysex = [
        out_cable << 4 | 0x4, 0xF0, 126, 0,
        out_cable << 4 | 0x4, 6, 2, 0,
        out_cable << 4 | 0x4, 32, 41, 0x00,
        out_cable << 4 | 0x4, 0x00, 0x00, 0x00,
        out_cable << 4 | 0x4, 0x00, 0x00, 0x00,
        out_cable << 4 | 0x6, 0x00, 0xF7, 0x0
    ];
    console.log("MoveMap: sending LPP init");
    move_midi_external_send(LPPInitSysex);
    showingTop = true;
}

/* ── Bank switching ──────────────────────────────────────────────────────── */

function releaseM8Shift() {
    const lppShiftNote = moveControlToLppNoteMapTop.get(moveSHIFT);
    if (lppShiftNote !== undefined) sendExternalMidi(0x80, lppShiftNote, 0);
}

function resetModifiersForBankSwitch() {
    // Don't reset shiftHeld — hardware Shift state is tracked by CC 49 events.
    // If the user is holding Shift while cycling banks, it stays held.
    wheelClicked = false;
    showingTop   = true;
    setPotShiftHeld(shiftHeld);
}

function setActiveBank(nextBank) {
    if (activeBank === nextBank) return;

    if (isM8Bank(activeBank) && shiftHeld) releaseM8Shift();

    activeBank = nextBank;
    setPotBank(nextBank);
    setParam('activeBank', nextBank);
    resetModifiersForBankSwitch();

    // Build a queued transition: clear all LEDs, then redraw new bank
    buildClearQueue();

    if (isM8Bank(activeBank)) {
        ledQueue.push(() => initLPP());
        buildM8BankQueue();
    } else if (isCustomBank(activeBank)) {
        ledQueue.push(() => {
            drawCustomBankDisplay();
            drawBankIndicator();
        });
    } else {
        ledQueue.push(() => {
            abletonDeviceMode = false;
            if (typeof clear_screen === "function") clear_screen();
        });
        buildAbletonBankQueue();
    }

    knobOverlay = null; // clear any value overlay on bank change
    console.log(`MoveMap: active bank → ${activeBank}`);
}

/* ── Track-bank bindings ─────────────────────────────────────────────────── */

function bindTrackToCurrentBank(trackIndex) {
    const key = String(trackIndex);
    if (trackBankBindings[key] === activeBank) {
        // Toggle: unbind
        delete trackBankBindings[key];
        setParam('trackBankBindings', JSON.stringify(trackBankBindings));
        showBindingFeedback(trackIndex, null);
    } else {
        trackBankBindings[key] = activeBank;
        setParam('trackBankBindings', JSON.stringify(trackBankBindings));
        showBindingFeedback(trackIndex, activeBank);
    }
}

function showBindingFeedback(trackIndex, bankId) {
    if (typeof clear_screen !== 'function' || typeof print !== 'function') return;
    knobOverlay = { potIndex: -1, clearAt: tickCount + OVERLAY_TICKS };
    clear_screen();
    if (bankId) {
        const bank = getCustomBank(bankId);
        print(0, 0,  'Bound', 1);
        print(0, 16, `T${trackIndex + 1} → ${bank ? bank.name.slice(0, 10) : bankId}`, 1);
    } else {
        print(0, 0,  'Unbound', 1);
        print(0, 16, `T${trackIndex + 1}`, 1);
    }
}

// Called when track selection changes (Ableton bank or custom bank).
// Auto-switches to the bound custom bank if one exists.
function onTrackSelected(trackIndex) {
    selectedTrackIndex = trackIndex;
    setPotTrack(trackIndex);
    setParam('selectedTrackIndex', trackIndex);

    if (isM8Bank(activeBank)) return; // never auto-switch out of M8 mode

    const bound = trackBankBindings[String(trackIndex)];
    if (bound && bound !== activeBank && BANK_ORDER.includes(bound)) {
        setActiveBank(bound);
    }
}

/* ── Ableton device mode ─────────────────────────────────────────────────── */

function setAbletonDeviceMode(enabled) {
    abletonDeviceMode = enabled;
    updateAbletonEncoderIndicators();
    if (abletonDeviceMode) {
        drawAbletonMacroDisplay();
    } else if (typeof clear_screen === "function") {
        clear_screen();
    }
}

/* ── Utility ─────────────────────────────────────────────────────────────── */

function findIndex(list, value) {
    for (let i = 0; i < list.length; i++) {
        if (list[i] === value) return i;
    }
    return -1;
}

function arraysAreEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function mapYursColor(velocity) {
    return lppColorToMoveColorMap.get(velocity) ?? velocity;
}

function updateEncoderValue(currentValue, rawValue) {
    const delta = decodeMoveKnobDelta(rawValue);
    if (delta !== 0) return clampMidi(currentValue + delta);
    return clampMidi(rawValue);
}

function updateSelectedTrack(index) {
    onTrackSelected(clamp(index, 0, 7));
}

function updateMovePadsToMatchLpp() {
    const activeMoveToLppPadMap = showingTop ? moveToLppPadMapTop : moveToLppPadMapBottom;
    for (const [, lppPad] of activeMoveToLppPadMap.entries()) {
        const data = lppNoteValueMap.get(lppPad);
        handleM8ExternalMessage(data);
    }
}

/* ── External message handlers ───────────────────────────────────────────── */

// Source: [MIDI] — standard Universal Device Inquiry identity request.
// The M8 sends this on connect; MoveMap watches for it to re-send the LPP
// handshake if the M8 was plugged in after the module loaded.
const m8InitSysex = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

function handleM8ExternalMessage(data) {
    if (!data || data[0] === 0xf8) return; // ignore MIDI clock

    const value      = data[0];
    const maskedValue = value & 0xf0;
    const noteOn     = maskedValue === 0x90;
    const noteOff    = maskedValue === 0x80;

    // Sysex accumulator (QuickJS delivers sysex as 3-byte slices)
    const sysexStart = value === 0xF0;
    const sysexEnd   = data[2] === 0xF7;

    if (sysexStart) {
        sysexBuffer = [...data];
        return;
    }
    if (sysexBuffer.length && !sysexEnd) {
        sysexBuffer.push(...data);
        return;
    }
    if (sysexEnd) {
        sysexBuffer.push(...data);
        if (arraysAreEqual(sysexBuffer, m8InitSysex)) initLPP();
        sysexBuffer = [];
        return;
    }

    if (!(noteOn || noteOff)) return;

    const lppNoteNumber = data[1];
    const lppVelocity   = data[2];

    lppNoteValueMap.set(lppNoteNumber, [...data]);

    const activeLppToMovePadMap = showingTop ? lppPadToMovePadMapTop : lppPadToMovePadMapBottom;
    const moveNoteNumber = activeLppToMovePadMap.get(lppNoteNumber);
    const moveVelocity   = lppColorToMoveColorMap.get(lppVelocity) ?? lppVelocity;

    if (moveNoteNumber) {
        if (value === 0x91 && moveVelocity !== 0) {
            move_midi_internal_send([0 << 4 | (value / 16), 0x9f, moveNoteNumber, moveVelocity]);
        } else {
            move_midi_internal_send([0 << 4 | (maskedValue / 16), maskedValue, moveNoteNumber, moveVelocity]);
            if (value === 0x92 && moveVelocity !== 0) {
                move_midi_internal_send([0 << 4 | (value / 16), 0x9a, moveNoteNumber, light_grey]);
            }
        }
        return;
    }

    const activeLppToMoveControlMap = showingTop ? lppNoteToMoveControlMapTop : lppNoteToMoveControlMapBottom;
    const moveControlNumber = activeLppToMoveControlMap.get(lppNoteNumber);

    if (moveControlNumber === moveLOGO) {
        liveMode = moveVelocity > 0;
        updatePLAYLed();
        return;
    }
    if (moveControlNumber === movePLAY) {
        isPlaying = moveVelocity === green;
        updatePLAYLed();
        return;
    }

    // Mono-color overrides for certain controls
    let finalVelocity = moveVelocity;
    if (moveControlNumber === moveLOOP || moveControlNumber === moveMUTE || moveControlNumber === moveUNDO) {
        finalVelocity = lppColorToMoveMonoMap.get(lppVelocity) ?? lppVelocity;
    }

    if (moveControlNumber) {
        move_midi_internal_send([0 << 4 | 0xb, 0xB0, moveControlNumber, finalVelocity]);
        if (value === 0x91) {
            move_midi_internal_send([0 << 4 | 0xb, 0xbe, moveControlNumber, black]);
        }
    }
}

function handleAbletonExternalMessage(data) {
    if (!data || data[0] === 0xf8) return;

    const status  = data[0];
    const type    = status & 0xf0;
    const channel = status & 0x0f;

    if (channel !== yursProfile.midiChannel) return;

    if (type === 0xb0) {
        const cc    = data[1];
        const value = clampMidi(data[2]);

        let index = findIndex(yursProfile.ccs.volume, cc);
        if (index !== -1) {
            abletonState.volumes[index] = value;
            updateAbletonMuteLed(index);
            if (!shiftHeld) sendMoveControl(moveKnobCcs[index], value);
            return;
        }

        index = findIndex(yursProfile.ccs.sendA, cc);
        if (index !== -1) {
            abletonState.sendsA[index] = value;
            if (shiftHeld) sendMoveControl(moveKnobCcs[index], value);
            return;
        }

        if (cc === yursProfile.ccs.masterVolume) {
            abletonState.masterVolume = value;
            if (!shiftHeld && moveKnobCcs[9] !== undefined) sendMoveControl(moveKnobCcs[9], value);
            return;
        }

        if (cc === yursProfile.ccs.returnVolume) {
            abletonState.returnVolume = value;
            if (shiftHeld && moveKnobCcs[9] !== undefined) sendMoveControl(moveKnobCcs[9], value);
            return;
        }

        index = findIndex(yursProfile.ccs.macros, cc);
        if (index !== -1) {
            abletonMacroValues[index] = value;
            if (abletonDeviceMode) {
                sendMoveControl(moveKnobCcs[index], value);
                drawAbletonMacroDisplay();
            }
            return;
        }
    }

    if (type === 0x90 || type === 0x80) {
        const note     = data[1];
        const velocity = data[2];
        const pressed  = type === 0x90 && velocity > 0;

        // LED color feedback from Live
        let rowIndex = -1;
        let colIndex = -1;
        for (let i = 0; i < moveGridRows.length; i++) {
            const idx = findIndex(moveGridRows[i], note);
            if (idx !== -1) { rowIndex = i; colIndex = idx; break; }
        }
        if (rowIndex !== -1) sendMovePad(moveGridRows[rowIndex][colIndex], mapYursColor(velocity));

        let index = findIndex(yursProfile.notes.mute, note);
        if (index !== -1) {
            abletonState.mutes[index] = pressed;
            updateAbletonMuteLed(index);
            return;
        }
        index = findIndex(yursProfile.notes.solo, note);
        if (index !== -1) {
            abletonState.solos[index] = pressed;
            updateAbletonSoloLed(index);
            return;
        }
        index = findIndex(yursProfile.notes.arm, note);
        if (index !== -1) {
            abletonState.arms[index] = pressed;
            updateAbletonArmLed(index);
            return;
        }
    }
}

/* ── Internal message handlers ───────────────────────────────────────────── */

function handleM8InternalMessage(data) {
    const isNote = data[0] === 0x80 || data[0] === 0x90;
    const isCC   = data[0] === 0xb0;
    const isAt   = data[0] === 0xa0;

    if (isAt) {
        aftertouchToModwheel(data);
        return;
    }

    if (!(isNote || isCC)) return;

    if (isNote) {
        const activeMoveToLppPadMap = showingTop ? moveToLppPadMapTop : moveToLppPadMapBottom;
        const moveNoteNumber = data[1];

        // Track selection via step buttons (notes 16–31, every other note = track)
        const trackOffset = moveNoteNumber - moveTRACK1;
        if (trackOffset >= 0 && trackOffset <= 20 && data[2] > 0) {
            const trackIndex = Math.floor(trackOffset / 2);
            if (trackIndex >= 0 && trackIndex <= 7) setPotTrack(trackIndex);
        }

        // Wheel touch: toggle top/bottom view
        if (moveNoteNumber === moveWHEELTouch && data[2] === 127) {
            showingTop = !showingTop;
            updateMovePadsToMatchLpp();
            updateMoveViewPulse();
            return;
        }
        if (moveNoteNumber === moveWHEELTouch && data[2] === 0) {
            if (!wheelClicked) {
                showingTop = !showingTop;
                updateMovePadsToMatchLpp();
                updateMoveViewPulse();
            }
            wheelClicked = false;
            return;
        }

        const lppNote = activeMoveToLppPadMap.get(moveNoteNumber);
        if (!lppNote) return;

        let moveVelocity = clampMidi(data[2] * 2);
        sendExternalMidi(data[0], lppNote, moveVelocity);
        return;
    }

    if (isCC) {
        const moveControlNumber = data[1];
        const activeMoveControlToLppNoteMap = showingTop ? moveControlToLppNoteMapTop : moveControlToLppNoteMapBottom;
        const lppNote = activeMoveControlToLppNoteMap.get(moveControlNumber);

        // Track the active view button
        if (moveControlNumber === moveBACK || moveControlNumber === moveMENU || moveControlNumber === moveCAP) {
            currentView = moveControlNumber;
            updateMoveViewPulse();
        }

        // Wheel click: flag for top/bottom toggle suppression
        if (moveControlNumber === moveWHEEL && data[2] === 0x7f) {
            wheelClicked = true;
            return;
        }

        if (!lppNote) {
            handleMoveKnobs(data);
            return;
        }

        const pressed = data[2] === 127;
        sendExternalMidi(pressed ? 0x90 : 0x80, lppNote, pressed ? 100 : 0);
    }
}

function handleAbletonInternalMessage(data) {
    const status = data[0];
    const type   = status & 0xf0;

    if (type === 0x90 || type === 0x80) {
        const note     = data[1];
        const velocity = data[2];
        const pressed  = type === 0x90 && velocity > 0;

        if (note < 10) return;

        let rowIndex = -1;
        let colIndex = -1;
        for (let i = 0; i < moveGridRows.length; i++) {
            const index = findIndex(moveGridRows[i], note);
            if (index !== -1) { rowIndex = i; colIndex = index; break; }
        }

        if (colIndex !== -1) updateSelectedTrack(colIndex);

        if (rowIndex === 0) {
            sendAbletonNote(yursProfile.notes.mute[colIndex], pressed);
            if (pressed) {
                abletonState.mutes[colIndex] = !abletonState.mutes[colIndex];
                updateAbletonMuteLed(colIndex);
            }
            return;
        }
        if (rowIndex === 1) {
            sendAbletonNote(yursProfile.notes.solo[colIndex], pressed);
            if (pressed) {
                abletonState.solos[colIndex] = !abletonState.solos[colIndex];
                updateAbletonSoloLed(colIndex);
            }
            return;
        }
        if (rowIndex === 2) {
            sendAbletonNote(yursProfile.notes.arm[colIndex], pressed);
            if (pressed) {
                abletonState.arms[colIndex] = !abletonState.arms[colIndex];
                updateAbletonArmLed(colIndex);
            }
            return;
        }
        return;
    }

    if (type === 0xb0) {
        const controlNumber = data[1];
        const value         = data[2];

        // Panic: Mute button clears master volume
        if (!abletonDeviceMode && controlNumber === moveMUTE && value === 0x7f) {
            abletonState.masterVolume = 0;
            sendAbletonCC(yursProfile.ccs.masterVolume, 0);
            updateAbletonEncoderIndicators();
            return;
        }

        // Device macro mode: knobs control macros
        const knobIndex = findIndex(moveKnobCcs, controlNumber);
        if (abletonDeviceMode && knobIndex !== -1) {
            if (knobIndex < 8) {
                const nextValue = updateEncoderValue(abletonMacroValues[knobIndex], value);
                abletonMacroValues[knobIndex] = nextValue;
                sendAbletonMacroCC(knobIndex, nextValue);
                sendMoveControl(moveKnobCcs[knobIndex], nextValue);
                drawAbletonMacroDisplay();
            }
            return;
        }

        const knobHandled = handleMoveKnobs(data, { activeBank: BANK_ABLETON, shiftHeld });
        if (knobHandled && knobHandled.handled) {
            const potIndex = knobHandled.potIndex ?? -1;
            if (potIndex >= 0 && potIndex < 8) {
                if (shiftHeld) abletonState.sendsA[potIndex] = knobHandled.value;
                else           abletonState.volumes[potIndex] = knobHandled.value;
                updateAbletonMuteLed(potIndex);
            } else if (potIndex === 8) {
                if (shiftHeld) abletonState.returnVolume = knobHandled.value;
                else           abletonState.masterVolume = knobHandled.value;
            }
            updateAbletonEncoderIndicators();
        }
    }
}

/* ── Exported module lifecycle ───────────────────────────────────────────── */

globalThis.init = function () {
    console.log("MoveMap: init");

    // Load custom device banks before restoring state (persisted bank may be a custom ID).
    loadCustomBanks();
    buildBankOrder();

    // Restore persisted state (bank, track, bindings, page).
    loadParams();
    const fallbackBank = BANK_ORDER[0] ?? BANK_ABLETON;
    const savedBank = getParam('activeBank', fallbackBank);
    // Validate: if a saved bank was removed (e.g. custom bank deleted), fall back gracefully.
    activeBank = BANK_ORDER.includes(savedBank) ? savedBank : fallbackBank;
    selectedTrackIndex = getParam('selectedTrackIndex', 0);

    try {
        const savedBindings = getParam('trackBankBindings', '{}');
        trackBankBindings = JSON.parse(savedBindings);
    } catch (_) { trackBankBindings = {}; }

    try {
        const savedActivePage = getParam('activePage', '{}');
        activePage = JSON.parse(savedActivePage);
    } catch (_) { activePage = {}; }

    // Re-apply any non-zero saved pages so configurePotBank has the right CCs.
    for (const bank of customBanks) {
        const pi = activePage[bank.id] ?? 0;
        if (pi > 0 && bank.pages && bank.pages[pi]) {
            configurePotBank(bank.id, { volumeCcs: bank.pages[pi].knobs.map(k => k.cc) });
        }
    }

    setPotBank(activeBank);
    setPotTrack(selectedTrackIndex);

    // Host has already cleared all LEDs. Draw the current bank.
    drawBankIndicator();
    if (isCustomBank(activeBank)) {
        drawCustomBankDisplay();
    } else {
        initLPP();
    }
};

globalThis.tick = function () {
    tickCount++;
    if (ledQueue.length > 0) {
        drainLedQueue();
    }
    // Clear knob overlay when timer expires
    if (knobOverlay && tickCount >= knobOverlay.clearAt) {
        knobOverlay = null;
        if (isCustomBank(activeBank)) drawCustomBankDisplay();
    }
};

globalThis.onMidiMessageExternal = function (data) {
    if (isM8Bank(activeBank)) {
        handleM8ExternalMessage(data);
    } else if (!isCustomBank(activeBank)) {
        handleAbletonExternalMessage(data);
    }
};

globalThis.onMidiMessageInternal = function (data) {
    const isCC   = data[0] === 0xb0;
    const isNote = data[0] === 0x80 || data[0] === 0x90;

    // Shift tracking (always, regardless of bank)
    if (isCC && data[1] === moveSHIFT) {
        const nextShift = data[2] === 127;
        shiftHeld = nextShift;
        setPotShiftHeld(shiftHeld);
        if (activeBank === BANK_ABLETON) updateAbletonEncoderIndicators();
    }

    // Shift+Capture → Ableton device mode toggle (Ableton bank only)
    if (activeBank === BANK_ABLETON && isCC && data[1] === moveCAP && data[2] === 0x7f && shiftHeld) {
        setAbletonDeviceMode(!abletonDeviceMode);
        return;
    }

    // Shift+Menu → cycle through all banks in order
    if (isCC && data[1] === moveMENU && data[2] === 0x7f && shiftHeld) {
        const idx = BANK_ORDER.indexOf(activeBank);
        const nextBank = BANK_ORDER[(idx + 1) % BANK_ORDER.length];
        setActiveBank(nextBank);
        return;
    }

    if (isM8Bank(activeBank)) {
        handleM8InternalMessage(data);
        return;
    }

    if (isCustomBank(activeBank)) {
        if (isCC) {
            // Shift+Jog click → advance page (multi-page banks only)
            if (data[1] === moveWHEEL && data[2] === 0x7f && shiftHeld) {
                const bankObj = getCustomBank(activeBank);
                if (bankObj && bankObj.pages && bankObj.pages.length > 1) {
                    const current = activePage[activeBank] ?? 0;
                    activePage[activeBank] = (current + 1) % bankObj.pages.length;
                    const newPage = getActivePage(bankObj);
                    configurePotBank(activeBank, { volumeCcs: newPage.knobs.map(k => k.cc) });
                    setParam('activePage', JSON.stringify(activePage));
                    knobOverlay = null;
                    drawCustomBankDisplay();
                    drawBankIndicator();
                }
                return;
            }
            // Track buttons (CC 40–43, reversed: CC43=T1 CC40=T4)
            const trackCCs = [43, 42, 41, 40];
            const tIdx = trackCCs.indexOf(data[1]);
            if (tIdx !== -1 && data[2] === 0x7f) {
                if (shiftHeld) {
                    bindTrackToCurrentBank(tIdx);
                } else {
                    onTrackSelected(tIdx);
                }
                return;
            }
            // Knob turn → send CC + show value overlay
            const result = handleMoveKnobs(data, { activeBank });
            if (result && result.handled) {
                showKnobOverlay(result.potIndex);
            }
        }
        // Knob capacitive touch (notes 0–8) → show current value overlay
        if (isNote && data[0] === 0x90 && data[1] >= 0 && data[1] <= 8) {
            showKnobOverlay(data[1]);
        }
        return;
    }

    if (!isNote && !isCC) return;
    handleAbletonInternalMessage(data);
};
