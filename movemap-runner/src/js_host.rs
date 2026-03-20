/// QuickJS host — loads movemap ES modules and drives the MIDI event loop.
///
/// Threading model:
///   JACK RT thread  →→ midi_in_cons  (ring buffer, tagged by Source) →→ this thread
///   this thread     →→ midi_out_prod (ring buffer, tagged by Dest)   →→ JACK RT thread
///
/// Globals injected into QuickJS (replacing move-anything's runtime):
///   move_midi_internal_send(packet: number[])  → internal JACK MIDI out
///   move_midi_external_send(packet: number[])  → external JACK MIDI out
///   host_read_file(path: string) → string | null
///   host_write_file(path: string, content: string)
///
/// JS entry points (set on globalThis by ui.mjs):
///   init()
///   tick()
///   onMidiMessageInternal(data: number[])
///   onMidiMessageExternal(data: number[])

use anyhow::{Context, Result};
use ringbuf::{HeapCons, HeapProd, traits::*};
use rquickjs::{
    Context as JsContext, Function, Module, Runtime,
    loader::{FileResolver, ScriptLoader},
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use crate::midi::{Dest, OutPacket, Packet, Source};

// tick() at ~44 Hz to match move-anything's timer
const TICK_INTERVAL: Duration = Duration::from_millis(23);

pub fn run(
    module_dir:  PathBuf,
    mut midi_in: HeapCons<Packet>,
    midi_out:    Arc<Mutex<HeapProd<OutPacket>>>,
) -> Result<()> {
    // Set cwd to module_dir so FileResolver's RelativePath checks work
    std::env::set_current_dir(&module_dir)
        .with_context(|| format!("cannot chdir to {}", module_dir.display()))?;

    // -- Runtime with file-based ES module resolver --------------------------
    let rt = Runtime::new()?;
    rt.set_loader(
        FileResolver::default()
            .with_path(module_dir.to_str().context("non-UTF8 module path")?)
            .with_pattern("{}.mjs"),
        ScriptLoader::default().with_extension("mjs"),
    );

    let ctx = JsContext::full(&rt)?;

    ctx.with(|ctx| -> rquickjs::Result<()> {
        let globals = ctx.globals();

        // Minimal console shim
        let console = rquickjs::Object::new(ctx.clone())?;
        console.set("log",   Function::new(ctx.clone(), |msg: String| eprintln!("[js] {msg}"))? )?;
        console.set("warn",  Function::new(ctx.clone(), |msg: String| eprintln!("[js:warn] {msg}"))? )?;
        console.set("error", Function::new(ctx.clone(), |msg: String| eprintln!("[js:error] {msg}"))? )?;
        globals.set("console", console)?;

        // host_read_file(path) → string | null
        globals.set(
            "host_read_file",
            Function::new(ctx.clone(), |path: String| -> Option<String> {
                std::fs::read_to_string(&path).ok()
            })?,
        )?;

        // host_write_file(path, content)
        globals.set(
            "host_write_file",
            Function::new(ctx.clone(), |path: String, content: String| {
                if let Some(parent) = std::path::Path::new(&path).parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, content);
            })?,
        )?;

        // move_midi_internal_send(packet)
        let out_i = Arc::clone(&midi_out);
        globals.set(
            "move_midi_internal_send",
            Function::new(ctx.clone(), move |data: Vec<u8>| {
                push_packet(&out_i, Dest::Internal, &data);
            })?,
        )?;

        // move_midi_external_send(packet)
        let out_e = Arc::clone(&midi_out);
        globals.set(
            "move_midi_external_send",
            Function::new(ctx.clone(), move |data: Vec<u8>| {
                push_packet(&out_e, Dest::External, &data);
            })?,
        )?;

        // Load main module — FileResolver handles ./midi_utils.mjs etc.
        let ui_src = std::fs::read_to_string(module_dir.join("ui.mjs"))
            .map_err(|e| { eprintln!("[movemap] failed to read ui.mjs: {e}"); rquickjs::Error::Unknown })?;
        eprintln!("[movemap] evaluating ui.mjs...");
        Module::evaluate(ctx.clone(), "ui.mjs", ui_src).map_err(|e| {
            if let rquickjs::Error::Exception = e {
                if let Ok(exc) = ctx.catch().get::<rquickjs::Value>() {
                    eprintln!("[movemap] ui.mjs JS exception: {:?}", exc);
                }
            } else {
                eprintln!("[movemap] ui.mjs error: {e:?}");
            }
            e
        })?;
        eprintln!("[movemap] ui.mjs loaded OK");

        Ok(())
    })?;

    // Call init() after module is fully loaded
    ctx.with(|ctx| -> rquickjs::Result<()> {
        if let Ok(init) = ctx.globals().get::<_, Function>("init") {
            init.call::<(), ()>(()).map_err(|e| {
                if let rquickjs::Error::Exception = e {
                    if let Ok(exc) = ctx.catch().get::<rquickjs::Value>() {
                        eprintln!("[movemap] init() JS exception: {:?}", exc);
                    }
                } else {
                    eprintln!("[movemap] init() error: {e:?}");
                }
                e
            })?;
        } else {
            eprintln!("[movemap] warning: init() not found on globalThis");
        }
        Ok(())
    })?;

    // -- MIDI + tick event loop -----------------------------------------------
    let mut last_tick = Instant::now();

    loop {
        // Drain all incoming MIDI from the JACK RT thread
        while let Some(pkt) = midi_in.try_pop() {
            let data = pkt.data[..pkt.len].to_vec();
            let source = pkt.source;

            ctx.with(|ctx| -> rquickjs::Result<()> {
                let globals = ctx.globals();
                let cb_name = match source {
                    Source::Internal => "onMidiMessageInternal",
                    Source::External => "onMidiMessageExternal",
                };
                if let Ok(f) = globals.get::<_, Function>(cb_name) {
                    f.call::<(Vec<u8>,), ()>((data,))?;
                }
                Ok(())
            })?;
        }

        // tick() at ~44 Hz
        if last_tick.elapsed() >= TICK_INTERVAL {
            last_tick = Instant::now();
            ctx.with(|ctx| -> rquickjs::Result<()> {
                if let Ok(tick) = ctx.globals().get::<_, Function>("tick") {
                    tick.call::<(), ()>(())?;
                }
                Ok(())
            })?;
        }

        std::thread::sleep(Duration::from_micros(500));
    }
}

fn push_packet(dest_buf: &Arc<Mutex<HeapProd<OutPacket>>>, dest: Dest, bytes: &[u8]) {
    if bytes.is_empty() || bytes.len() > 4 {
        return;
    }
    let mut data = [0u8; 4];
    data[..bytes.len()].copy_from_slice(bytes);
    if let Ok(mut prod) = dest_buf.lock() {
        let _ = prod.try_push(OutPacket { dest, data, len: bytes.len() });
    }
}
