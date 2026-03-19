# RNBO Runner Deployment Plan

Covers the integration of a Max/RNBO blob with movemap-runner on Ableton Move in RNBO Takeover mode.

---

## Architecture

```
M8 hardware
  └── USB-A (UAC2)
        └── Linux kernel: snd-usb-audio
              └── ALSA device (hw:M8,0 or similar)
                    └── [alsa_in bridge — see §UAC2]
                          └── JACK2 port "M8:out_1 / M8:out_2"
                                └── RNBO blob (audio chain owner)
                                      └── system:playback_1/2

Move hardware (pads, buttons, encoders)
  └── JACK2 MIDI port "system:midi_capture_1"
        └── movemap-runner:midi_in_internal
              └── QuickJS (ui.mjs) — all control surface logic

M8 USB MIDI (LPP protocol)
  └── JACK2 MIDI port "M8:midi_port_1" (verify with jack_lsp)
        └── movemap-runner:midi_in_external / midi_out_external
              └── QuickJS (ui.mjs) — LPP handshake + pad/button routing
```

**Responsibility split:**
- `movemap-runner` — MIDI only: hardware controls → QuickJS → M8/Ableton MIDI
- `RNBO blob` — audio chain: M8 USB audio → DSP → Move hardware output
- `JACK2` — routes both; movemap-runner and RNBO Runner coexist as separate clients

movemap-runner's `audio.rs` raw buffer copy should be **removed** once the RNBO blob owns the audio chain. No double-connecting to M8 audio ports.

---

## UAC2 Audio Bridging

The RNBO blob is a JACK client — it has no direct USB or ALSA access. M8 UAC2 audio must be bridged into JACK at the OS level before the blob can receive it.

**Step 1: SSH in and check if M8 is already a JACK port:**
```bash
ssh move@move.local
jack_lsp -A
```

Look for ports named `M8:out_1`, `M8:out_2`, or similar. If Cycling74's JACK2 fork auto-bridges USB audio devices, they will already be present.

**Step 2a — If M8 audio is already a JACK port:** Update `runner.json` with the real port names. Proceed to RNBO blob audio wiring.

**Step 2b — If M8 audio is NOT automatically bridged:** Add `alsa_in` to the startup script:
```bash
# Identify M8 ALSA device first
aplay -l | grep -i M8
# Then bridge it into JACK
alsa_in -j M8 -d hw:M8,0 -r 48000 -p 256 -n 2 &
```

Add this invocation to the systemd unit or RNBO Takeover startup hook, before movemap-runner launches.

---

## RNBO Blob — Two Stages

### Stage 1: Minimal passthrough (smoke test)

Goal: enable RNBO Takeover mode and confirm JACK is accessible for movemap-runner.

In Max MSP:
1. New patcher → add `rnbo~` object
2. Inside `rnbo~`: audio in (stereo) → audio out (stereo), no processing
3. **File → Export → RNBO Runner Export**, target: **Raspberry Pi / ARM Linux** (aarch64)
4. Transfer export bundle to Move

This blob does nothing except occupy Takeover mode. movemap-runner's audio bridge handles the actual audio until Stage 2.

### Stage 2: M8-supportive audio chain

Replace Stage 1 blob once JACK port names are verified.

**Audio processing to add in the RNBO patch:**

| Block | Purpose |
|---|---|
| Input gain staging | Normalize M8 USB output levels before Move DAC |
| 3-band EQ | Shape M8's high-mid character for speakers/headphones |
| Limiter/compressor | Prevent clipping on Move output |
| Stereo widener (mid-side) | Widen M8's narrow stereo image |

**MIDI clock sync:**
- Add `[midiin]` in the RNBO patch to receive M8 MIDI clock (`0xF8`)
- Wire to `[transport]` to lock RNBO's tempo to M8
- Or reverse: send RNBO clock to M8 (makes RNBO master)
- Required prerequisite for tempo-synced parameter modulation (see below)

**Parameter modulation (addresses open roadmap item):**

Once `movemap-runner` has an external MIDI in port for RNBO-originated messages:
- Add `[param]` objects in RNBO mapped to M8's CC layout:
  - CC 71–80, channel 3 → M8 Track parameters
  - CC 90+, channel 3 → M8 FX parameters
- Add LFOs, envelopes, or sequencers inside RNBO
- Route their output as MIDI CC to movemap-runner's external MIDI in port
- movemap-runner forwards to M8 via `midi_out_external`

This enables tempo-synced M8 parameter automation without any JS changes.

---

## JACK Port Names (to be confirmed)

All defaults are best-guesses. Update `runner.json` after running `jack_lsp -A` on the device.

| Port | Default | Actual (fill in after SSH) |
|---|---|---|
| Move hardware MIDI in | `system:midi_capture_1` | |
| Move hardware MIDI out | `system:midi_playback_1` | |
| M8 MIDI out | `M8:midi_port_1` | |
| M8 MIDI in | `M8:midi_port_1` | |
| M8 audio L | `M8:out_1` | |
| M8 audio R | `M8:out_2` | |
| Move audio out L | `system:playback_1` | |
| Move audio out R | `system:playback_2` | |

---

## Deployment Sequence

```bash
# 1. Build JS module
bash scripts/build.sh
# → dist/movemap-module.tar.gz

# 2. Cross-compile movemap-runner for ARM
cd ../movemap-runner
rustup target add aarch64-unknown-linux-gnu
cargo build --release --target aarch64-unknown-linux-gnu

# 3. Deploy to Move
ssh move@move.local mkdir -p /data/UserData/movemap/config
scp dist/movemap-module.tar.gz move@move.local:/tmp/
ssh move@move.local "cd /data/UserData && tar xzf /tmp/movemap-module.tar.gz"
scp ../movemap-runner/target/aarch64-unknown-linux-gnu/release/movemap-runner move@move.local:/usr/local/bin/

# 4. Deploy RNBO blob (Stage 1) via RNBO web interface or scp
# scp <export-bundle>/* move@move.local:/path/to/rnbo/runner/

# 5. SSH in — verify JACK port names
ssh move@move.local
jack_lsp -A
# Update runner.json with real port names

# 6. Launch (Move must be in RNBO Takeover mode)
ssh move@move.local movemap-runner --module-dir /data/UserData/movemap

# 7. Configure startup service
# See docs/systemd-service.md (TODO)
```

---

## Open Roadmap Items (from README)

- [ ] SSH into Move, run `jack_lsp` — verify real JACK port names and update `runner.json` defaults
- [ ] Cross-compile `movemap-runner` for ARM Linux (`aarch64-unknown-linux-gnu`)
- [ ] Deploy Stage 1 RNBO blob — smoke test Takeover mode + JACK access
- [ ] Verify M8 UAC2 audio appears as JACK ports (or add `alsa_in` if not)
- [ ] Build Stage 2 RNBO blob — audio chain (gain, EQ, limiting, stereo width)
- [ ] Wire MIDI clock: M8 → RNBO tempo sync
- [ ] Add external MIDI in port to `movemap-runner` for RNBO-originated messages
- [ ] Build parameter modulation layer in RNBO blob (LFO/envelope → M8 CC)
- [ ] Remove `audio.rs` raw buffer copy from `movemap-runner` once RNBO blob owns audio
- [ ] Startup service (systemd or RNBO Takeover hook)
