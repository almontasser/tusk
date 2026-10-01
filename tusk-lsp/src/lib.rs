//! Tusk's PHP language server.

pub mod analysis;
pub mod capabilities;
pub mod config_edit;
pub mod diagnostics;
pub mod documents;
pub mod features;
pub mod framework;
pub mod handlers;
pub mod imports;
pub mod index;
pub mod locate;
pub mod mago_config;
pub mod phpstan;
pub mod repair;
pub mod scope;
pub mod server;
pub mod symbol;
pub mod types;
pub mod text;
#[cfg(test)]
pub mod testing;

pub use server::run_stdio;

/// A command for `program`. The editor runs this server without a console on Windows, where a console program it
/// starts, such as PHP, would otherwise open a window of its own.
pub(crate) fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut command = std::process::Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000); // CREATE_NO_WINDOW
    command
}
