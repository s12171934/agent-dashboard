//! Platform-neutral wire types and decision state shared by the server and Apple clients.
//! Network requests and presentation stay with the host; no browser or Apple dependencies.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::{CString, c_char},
    panic::{AssertUnwindSafe, catch_unwind},
};

pub const ABI_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Choice {
    pub label: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Question {
    pub question: String,
    pub header: Option<String>,
    #[serde(rename = "multiSelect")]
    pub multi_select: Option<bool>,
    pub options: Vec<Choice>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Decision {
    pub id: String,
    pub agent: Option<String>,
    pub questions: Vec<Question>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DecisionRef {
    pub id: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRef {
    pub path: String,
    pub title: Option<String>,
    pub decision: Option<DecisionRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Decisions {
    pub available: bool,
    pub pending: Vec<Decision>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}
/// Both /api/decisions and the legacy /api/state contain these fields. Unknown root fields are ignored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DecisionsPayload {
    pub decisions: Decisions,
    #[serde(default)]
    pub sessions: Vec<SessionRef>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Update {
    pub pending: Vec<Decision>,
    pub sessions: HashMap<String, SessionRef>,
    pub new_ids: Vec<String>,
    pub gone_ids: Vec<String>,
}
#[derive(Default)]
pub struct DecisionStore {
    pending: Vec<Decision>,
    sessions: HashMap<String, SessionRef>,
    primed: bool,
}
impl DecisionStore {
    pub fn apply(&mut self, bytes: &[u8]) -> Result<Update, String> {
        let payload: DecisionsPayload =
            serde_json::from_slice(bytes).map_err(|e| format!("invalid decision response: {e}"))?;
        let mut ids = HashSet::new();
        if payload
            .decisions
            .pending
            .iter()
            .any(|q| q.id.is_empty() || !ids.insert(q.id.as_str()))
        {
            return Err("decision ids must be nonempty and unique".into());
        }
        let mut new_ids = vec![];
        let mut gone_ids = vec![];
        if payload.decisions.available {
            let previous = self
                .pending
                .iter()
                .map(|q| q.id.as_str())
                .collect::<HashSet<_>>();
            if self.primed {
                new_ids = payload
                    .decisions
                    .pending
                    .iter()
                    .filter(|q| !previous.contains(q.id.as_str()))
                    .map(|q| q.id.clone())
                    .collect();
                gone_ids = self
                    .pending
                    .iter()
                    .filter(|q| !ids.contains(q.id.as_str()))
                    .map(|q| q.id.clone())
                    .collect();
            }
            self.sessions = payload
                .sessions
                .into_iter()
                .filter_map(|session| {
                    session
                        .decision
                        .as_ref()
                        .map(|d| (d.id.clone(), session.clone()))
                })
                .collect();
            self.pending = payload.decisions.pending;
            self.primed = true;
        }
        Ok(Update {
            pending: self.pending.clone(),
            sessions: self.sessions.clone(),
            new_ids,
            gone_ids,
        })
    }
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn adash_core_abi_version() -> u32 {
    ABI_VERSION
}
#[unsafe(no_mangle)]
pub extern "C" fn adash_decision_store_new() -> *mut DecisionStore {
    Box::into_raw(Box::new(DecisionStore::default()))
}
/// # Safety
/// `store` must be null or a live pointer returned by `adash_decision_store_new`, released exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn adash_decision_store_free(store: *mut DecisionStore) {
    if !store.is_null() {
        drop(unsafe { Box::from_raw(store) });
    }
}
/// # Safety
/// `store` must be live and exclusively owned for the call. It may be null, which is ignored.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn adash_decision_store_reset(store: *mut DecisionStore) {
    if let Some(store) = unsafe { store.as_mut() } {
        store.reset();
    }
}
/// # Safety
/// A non-null store must be live and exclusively owned for this call. For nonzero `len`, `bytes` must refer to
/// `len` readable bytes. The returned UTF-8 JSON string must be released with `adash_core_string_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn adash_decision_store_apply(
    store: *mut DecisionStore,
    bytes: *const u8,
    len: usize,
) -> *mut c_char {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let store = unsafe { store.as_mut() }.ok_or("missing decision store")?;
        if len > 32 * 1024 * 1024 {
            return Err("decision response exceeds 32 MiB".into());
        }
        if bytes.is_null() && len > 0 {
            return Err("missing response bytes".into());
        }
        let bytes = if len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(bytes, len) }
        };
        store.apply(bytes)
    }));
    let envelope = match result {
        Ok(Ok(update)) => serde_json::json!({"ok":true,"result":update}),
        Ok(Err(error)) => serde_json::json!({"ok":false,"error":error}),
        Err(_) => {
            serde_json::json!({"ok":false,"error":"decision core could not process the response"})
        }
    };
    // JSON escapes interior NUL bytes, so CString construction cannot fail here.
    CString::new(envelope.to_string()).unwrap().into_raw()
}
/// # Safety
/// `string` must be null or an unfreed string returned by this library.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn adash_core_string_free(string: *mut c_char) {
    if !string.is_null() {
        drop(unsafe { CString::from_raw(string) });
    }
}
