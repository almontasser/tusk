//! Tusk's PHP language server.

pub mod analysis;
pub mod capabilities;
pub mod diagnostics;
pub mod documents;
pub mod handlers;
pub mod index;
pub mod server;
pub mod text;
#[cfg(test)]
pub mod testing;

pub use server::run_stdio;
