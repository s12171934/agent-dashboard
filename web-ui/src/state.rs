use crate::{bridge, model::*};
use leptos::prelude::*;
use serde_json::{Value, json};
use std::collections::HashMap;
#[derive(Clone)]
pub struct Row {
    pub key: String,
    pub value: ArcRwSignal<Value>,
}
impl Row {
    pub fn read(self) -> Signal<Value> {
        Signal::derive(move || self.value.get())
    }
}
#[derive(Clone, Copy)]
pub struct Rows {
    pub items: RwSignal<Vec<Row>>,
    cache: StoredValue<HashMap<String, ArcRwSignal<Value>>>,
}
impl Default for Rows {
    fn default() -> Self {
        Self {
            items: RwSignal::new(vec![]),
            cache: StoredValue::new(HashMap::new()),
        }
    }
}
impl Rows {
    pub fn sync(self, values: Vec<Value>) {
        let mut rows = vec![];
        self.cache.update_value(|cache| {
            let mut next = HashMap::new();
            for (mut i, value) in values.into_iter().enumerate() {
                let base = format!("{}|{}", text(&value["server"]), key(&value));
                let mut id = base.clone();
                while next.contains_key(&id) {
                    i += 1;
                    id = format!("{base}|{i}");
                }
                let signal = cache
                    .remove(&id)
                    .unwrap_or_else(|| ArcRwSignal::new(value.clone()));
                if signal.get_untracked() != value {
                    signal.set(value);
                }
                rows.push(Row {
                    key: id.clone(),
                    value: signal.clone(),
                });
                next.insert(id, signal);
            }
            *cache = next;
        });
        let old = self
            .items
            .with_untracked(|v| v.iter().map(|r| r.key.clone()).collect::<Vec<_>>());
        if old != rows.iter().map(|r| r.key.clone()).collect::<Vec<_>>() {
            self.items.set(rows);
        }
    }
    pub fn get(self, key: &str) -> Option<Row> {
        self.cache.with_value(|c| {
            c.get(key).map(|v| Row {
                key: key.into(),
                value: v.clone(),
            })
        })
    }
}
#[derive(Clone, Debug)]
pub struct Confirm {
    pub title: String,
    pub message: String,
    pub method: String,
    pub args: Value,
    pub flag: Option<(usize, String)>,
}
#[derive(Clone, Copy)]
pub struct Context {
    pub drafts: RwSignal<HashMap<String, Vec<Value>>>,
    pub state: RwSignal<Value>,
    pub health: RwSignal<Value>,
    pub route: RwSignal<Route>,
    pub sessions: Rows,
    pub index: RwSignal<Index>,
    pub servers: RwSignal<Value>,
    pub busy: RwSignal<bool>,
    again: RwSignal<bool>,
    pub toast: RwSignal<String>,
    pub popup: RwSignal<String>,
    pub confirm: RwSignal<Option<Confirm>>,
    pub output: RwSignal<String>,
    pub only_live: RwSignal<bool>,
    pub only_orca: RwSignal<bool>,
    pub chars: RwSignal<bool>,
    pub editor: RwSignal<String>,
    pub roster: RwSignal<Value>,
    pub epoch: RwSignal<u64>,
    pub pulse: RwSignal<u64>,
    pub motion: RwSignal<f64>,
    pub projects_epoch: RwSignal<u64>,
}
impl Context {
    pub fn new() -> Self {
        Self {
            drafts: RwSignal::new(HashMap::new()),
            state: RwSignal::new(
                json!({"sessions":[],"orca":{"runs":[],"tasks":{},"workers":[],"terminals":[]},"decisions":{"pending":[],"inbox":[],"inbox_mode":{}},"tests":{"files":[]}}),
            ),
            health: RwSignal::new(Value::Null),
            route: RwSignal::new(Route::parse(
                &web_sys::window()
                    .unwrap()
                    .location()
                    .hash()
                    .unwrap_or_default(),
            )),
            sessions: Rows::default(),
            index: RwSignal::new(Index::default()),
            servers: RwSignal::new(json!([])),
            busy: RwSignal::new(false),
            again: RwSignal::new(false),
            toast: RwSignal::new(String::new()),
            popup: RwSignal::new(String::new()),
            confirm: RwSignal::new(None),
            output: RwSignal::new(String::new()),
            only_live: RwSignal::new(bridge::saved_bool("adash.live", false)),
            only_orca: RwSignal::new(bridge::saved_bool("adash.orca", false)),
            chars: RwSignal::new(bridge::saved_bool("adash.charmode", true)),
            editor: RwSignal::new(bridge::saved("adash.editor", "vscode")),
            roster: RwSignal::new(json!({"chars":{}})),
            epoch: RwSignal::new(0),
            pulse: RwSignal::new(0),
            motion: RwSignal::new(js_sys::Date::now()),
            projects_epoch: RwSignal::new(0),
        }
    }
    pub async fn refresh(self) {
        if self.busy.get_untracked() {
            self.again.set(true);
            return;
        }
        self.busy.set(true);
        loop {
            self.again.set(false);
            match bridge::noargs("state").await {
                Ok(data) => {
                    let unchanged = data["unchanged"] == true;
                    self.health.set(data["health"].clone());
                    if !unchanged {
                        let sessions = array(&data["sessions"]).to_vec();
                        let ix = index(&sessions);
                        if self.index.get_untracked() != ix {
                            self.index.set(ix);
                        }
                        self.sessions.sync(sessions);
                        let ids = array(&data["decisions"]["pending"])
                            .iter()
                            .chain(array(&data["decisions"]["inbox"]))
                            .map(|r| label(r, &["id"]))
                            .collect::<std::collections::HashSet<_>>();
                        self.drafts.update(|d| d.retain(|k, _| ids.contains(k)));
                        self.state.set(data);
                        self.epoch.update(|v| *v += 1);
                    }
                }
                Err(e) => self.toast.set(e),
            }
            if let Ok(servers) = bridge::noargs("servers").await {
                self.servers.set(servers);
            }
            if !self.again.get_untracked() {
                break;
            }
        }
        self.busy.set(false);
    }
    pub fn tick(self) {
        leptos::task::spawn_local(async move {
            self.refresh().await;
        });
    }
    pub fn visible(self, value: &Value) -> bool {
        (!self.only_live.get() || live(value) || value["live"] == true)
            && (!self.only_orca.get() || value["orca_focus"].is_string())
    }
    pub fn family_visible(self, value: &Value, depth: usize) -> bool {
        if self.visible(value) {
            return true;
        }
        if depth >= 6 {
            return false;
        }
        let ix = self.index.get();
        let mut ids = ix
            .by_coord
            .get(&relation(value, "own_handle"))
            .cloned()
            .unwrap_or_default();
        ids.extend(
            ix.subs
                .get(&relation(value, "id"))
                .cloned()
                .unwrap_or_default(),
        );
        self.rows_for(&ids)
            .iter()
            .any(|row| self.family_visible(&row.value.get(), depth + 1))
    }
    pub fn rows_for(self, ids: &[String]) -> Vec<Row> {
        ids.iter().filter_map(|id| self.sessions.get(id)).collect()
    }
    pub fn ask(self, title: &str, message: String, method: &str, args: Value) {
        self.confirm.set(Some(Confirm {
            title: title.into(),
            message,
            method: method.into(),
            args,
            flag: None,
        }));
    }
    pub async fn request(self, method: &str, args: Value) -> Result<Value, String> {
        let result = bridge::call(method, args.clone()).await?;
        if method == "worktreeRemove" && result["status"] == 409 && args[2] != true {
            self.ask(
                "워크트리 강제 삭제",
                format!(
                    "{}\n{}",
                    label(&result["body"], &["error"]),
                    serde_json::to_string_pretty(&result["body"]["reasons"]).unwrap_or_default()
                ),
                "worktreeRemove",
                json!([args[0], args[1], true]),
            );
            return Ok(result);
        }
        if result["body"]["ok"] == false || result["status"].as_u64().is_some_and(|s| s >= 400) {
            return Err(label(&result["body"], &["error", "message"]));
        }
        if let Some(output) = result["body"]["output"].as_str() {
            self.output.set(output.into());
        }
        if let Some(id) = result["body"]["job"].as_str() {
            self.toast.set("요청을 시작했습니다".into());
            let id = id.to_owned();
            leptos::task::spawn_local(async move {
                for _ in 0..120 {
                    crate::bridge::delay(500).await;
                    if let Ok(job) = bridge::call("closeJob", json!([id])).await
                        && (matches!(text(&job["phase"]), "done" | "failed")
                            || matches!(text(&job["state"]), "done" | "failed"))
                    {
                        if !array(&job["failed"]).is_empty() {
                            self.output.set(
                                serde_json::to_string_pretty(&job["failed"]).unwrap_or_default(),
                            );
                        }
                        self.toast.set(if job["error"].is_string() {
                            label(&job, &["error"])
                        } else {
                            "요청을 마쳤습니다".into()
                        });
                        self.tick();
                        return;
                    }
                }
                self.toast
                    .set("처리가 계속되고 있습니다. 현황에서 결과를 확인하세요".into());
            });
        } else {
            self.toast.set("반영했습니다".into());
        }
        self.tick();
        Ok(result)
    }
    pub fn act(self, method: &str, args: Value) {
        let method = method.to_owned();
        leptos::task::spawn_local(async move {
            if let Err(e) = self.request(&method, args).await {
                self.toast.set(e);
            }
        });
    }
}
#[derive(Clone, Copy)]
pub struct Data {
    pub value: RwSignal<Value>,
    pub rows: Rows,
    pub busy: RwSignal<bool>,
    pub error: RwSignal<String>,
    revision: RwSignal<u64>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            value: RwSignal::new(Value::Null),
            rows: Rows::default(),
            busy: RwSignal::new(false),
            error: RwSignal::new(String::new()),
            revision: RwSignal::new(0),
        }
    }
}
impl Data {
    pub fn load(self, method: &str, args: Value, field: &str) {
        let method = method.to_owned();
        let field = field.to_owned();
        self.revision.update(|v| *v += 1);
        let revision = self.revision.get_untracked();
        self.busy.set(true);
        leptos::task::spawn_local(async move {
            let result = bridge::call(&method, args).await;
            if self.revision.try_get_untracked() != Some(revision) {
                return;
            }
            match result {
                Ok(value) => {
                    self.rows.sync(if field.is_empty() {
                        array(&value).to_vec()
                    } else {
                        array(&value[&field]).to_vec()
                    });
                    let error = if value["status"].as_u64().is_some_and(|s| s >= 400) {
                        label(&value["body"], &["error", "output"])
                    } else {
                        label(&value, &["error"])
                    };
                    self.value.set(value);
                    self.error.set(error);
                }
                Err(e) => self.error.set(e),
            }
            self.busy.set(false);
        });
    }
}
pub fn context() -> Context {
    expect_context::<Context>()
}
