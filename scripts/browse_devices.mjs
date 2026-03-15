#!/usr/bin/env node
/*
 * browse_devices.mjs — Interactive MIDI device bank builder for MoveMap
 *
 * Fetches device CC definitions from the pencilresearch/midi database
 * (https://github.com/pencilresearch/midi, CC BY-SA 4.0) and lets you
 * build custom knob banks that appear on the Ableton Move display.
 *
 * Usage:
 *   node scripts/browse_devices.mjs           # interactive browser
 *   node scripts/browse_devices.mjs --list    # list all manufacturers
 *
 * Output: appends a bank entry to src/config/custom_banks.json
 * Deploy:  bash scripts/build.sh
 */

import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CUSTOM_BANKS_PATH = join(REPO_ROOT, 'src', 'config', 'custom_banks.json');

const GITHUB_API  = 'https://api.github.com/repos/pencilresearch/midi/contents';
const RAW_BASE    = 'https://raw.githubusercontent.com/pencilresearch/midi/main';
const MAX_KNOBS   = 9;
const MAX_LABEL   = 8; // chars that fit on 128px display in a 2-col layout

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchJson(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'movemap-browser/1.0', 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.json();
}

async function fetchText(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': 'movemap-browser/1.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
}

// ── CSV parser ────────────────────────────────────────────────────────────────
// Handles quoted fields with embedded commas.

function parseCsvRow(line) {
    const fields = [];
    let current = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            inQuote = !inQuote;
        } else if (ch === ',' && !inQuote) {
            fields.push(current.trim());
            current = '';
        } else {
            current += ch;
        }
    }
    fields.push(current.trim());
    return fields;
}

function parseCsv(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    // First line is header
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const f = parseCsvRow(lines[i]);
        if (f.length < 9) continue;
        const ccMsb = parseInt(f[5], 10);
        if (isNaN(ccMsb)) continue; // skip NRPN-only rows
        rows.push({
            section:      f[2] || 'General',
            name:         f[3] || '',
            description:  f[4] || '',
            cc:           ccMsb,
            min:          parseInt(f[7], 10) || 0,
            max:          parseInt(f[8], 10) || 127,
            defaultVal:   parseInt(f[9], 10) || 0,
            orientation:  f[15] || '0-based',
            usage:        f[17] || '',
        });
    }
    return rows;
}

// ── Terminal I/O ──────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt) {
    return new Promise(resolve => rl.question(prompt, answer => resolve(answer.trim())));
}

function askInt(prompt, min, max, fallback) {
    return new Promise(async resolve => {
        while (true) {
            const raw = await ask(prompt);
            if (raw === '' && fallback !== undefined) { resolve(fallback); return; }
            const n = parseInt(raw, 10);
            if (!isNaN(n) && n >= min && n <= max) { resolve(n); return; }
            console.log(`  Please enter a number between ${min} and ${max}.`);
        }
    });
}

