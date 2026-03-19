/// Runner configuration — loaded from `{module_dir}/runner.json`.
///
/// All fields have sensible defaults so the file is optional.
/// Adjust port names after running `jack_lsp` on the device.

use anyhow::Result;
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct RunnerConfig {
    /// JACK port name for the Move's internal hardware MIDI (pads, buttons, encoders).
    /// All messages here route to globalThis.onMidiMessageInternal().
    pub internal_midi_port: String,

    /// Explicit list of external MIDI output ports to connect to midi_in_external.
    /// If empty, the notification handler auto-connects ALL non-system MIDI output ports.
    pub external_midi_ports: Vec<String>,

    /// JACK port names for M8 (or other USB) audio output → our audio inputs.
    pub audio_src_l: String,
    pub audio_src_r: String,

    /// JACK port names for Move hardware audio inputs (our outputs connect here).
    pub audio_dst_l: String,
    pub audio_dst_r: String,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            // Best-guess defaults — verify with `jack_lsp` on the device
            internal_midi_port:  "system:midi_capture_1".into(),
            external_midi_ports: vec![],          // empty = auto-connect all
            audio_src_l:         "M8:out_1".into(),
            audio_src_r:         "M8:out_2".into(),
            audio_dst_l:         "system:playback_1".into(),
            audio_dst_r:         "system:playback_2".into(),
        }
    }
}

impl RunnerConfig {
    pub fn load(module_dir: &Path) -> Self {
        let path = module_dir.join("runner.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            return Self::default();
        };
        let Ok(v): Result<Value, _> = serde_json::from_str(&raw) else {
            return Self::default();
        };

        let mut cfg = Self::default();

        if let Some(s) = v["internal_midi_port"].as_str() {
            cfg.internal_midi_port = s.to_string();
        }
        if let Some(arr) = v["external_midi_ports"].as_array() {
            cfg.external_midi_ports = arr
                .iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect();
        }
        if let Some(s) = v["audio_src_l"].as_str() { cfg.audio_src_l = s.to_string(); }
        if let Some(s) = v["audio_src_r"].as_str() { cfg.audio_src_r = s.to_string(); }
        if let Some(s) = v["audio_dst_l"].as_str() { cfg.audio_dst_l = s.to_string(); }
        if let Some(s) = v["audio_dst_r"].as_str() { cfg.audio_dst_r = s.to_string(); }

        cfg
    }
}
