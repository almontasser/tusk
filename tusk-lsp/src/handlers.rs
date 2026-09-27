//! Request handlers by method. Each takes a snapshot and the raw params and returns the raw result.

use lsp_types::request::Request;
use serde_json::Value;

use crate::server::Snapshot;

pub type Handler = fn(&Snapshot, Value) -> Result<Value, String>;

/// Wraps a typed handler as a [`Handler`].
macro_rules! typed {
    ($req:ty, $f:path) => {
        |snap: &Snapshot, params: Value| -> Result<Value, String> {
            let params: <$req as Request>::Params = serde_json::from_value(params).map_err(|e| e.to_string())?;
            let result: <$req as Request>::Result = $f(snap, params)?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
    };
}
#[allow(unused_imports)]
pub(crate) use typed;

pub fn find(method: &str) -> Option<Handler> {
    let handler: Handler = match method {
        _ => return None,
    };
    #[allow(unreachable_code)]
    Some(handler)
}