function truncate(str, len) {
    return str.length > len ? str.slice(0, len) : str;
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function listManufacturers() {
    process.stdout.write('Fetching manufacturer list...');
    const entries = await fetchJson(GITHUB_API);
    const dirs = entries.filter(e => e.type === 'dir').map(e => e.name).sort();
    console.log(` ${dirs.length} found.\n`);
    return dirs;
}

async function listDevices(manufacturer) {
    process.stdout.write(`Fetching devices for ${manufacturer}...`);
    const entries = await fetchJson(`${GITHUB_API}/${encodeURIComponent(manufacturer)}`);
    const csvs = entries.filter(e => e.name.endsWith('.csv')).map(e => e.name.replace(/\.csv$/i, '')).sort();
    console.log(` ${csvs.length} found.\n`);
    return csvs;
}

async function fetchDeviceParams(manufacturer, device) {
    const url = `${RAW_BASE}/${encodeURIComponent(manufacturer)}/${encodeURIComponent(device)}.csv`;
    process.stdout.write(`Fetching ${device} CC map...`);
    const text = await fetchText(url);
    const params = parseCsv(text);
    console.log(` ${params.length} CC params.\n`);
    return { params, source: `${manufacturer}/${device}.csv` };
}

function displayParamList(params) {
    // Group by section
    const sections = {};
    for (const p of params) {
        if (!sections[p.section]) sections[p.section] = [];
        sections[p.section].push(p);
    }
    let idx = 1;
    const indexed = [];
    for (const [section, items] of Object.entries(sections)) {
        console.log(`\n  ── ${section} ──`);
        for (const p of items) {
            const usage = p.usage ? `  [${p.usage.slice(0, 30)}]` : '';
            console.log(`  ${String(idx).padStart(3)}. CC${p.cc.toString().padStart(3)}  ${p.name}${usage}`);
            indexed.push(p);
            idx++;
        }
    }
    return indexed;
}

async function pickKnobs(indexed) {
    const chosen = [];
    console.log(`\nAssign up to ${MAX_KNOBS} params to knobs (enter numbers, one per line, or "done"):`)
    for (let knob = 1; knob <= MAX_KNOBS; knob++) {
        const raw = await ask(`  Knob ${knob}> `);
        if (raw === '' || raw.toLowerCase() === 'done') break;
        const n = parseInt(raw, 10);
        if (isNaN(n) || n < 1 || n > indexed.length) {
            console.log('  (skipped — invalid number)');
            knob--;
            continue;
        }
        const param = indexed[n - 1];
        const defaultLabel = truncate(param.name.replace(/\s+/g, '').slice(0, MAX_LABEL), MAX_LABEL);
        const rawLabel = await ask(`  Label for knob ${knob} [${defaultLabel}]> `);
        const label = truncate((rawLabel || defaultLabel).replace(/\s+/g, ''), MAX_LABEL);
        chosen.push({ label, cc: param.cc, min: param.min, max: param.max });
        console.log(`  → Knob ${knob}: ${label} (CC ${param.cc})`);
    }
    return chosen;
}

async function run() {
    const listOnly = process.argv.includes('--list');

    console.log('\nMoveMap Device Bank Builder');
    console.log('Data: pencilresearch/midi (CC BY-SA 4.0)\n');

    const manufacturers = await listManufacturers();

    if (listOnly) {
        manufacturers.forEach((m, i) => console.log(`  ${String(i + 1).padStart(3)}. ${m}`));
        rl.close();
        return;
    }

    // Pick manufacturer
    console.log('Manufacturers:');
    manufacturers.forEach((m, i) => console.log(`  ${String(i + 1).padStart(3)}. ${m}`));
    const mIdx = await askInt('\nPick manufacturer number> ', 1, manufacturers.length);
    const manufacturer = manufacturers[mIdx - 1];

    // Pick device
    const devices = await listDevices(manufacturer);
    if (devices.length === 0) { console.log('No devices found.'); rl.close(); return; }
    console.log('Devices:');
    devices.forEach((d, i) => console.log(`  ${String(i + 1).padStart(3)}. ${d}`));
    const dIdx = await askInt('\nPick device number> ', 1, devices.length);
    const device = devices[dIdx - 1];

    // Fetch + display params
    const { params, source } = await fetchDeviceParams(manufacturer, device);
    if (params.length === 0) { console.log('No CC params found for this device.'); rl.close(); return; }
    const indexed = displayParamList(params);

    // Assign knobs
    const knobs = await pickKnobs(indexed);
    if (knobs.length === 0) { console.log('\nNo knobs assigned — nothing saved.'); rl.close(); return; }

    // Bank metadata
    const defaultName = truncate(device, 16);
    const rawName = await ask(`\nBank name [${defaultName}]> `);
    const name = rawName || defaultName;

    const rawCh = await ask(`MIDI channel (1–16) [1]> `);
    const channel = Math.max(1, Math.min(16, parseInt(rawCh, 10) || 1)) - 1; // 0-indexed

    // Generate safe ID
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // Load existing custom banks
    let banks = [];
    if (existsSync(CUSTOM_BANKS_PATH)) {
        try { banks = JSON.parse(readFileSync(CUSTOM_BANKS_PATH, 'utf8')); } catch (_) {}
    }

    // Remove any existing bank with the same id
    banks = banks.filter(b => b.id !== id);

    const entry = { id, name, source, channel, knobs };
    banks.push(entry);

    writeFileSync(CUSTOM_BANKS_PATH, JSON.stringify(banks, null, 2) + '\n', 'utf8');

    console.log(`\nBank '${name}' saved to src/config/custom_banks.json`);
    console.log(`  ${knobs.length} knobs assigned on MIDI channel ${channel + 1}`);
    console.log('\nNext step: bash scripts/build.sh');

    rl.close();
}

run().catch(err => {
    console.error('\nError:', err.message);
    rl.close();
    process.exit(1);
});
