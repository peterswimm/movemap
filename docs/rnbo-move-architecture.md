# RNBO / Ableton Move Architecture

Notes from live reverse-engineering session on AbletonOS 3.18 (2026-03-19/20).

---

## Hardware Architecture

The Move is an RPi4 with a **custom hardware MCU** connected via SPI at `/dev/ablspi0.0`.
The MCU handles everything hardware-facing:

- Pad / button / encoder MIDI
- **USB-A port as a USB host** — M8, Launchpad, etc. The RPi4 kernel **never sees these USB devices**; they are enumerated by the MCU and tunneled over SPI as USB MIDI cable packets
- Hardware audio I/O (converters, speaker, headphone)

The RPi4's own **USB-C port** (dwc2 OTG at `fe980000.usb`) runs permanently in **gadget mode** (`configfs-gadget`), providing USB networking to the host Mac. It cannot be switched to host mode at runtime without a kernel/device tree change.

The PCIe slot (`fd500000.pcie` → `0000:01:00.0`) holds an **Intel Wireless-AC 9260** WiFi chip — not a USB hub. There is no VL805/XHCI in the Move's kernel.

```
Physical ports
  USB-C  →  dwc2 (RPi4 SoC)  →  gadget mode (USB networking to Mac)
  USB-A  →  Move MCU          →  USB host for MIDI devices (M8, LPP, etc.)
  WiFi   →  Intel 9260 (PCIe) →  wireless networking
```

---

## SPI Memory Interface

move-anything (and Cycling74's JACK driver) communicate with the MCU by mmapping `/dev/ablspi0.0`:

```c
struct SPI_Memory {
    unsigned char outgoing_midi[256];    // offset   0 — MIDI to hardware/USB-A
    unsigned char outgoing_random[512];  // offset 256 — audio output samples
    unsigned char outgoing_unknown[1280];
    unsigned char incoming_midi[256];    // offset 2048 — MIDI from hardware/USB-A
    unsigned char incoming_random[512];  // offset 2304 — audio input samples
    unsigned char incoming_unknown[1280];
};
```

MIDI packets are USB MIDI format (4-byte packets with cable number in bits 7-4):
- **Cable 0** — internal hardware (pads, buttons, encoders)
- **Cable 2** — USB-A device (M8, Launchpad Pro, etc.)

ioctls flush/sync the buffer to hardware.

---

## JACK Layer

Cycling74 ships a **custom JACK2 build** (`v1.9.22`, protocol 9) with a `-d move` driver that wraps `/dev/ablspi0.0` and exposes standard JACK ports:

### MIDI ports

| Port | Direction | Description |
|---|---|---|
| `system:midi_capture` | source | Internal hardware MIDI (pads/buttons/encoders) |
| `system:midi_capture_ext` | source | USB-A MIDI device input (M8, etc.) |
| `system:midi_playback` | sink | Internal hardware MIDI out |
| `system:midi_playback_ext` | sink | USB-A MIDI device output |
| `system:display` | sink | Display/LED control |

### Audio ports

| Port | Direction | Description |
|---|---|---|
| `system:capture_1/2` | source | Hardware audio inputs |
| `system:playback_1/2` | sink | Hardware audio outputs |
| `move-volume:in1/2` | sink | Volume-controlled inputs |
| `move-volume:out1/2` | source | Volume-controlled outputs |

---

## RNBO Runner Stack

```
Hardware MCU  ←→  /dev/ablspi0.0  ←→  JACK2 (-d move driver)
                                             ↓
                                   RNBO patcher instances (JACK clients)
                                   move-control   (hardware control surface)
                                   move-volume    (volume control)
                                   rnbo-record    (audio recording)
                                   jack-transport-link  (Ableton Link)
                                             ↓
                                   rnbo-runner-panel  (HTTP :3000)
                                   rnbooscquery       (OSC Query API :5678)
```

RNBO patches are deployed as JACK clients; the OSC Query API at `:5678` exposes full port/patch state.

---

## movemap-runner Operational Requirements

The runner is a JACK client and must meet JACK's runtime constraints:

```sh
# Must run as ableton user (uid 1000) — JACK socket is group-restricted
su -s /bin/sh ableton -c '...'

# JACK requires unlimited memlock; SSH sessions default to 64KB
ulimit -l unlimited
ulimit -r 95   # realtime priority

# libjack is not in the system library path
export LD_LIBRARY_PATH=/data/UserData/rnbo/lib

# Full startup command
ulimit -l unlimited
ulimit -r 95
su -s /bin/sh ableton -c '
  ulimit -l unlimited
  ulimit -r 95
  LD_LIBRARY_PATH=/data/UserData/rnbo/lib \
    /data/UserData/movemap/movemap-runner --module-dir /data/UserData/movemap
'
```

### runner.json port assignments (verified 2026-03-19)

```json
{
  "internal_midi_port": "system:midi_capture",
  "external_midi_ports": ["system:midi_capture_ext"],
  "audio_src_l": "system:capture_1",
  "audio_src_r": "system:capture_2",
  "audio_dst_l": "system:playback_1",
  "audio_dst_r": "system:playback_2"
}
```

---

## Approaches: move-anything vs. movemap-runner

| | move-anything | movemap-runner |
|---|---|---|
| MIDI/audio access | Direct SPI mmap (`/dev/ablspi0.0`) | JACK client |
| JACK dependency | None | Required |
| Composability | Exclusive hardware access | Coexists with RNBO patches |
| Startup complexity | Low | Requires rlimits + user switch |
| JS runtime | QuickJS (compiled C binary) | QuickJS via rquickjs (Rust) |

---

## Useful Diagnostics

```sh
# Inspect all live JACK ports
wget -qO- http://localhost:5678/rnbo/jack/info/ports

# Restart full RNBO/JACK stack
/etc/init.d/move restart

# Check RNBO runner processes
ps aux | grep -E 'rnbo|jack|movemap'

# Find JACK binaries
ls /data/UserData/rnbo/bin/
```
