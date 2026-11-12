use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;
#[wasm_bindgen(module = "/src/runtime.js")]
extern "C" {
    #[wasm_bindgen(js_name=observeVisible)]
    pub fn observe_visible(
        element: &web_sys::Element,
        callback: &js_sys::Function,
    ) -> js_sys::Function;
    #[wasm_bindgen(js_name=scrollId)]
    pub fn scroll_id(id: &str);
    #[wasm_bindgen(js_name=delay)]
    pub async fn delay(ms: u32);
    #[wasm_bindgen(catch,js_name=apiCall)]
    async fn raw_call(name: &str, args: JsValue) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name=connect)]
    pub fn connect(callback: &js_sys::Function) -> js_sys::Function;
    #[wasm_bindgen(js_name=storageGet)]
    pub fn storage_get(key: &str) -> String;
    #[wasm_bindgen(js_name=storageSet)]
    pub fn storage_set(key: &str, value: &str);
    #[wasm_bindgen(js_name=go)]
    pub fn go(hash: &str);
    #[wasm_bindgen(js_name=nativeResume)]
    pub fn native_resume(callback: &js_sys::Function) -> js_sys::Function;
    #[wasm_bindgen(js_name=videoBridge)]
    pub fn video_bridge(video: &web_sys::HtmlVideoElement) -> js_sys::Function;
    #[wasm_bindgen(js_name=readFile,catch)]
    pub async fn read_file(input: &web_sys::HtmlInputElement) -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name=loadRoster,catch)]
    pub async fn load_roster() -> Result<JsValue, JsValue>;
    #[wasm_bindgen(js_name=icons)]
    pub fn icons() -> JsValue;
    #[wasm_bindgen(js_name=setIcon)]
    pub fn set_icon(id: &str);
    #[wasm_bindgen(js_name=localFrame)]
    pub fn local_frame(url: &str) -> String;
    #[wasm_bindgen(js_name=timestamp)]
    pub fn timestamp(s: &str) -> String;
}
pub async fn call(name: &str, args: Value) -> Result<Value, String> {
    let args = args
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| e.to_string())?;
    raw_call(name, args)
        .await
        .map_err(|e| e.as_string().unwrap_or_else(|| format!("{e:?}")))
        .and_then(|v| serde_wasm_bindgen::from_value(v).map_err(|e| e.to_string()))
}
pub async fn noargs(name: &str) -> Result<Value, String> {
    call(name, json!([])).await
}
pub fn saved_bool(key: &str, default: bool) -> bool {
    match storage_get(key).as_str() {
        "1" | "true" => true,
        "0" | "false" => false,
        _ => default,
    }
}
pub fn saved(key: &str, default: &str) -> String {
    let s = storage_get(key);
    if s.is_empty() { default.into() } else { s }
}
