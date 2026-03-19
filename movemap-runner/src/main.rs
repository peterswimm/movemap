mod audio;
mod config;
mod js_host;
mod midi;
mod notify;

use anyhow::Result;
use clap::Parser;
use ringbuf::{HeapRb, traits::Split};
use std::sync::{Arc, Mutex};
use std::path::PathBuf;

/// MoveMap JACK runner — MIDI control surface + M8 audio bridge
#[derive(Parser)]
#[command(version)]
struct Args {
    /// Path to movemap JS module directory
    #[arg(long, default_value = "/data/UserData/movemap")]
    module_dir: PathBuf,

    /// JACK client name
    #[arg(long, default_value = "movemap")]
    client_name: String,
}

const RING_CAP: usize = 256;

fn main() -> Result<()> {
    let args = Args::parse();
    let cfg  = config::RunnerConfig::load(&args.module_dir);

    eprintln!("[movemap] module_dir: {}", args.module_dir.display());
    eprintln!("[movemap] internal MIDI port: {}", cfg.internal_midi_port);

    // -- Ring buffers ---------------------------------------------------------
    let (midi_in_prod, midi_in_cons)   = HeapRb::<midi::Packet>::new(RING_CAP).split();
    let (midi_out_prod, midi_out_cons) = HeapRb::<midi::OutPacket>::new(RING_CAP).split();
    let midi_out_prod = Arc::new(Mutex::new(midi_out_prod));

    // -- JACK client ----------------------------------------------------------
    let (client, _status) = jack::Client::new(
        &args.client_name,
        jack::ClientOptions::NO_START_SERVER,
    )?;

    let midi_in_internal  = client.register_port("midi_in_internal",  jack::MidiIn::default())?;
    let midi_in_external  = client.register_port("midi_in_external",  jack::MidiIn::default())?;
    let midi_out_internal = client.register_port("midi_out_internal", jack::MidiOut::default())?;
    let midi_out_external = client.register_port("midi_out_external", jack::MidiOut::default())?;

    let (audio_ports, audio_info) = audio::register_ports(&client)?;

    // Capture our external port name for the notification handler
    let ext_port_name = midi_in_external.name()?.to_string();

    let process = midi::ProcessHandler::new(
        midi_in_internal,
        midi_in_external,
        midi_out_internal,
        midi_out_external,
        audio_ports,
        midi_in_prod,
        midi_out_cons,
    );

    let notifier = notify::MidiAutoConnect {
        midi_in_external: ext_port_name,
        internal_port:    cfg.internal_midi_port.clone(),
        client_name:      args.client_name.clone(),
        allowlist:        cfg.external_midi_ports.clone(),
    };

    let active_client = client.activate_async(notifier, process)?;

    // Connect hardware internal MIDI port → our internal in
    let _ = active_client.as_client().connect_ports_by_name(
        &cfg.internal_midi_port,
        &format!("{}:midi_in_internal", args.client_name),
    );

    // Connect audio ports
    audio::connect_ports(active_client.as_client(), audio_info, &cfg)?;

    // Scan already-registered MIDI ports and connect external ones now
    // (handles devices that were connected before we started)
    connect_existing_midi(active_client.as_client(), &cfg, &args.client_name)?;

    // -- QuickJS host (blocks until process exits) ----------------------------
    js_host::run(args.module_dir, midi_in_cons, midi_out_prod)?;

    Ok(())
}

/// Connect any MIDI output ports that already exist at startup
fn connect_existing_midi(
    client:      &jack::Client,
    cfg:         &config::RunnerConfig,
    client_name: &str,
) -> Result<()> {
    let ext_in = format!("{}:midi_in_external", client_name);

    let ports = client.ports(
        None,
        Some("midi"),
        jack::PortFlags::IS_OUTPUT,
    );

    for port_name in ports {
        if port_name.starts_with(&format!("{}:", client_name)) { continue; }
        if port_name == cfg.internal_midi_port                  { continue; }
        if !cfg.external_midi_ports.is_empty()
            && !cfg.external_midi_ports.iter().any(|p| p == &port_name) { continue; }

        let result = client.connect_ports_by_name(&port_name, &ext_in);
        match result {
            Ok(()) => eprintln!("[movemap] connected existing MIDI: {port_name}"),
            Err(e) => eprintln!("[movemap] skipped {port_name}: {e:?}"),
        }
    }
    Ok(())
}
