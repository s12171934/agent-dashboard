use crate::{bridge, components::*, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};
#[component]
pub fn Decisions() -> impl IntoView {
    let c = context();
    let pending = Rows::default();
    let inbox = Rows::default();
    Effect::new(move |_| {
        let d = c.state.get()["decisions"].clone();
        if let Err(e) = serde_json::from_value::<agent_dashboard_client_core::Decisions>(d.clone())
        {
            c.toast.set(format!("결정 응답을 읽을 수 없습니다: {e}"));
            return;
        }
        pending.sync(array(&d["pending"]).to_vec());
        inbox.sync(array(&d["inbox"]).to_vec());
    });
    view! {
        <Heading title="결정 대기 · 메일함" note="터미널의 질문·권한 요청과 캔버스 판정"/>
        <div class="controls"><label><input id="inbox-mode" type="checkbox" prop:checked=move||c.state.get()["decisions"]["inbox_mode"].as_object().is_some_and(|m| !m.is_empty() && m.values().all(|v|v==true)) on:change=move|e|{let ids=c.state.get_untracked()["decisions"]["inbox_mode"].as_object().map(|m|m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default(); c.act("inboxMode",json!([event_target_checked(&e),ids]));}/>"자리 비움 · 권장안으로 진행 후 메일함에 보관"</label></div>
        <div id="decisions" class="ru-list"><For each=move||pending.items.get() key=|r|r.key.clone() children=|row|view!{<RequestCard row=row inbox=false/>}/></div>
        <Show when=move||pending.items.get().is_empty()><Empty text="결정을 기다리는 질문이 없습니다"/></Show>
        <Heading title="메일함" note="자리를 비운 동안 에이전트가 진행한 선택"/>
        <div id="inbox" class="ru-list"><For each=move||inbox.items.get() key=|r|r.key.clone() children=|row|view!{<RequestCard row=row inbox=true/>}/></div>
    }
}
fn draft(c: Context, id: &str, count: usize) -> Vec<Value> {
    c.drafts
        .with(|m| m.get(id).cloned())
        .unwrap_or_else(|| vec![Value::Null; count])
}
fn set_answer(c: Context, id: &str, qi: usize, n: usize, answer: Value) {
    c.drafts.update(|m| {
        let a = m.entry(id.into()).or_insert_with(|| vec![Value::Null; n]);
        a.resize(n, Value::Null);
        a[qi] = answer;
    });
}
#[component]
fn RequestCard(row: Row, inbox: bool) -> impl IntoView {
    let c = context();
    let r = row.read();
    let id = StoredValue::new(label(&r.get_untracked(), &["id"]));
    let busy = RwSignal::new(false);
    let status = RwSignal::new(String::new());
    let failed = RwSignal::new(false);
    let send = move || {
        if busy.get_untracked() {
            return;
        }
        let v = r.get_untracked();
        let ident = id.get_value();
        let answers = draft(c, &ident, array(&v["questions"]).len());
        busy.set(true);
        failed.set(false);
        status.set("답을 보내는 중…".into());
        leptos::task::spawn_local(async move {
            let result = if inbox {
                bridge::call("inbox", json!([ident, "answer", answers])).await
            } else {
                bridge::call("decide", json!([ident, answers])).await
            };
            if status.is_disposed() {
                return;
            }
            match result {
                Ok(v) if v["status"] == 200 || v["body"]["closed"] == true => {
                    status.set("답을 보냈습니다".into());
                    c.tick();
                }
                Ok(v) => {
                    failed.set(true);
                    status.set(label(&v["body"], &["error"]));
                    busy.set(false);
                }
                Err(e) => {
                    failed.set(true);
                    status.set(e);
                    busy.set(false);
                }
            }
        });
    };
    let questions = array(&r.get_untracked()["questions"]).to_vec();
    let n = questions.len();
    let immediate = !inbox && n == 1 && questions.iter().all(|q| q["multiSelect"] != true);
    view! {<section class="dc-card" class:done=move||busy.get() class:read=move||inbox&&r.get()["read"]==true data-id=move||id.get_value()>
          <div class="dc-meta"><b>{if inbox{"메일함"}else{"결정 대기"}}</b>" · "{move||label(&r.get(),&["agent","title"])}" · "{move||{let t=number(&r.get()["created_at"]);bridge::timestamp(&js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(t*1000.)).to_iso_string().as_string().unwrap_or_default())}}</div>
          <p class="dc-context">{move||label(&r.get(),&["context"])}</p>
          <Show when=move||inbox><p class="ib-went"><b>"진행한 선택 "</b>{move||if r.get()["chosen"].is_string(){label(&r.get(),&["chosen"])}else{array(&r.get()["recommended"]).iter().map(text).collect::<Vec<_>>().join(" / ")}}</p></Show>
          {questions.into_iter().enumerate().map(move|(qi,q)|{let multi=q["multiSelect"]==true;let free=q["multiSelect"]!=true&&!matches!(text(&r.get_untracked()["kind"]),"permission"|"canvas");let id2=id;view!{<div class="dc-q"><span class="dc-tag">{label(&q,&["header"])}</span><h3>{label(&q,&["question"])}</h3><Show when=move||r.get()["command"].is_string()><pre class="dc-cmd">{move||label(&r.get(),&["command"])}</pre></Show><div class="dc-options">{array(&q["options"]).iter().map(move|o|{let title=label(o,&["label"]);let picked=title.clone();let chosen=title.clone();view!{<button class="dc-opt" class:picked=move||{let a=draft(c,&id2.get_value(),n)[qi].clone();if multi{array(&a).iter().any(|v|v==&picked)}else{a==picked}} disabled=move||busy.get() on:click=move|_|{let a=if multi{let mut a=array(&draft(c,&id2.get_value(),n)[qi]).to_vec();if let Some(i)=a.iter().position(|v|v==&chosen){a.remove(i);}else{a.push(json!(chosen));}
    if a.is_empty(){Value::Null}else{json!(a)}}else{json!(chosen)};set_answer(c,&id2.get_value(),qi,n,a);if immediate{send();}}><span class="dc-label">{title}</span><span class="dc-desc">{label(o,&["description"])}</span></button>}}).collect_view()}</div><Show when=move||free><form class="dc-other" on:submit=move|e|{e.prevent_default();if immediate&&!draft(c,&id2.get_value(),n)[qi].is_null(){send();}}><input placeholder="직접 입력 (기타)" aria-label="직접 입력 (기타)" disabled=move||busy.get() prop:value=move||{let a=draft(c,&id2.get_value(),n)[qi].clone();if a.is_string(){text(&a).to_owned()}else{String::new()}} on:input=move|e|{let v=event_target_value(&e);set_answer(c,&id2.get_value(),qi,n,if v.trim().is_empty(){Value::Null}else{json!(v)});}/><button type="submit" disabled=move||busy.get()>"입력"</button></form></Show></div>}}).collect_view()}
          <Show when=move||!immediate><button class="act accent dc-submit" disabled=move||busy.get()||{let a=draft(c,&id.get_value(),n);if inbox{a.iter().all(Value::is_null)}else{a.iter().any(Value::is_null)}} on:click=move|_|send()>{if inbox{"세션에 바꾸라고 알리기"}else{"답 보내기"}}</button></Show>
          <div class="ru-actions"><Show when=move||inbox><Action label=if r.get_untracked()["read"]==true{"안읽음으로"}else{"확인"} method="inbox" args=Signal::derive(move||json!([id.get_value(),if r.get()["read"]==true{"unread"}else{"read"}]))/><Action label="메일함에서 삭제" method="inbox" args=Signal::derive(move||json!([id.get_value(),"delete"])) confirm=true/></Show><Show when=move||failed.get()><Action label="카드 삭제" method="dismiss" args=Signal::derive(move||json!([id.get_value()]))/></Show><Show when=move||!inbox><Action label="터미널에서 답하기" method="release" args=Signal::derive(move||json!([id.get_value()])) confirm=true/></Show></div>
          <p class="dc-status" class:err=move||failed.get() role="status">{move||status.get()}{move||label(&r.get(),&["error"])}</p>
        </section>}
}
