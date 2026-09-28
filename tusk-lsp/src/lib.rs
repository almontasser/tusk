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
