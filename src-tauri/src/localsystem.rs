// Temporary stub for the OS setup module, so the domains proxy builds before that branch is merged.
#![allow(dead_code)]
use std::path::{Path, PathBuf};

pub struct Wanted {
    pub ca_pem: PathBuf,
    pub dns_port: u16,
    pub names: Vec<String>,
}

pub struct Status {
    pub ca_trusted: bool,
    pub resolver: bool,
    pub missing_hosts: Vec<String>,
    pub low_ports: bool,
    pub uses_hosts: bool,
}

pub fn status(_w: &Wanted) -> Status {
    Status { ca_trusted: true, resolver: true, missing_hosts: Vec::new(), low_ports: true, uses_hosts: false }
}

pub fn apply(_w: &Wanted, _low_ports: bool) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

pub fn remove(_ca_pem: &Path) -> Result<(), String> {
    Ok(())
}
