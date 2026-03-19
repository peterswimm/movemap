use ringbuf::{HeapProd, HeapCons, traits::*};

/// Where a MIDI packet came from — determines which JS callback fires
#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    Internal, // hardware buttons, pads, encoders → onMidiMessageInternal
    External, // USB MIDI devices (M8, hub devices) → onMidiMessageExternal
}

/// Raw MIDI packet (up to 4 bytes) tagged with source
#[derive(Clone, Copy)]
pub struct Packet {
    pub source: Source,
    pub data:   [u8; 4],
    pub len:    usize,
}

/// MIDI output packet tagged with destination JACK port
#[derive(Clone, Copy)]
pub struct OutPacket {
    pub dest: Dest,
    pub data: [u8; 4],
    pub len:  usize,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Dest {
    Internal, // → hardware LEDs/pads
    External, // → USB MIDI out (M8, DAW)
}

impl Packet {
    pub fn from_raw(bytes: &[u8], source: Source) -> Option<Self> {
        if bytes.is_empty() || bytes.len() > 4 {
            return None;
        }
        let mut data = [0u8; 4];
        data[..bytes.len()].copy_from_slice(bytes);
        Some(Self { source, data, len: bytes.len() })
    }
}

// ---------------------------------------------------------------------------

pub struct ProcessHandler {
    midi_in_internal:  jack::Port<jack::MidiIn>,
    midi_in_external:  jack::Port<jack::MidiIn>,
    midi_out_internal: jack::Port<jack::MidiOut>,
    midi_out_external: jack::Port<jack::MidiOut>,
    audio:             crate::audio::AudioPorts,
    midi_in_prod:      HeapProd<Packet>,
    midi_out_cons:     HeapCons<OutPacket>,
}

impl ProcessHandler {
    pub fn new(
        midi_in_internal:  jack::Port<jack::MidiIn>,
        midi_in_external:  jack::Port<jack::MidiIn>,
        midi_out_internal: jack::Port<jack::MidiOut>,
        midi_out_external: jack::Port<jack::MidiOut>,
        audio:             crate::audio::AudioPorts,
        midi_in_prod:      HeapProd<Packet>,
        midi_out_cons:     HeapCons<OutPacket>,
    ) -> Self {
        Self {
            midi_in_internal, midi_in_external,
            midi_out_internal, midi_out_external,
            audio, midi_in_prod, midi_out_cons,
        }
    }
}

impl jack::ProcessHandler for ProcessHandler {
    fn process(&mut self, _client: &jack::Client, ps: &jack::ProcessScope) -> jack::Control {
        // ── Audio: M8 USB in → Move hardware out (direct copy, no JS) ──────
        self.audio.bridge(ps);

        // ── MIDI in: push both ports to QuickJS thread, tagged by source ──
        for msg in self.midi_in_internal.iter(ps) {
            if let Some(pkt) = Packet::from_raw(msg.bytes, Source::Internal) {
                let _ = self.midi_in_prod.try_push(pkt);
            }
        }
        for msg in self.midi_in_external.iter(ps) {
            if let Some(pkt) = Packet::from_raw(msg.bytes, Source::External) {
                let _ = self.midi_in_prod.try_push(pkt);
            }
        }

        // ── MIDI out: drain packets written by QuickJS thread ─────────────
        let mut internal_writer = self.midi_out_internal.writer(ps);
        let mut external_writer = self.midi_out_external.writer(ps);

        while let Some(pkt) = self.midi_out_cons.try_pop() {
            let bytes = &pkt.data[..pkt.len];
            let raw = jack::RawMidi { time: 0, bytes };
            match pkt.dest {
                Dest::Internal => { let _ = internal_writer.write(&raw); }
                Dest::External => { let _ = external_writer.write(&raw); }
            }
        }

        jack::Control::Continue
    }
}
