/*
 * MoveMap — parameter persistence layer
 *
 * Today (1.x): reads/writes a JSON file on the device using host_read_file /
 * host_write_file. State is stored at STATE_PATH on the Move's data partition.
 *
 * 2.0 migration: when Move Everything 2.0 ships with params.json support,
 * replace the three exported functions with:
 *
 *   export function loadParams() {}  // framework restores automatically
 *   export function getParam(key, fallback) { return host_module_get_param(key) ?? fallback; }
 *   export function setParam(key, value) { host_module_set_param(key, String(value)); }
 *
 * Nothing else in the module needs to change.
 *
 * Declared params (matches what params.json will declare in 2.0):
 *   activeBank         — enum: M8_TRACK | M8_MASTER | M8_FX | ABLETON
 *   selectedTrackIndex — int: 0–7
 */

const STATE_PATH = '/data/UserData/move-anything/modules/movemap/state.json';

let _state = {};

/**
 * Load persisted params from disk. Call once at init().
 * Safe to call in Node.js tests — host_read_file will be absent and state stays empty.
 */
export function loadParams() {
    // 2.0: nothing — framework restores params automatically before init() is called
    try {
        const raw = typeof host_read_file !== 'undefined' ? host_read_file(STATE_PATH) : null;
        if (raw) _state = JSON.parse(raw);
    } catch (_) {
        _state = {};
    }
}

/**
 * Get a persisted param value, or fallback if not set.
 * 2.0: return host_module_get_param(key) ?? fallback;
 */
export function getParam(key, fallback = null) {
    return key in _state ? _state[key] : fallback;
}

/**
 * Set a param and persist immediately.
 * Safe to call at high frequency only for low-frequency events (bank switch, track select).
 * 2.0: host_module_set_param(key, String(value));
 */
export function setParam(key, value) {
    _state[key] = value;
    _save();
}

function _save() {
    if (typeof host_write_file !== 'undefined') {
        host_write_file(STATE_PATH, JSON.stringify(_state));
    }
}
