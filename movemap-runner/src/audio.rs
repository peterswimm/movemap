/// Audio bridge: M8 USB audio in → Move hardware audio out.
///
/// Runs entirely in the JACK RT process callback — no JS involvement.
/// Port names come from RunnerConfig (defaults are best-guesses;
/// verify with `jack_lsp` on the device).

use anyhow::Result;
use crate::config::RunnerConfig;

pub struct AudioPorts {
    pub in_l:  jack::Port<jack::AudioIn>,
    pub in_r:  jack::Port<jack::AudioIn>,
    pub out_l: jack::Port<jack::AudioOut>,
    pub out_r: jack::Port<jack::AudioOut>,
}

impl AudioPorts {
    /// Direct copy: M8 USB audio → Move hardware output
    pub fn bridge(&mut self, ps: &jack::ProcessScope) {
        let in_l  = self.in_l.as_slice(ps);
        let in_r  = self.in_r.as_slice(ps);
        let out_l = self.out_l.as_mut_slice(ps);
        let out_r = self.out_r.as_mut_slice(ps);
        out_l.copy_from_slice(in_l);
        out_r.copy_from_slice(in_r);
    }
}

pub struct AudioInfo {
    our_in_l:  String,
    our_in_r:  String,
    our_out_l: String,
    our_out_r: String,
}

pub fn register_ports(client: &jack::Client) -> Result<(AudioPorts, AudioInfo)> {
    let in_l  = client.register_port("audio_in_l",  jack::AudioIn::default())?;
    let in_r  = client.register_port("audio_in_r",  jack::AudioIn::default())?;
    let out_l = client.register_port("audio_out_l", jack::AudioOut::default())?;
    let out_r = client.register_port("audio_out_r", jack::AudioOut::default())?;

    let info = AudioInfo {
        our_in_l:  in_l.name()?.to_string(),
        our_in_r:  in_r.name()?.to_string(),
        our_out_l: out_l.name()?.to_string(),
        our_out_r: out_r.name()?.to_string(),
    };

    Ok((AudioPorts { in_l, in_r, out_l, out_r }, info))
}

pub fn connect_ports(client: &jack::Client, info: AudioInfo, cfg: &RunnerConfig) -> Result<()> {
    // M8 (or configured source) → our audio inputs (best-effort; device may not be present)
    let _ = client.connect_ports_by_name(&cfg.audio_src_l, &info.our_in_l);
    let _ = client.connect_ports_by_name(&cfg.audio_src_r, &info.our_in_r);

    // Our outputs → Move hardware audio
    let _ = client.connect_ports_by_name(&info.our_out_l, &cfg.audio_dst_l);
    let _ = client.connect_ports_by_name(&info.our_out_r, &cfg.audio_dst_r);

    Ok(())
}
