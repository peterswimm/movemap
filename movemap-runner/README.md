# movemap-runner

A native JACK client that hosts the [MoveMap](../movemap) JS module on an Ableton Move running RNBO Takeover mode. It replaces the move-anything runtime with a direct JACK connection, making MoveMap resilient to Move firmware updates.

## What it does

- Loads `ui.mjs` and its dependencies into an embedded QuickJS runtime
- Injects the four host globals movemap expects (`move_midi_internal_send`, `move_midi_external_send`, `host_read_file`, `host_write_file`) as native JACK I/O
- Routes hardware MIDI (pads, buttons, encoders) to `onMidiMessageInternal()`
- Routes external MIDI (M8, USB hub devices) to `onMidiMessageExternal()`
- Bridges M8 USB audio directly to the Move's hardware audio output (direct copy in the JACK RT callback — no JS involvement)
- Auto-connects USB MIDI devices hot-plugged via a hub via JACK's port registration notification

## Architecture

```
Move hardware
  └── JACK2 (Cycling '74 custom fork — stable across Move firmware updates)
        ├── RNBO Runner              ← leave this alone
        └── movemap-runner           ← this binary
              ├── midi_in_internal   ← hardware buttons/pads/encoders
              ├── midi_in_external   ← M8 + USB hub devices (auto-connected)
              ├── midi_out_internal  → hardware LEDs/pads
              ├── midi_out_external  → USB MIDI out (M8 return, DAW)
              ├── audio_in_l/r       ← M8 USB audio
              └── audio_out_l/r      → Move hardware audio out
```

The JACK process callback is fully RT-safe: audio is a direct buffer copy, MIDI is passed through lock-free ring buffers to the QuickJS thread.

## Source layout

```
src/
  main.rs      — JACK client init, ring buffer setup, port registration
  midi.rs      — ProcessHandler: RT-safe MIDI routing (internal/external tagged)
  audio.rs     — AudioPorts: direct M8→Move buffer copy in RT callback
  js_host.rs   — QuickJS: injects globals, loads ui.mjs, event loop
  config.rs    — RunnerConfig: loads runner.json, defaults for port names
  notify.rs    — MidiAutoConnect: JACK notification handler for USB hot-plug
```

## Prerequisites

- Rust toolchain (1.70+)
- JACK2 development headers (for cross-compilation)
- `aarch64-unknown-linux-gnu` cross-compile target for the Move

On macOS (dev machine):
```bash
rustup target add aarch64-unknown-linux-gnu
brew install aarch64-unknown-linux-gnu  # or use cross
```

## Configuration

Place a `runner.json` in your module directory (`/data/UserData/movemap/` on device). All fields are optional — defaults are shown:

```json
{
  "internal_midi_port": "system:midi_capture_1",
  "external_midi_ports": [],
  "audio_src_l": "M8:out_1",
  "audio_src_r": "M8:out_2",
  "audio_dst_l": "system:playback_1",
  "audio_dst_r": "system:playback_2"
}
```

`external_midi_ports`: leave empty to auto-connect all non-system MIDI output ports (recommended for hub setups). Add port names to restrict to specific devices.

**To find the real port names on your device:**
```bash
ssh move@move.local
jack_lsp -A
```

## Building

```bash
# Dev build (macOS, for testing logic)
cargo build

# Release build for Move (ARM Linux)
cargo build --release --target aarch64-unknown-linux-gnu
```

## Deployment

```bash
# Copy JS module and config
ssh move@move.local mkdir -p /data/UserData/movemap/config
scp -r ../movemap/dist/movemap/* move@move.local:/data/UserData/movemap/

# Copy runner binary
scp target/aarch64-unknown-linux-gnu/release/movemap-runner move@move.local:/usr/local/bin/

# Run (Move must be in RNBO Takeover mode)
ssh move@move.local movemap-runner --module-dir /data/UserData/movemap
```

To run at startup, add a systemd service or configure via the RNBO Takeover startup scripts.

## Status

- [x] JACK client scaffolding (MIDI + audio ports)
- [x] QuickJS host with ES module resolver
- [x] Internal/external MIDI routing with Source tagging
- [x] Lock-free ring buffer bridge (RT-safe)
- [x] USB hub hot-plug via JACK notification handler
- [x] Audio bridge (M8 USB → Move hardware)
- [x] Runtime config (`runner.json`)
- [ ] Cross-compile toolchain setup
- [ ] Verify JACK port names on device (`jack_lsp`)
- [ ] Startup service (systemd or RNBO Takeover hook)
- [ ] External MIDI in port for RNBO-originated messages
