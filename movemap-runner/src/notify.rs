/// JACK notification handler — auto-connects USB MIDI devices to midi_in_external.
///
/// When a new JACK port registers (USB hub device plugged in, or JACK client starts):
///   - If it's a MIDI output port
///   - And it's not one of our own ports or the internal hardware port
///   - Connect it to our midi_in_external port
///
/// This gives transparent hot-plug support for any number of USB MIDI devices.

use jack::{Client, NotificationHandler, PortId};

pub struct MidiAutoConnect {
    /// Our external MIDI in port name (e.g. "movemap:midi_in_external")
    pub midi_in_external: String,

    /// The internal hardware port — never connect this to external in
    pub internal_port:    String,

    /// Our own client name prefix — skip our own ports
    pub client_name:      String,

    /// If non-empty, only connect ports in this explicit allowlist
    pub allowlist:        Vec<String>,
}

impl NotificationHandler for MidiAutoConnect {
    fn port_registration(&mut self, client: &Client, port_id: PortId, is_registered: bool) {
        if !is_registered {
            return; // Disconnection — JACK cleans up connections automatically
        }

        let Some(port) = client.port_by_id(port_id) else { return };
        let Ok(name) = port.name() else { return };
        let Ok(ptype) = port.port_type() else { return };

        // Only handle MIDI output ports
        if !ptype.contains("midi") {
            return;
        }
        if !port.flags().contains(jack::PortFlags::IS_OUTPUT) {
            return;
        }

        // Skip our own ports
        if name.starts_with(&format!("{}:", self.client_name)) {
            return;
        }

        // Skip the internal hardware port
        if name == self.internal_port {
            return;
        }

        // If there's an explicit allowlist, only connect listed ports
        if !self.allowlist.is_empty() && !self.allowlist.iter().any(|a| a.as_str() == name) {
            return;
        }

        // Connect: new device → our external MIDI in
        let result = client.connect_ports_by_name(name.as_str(), self.midi_in_external.as_str());
        match result {
            Ok(()) => eprintln!("[movemap] connected MIDI: {} → {}", name, self.midi_in_external),
            Err(e) => eprintln!("[movemap] connect failed ({name}): {e:?}"),
        }
    }
}
