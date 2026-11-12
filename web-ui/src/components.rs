use crate::{bridge, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};
#[component]
pub fn Icon(#[prop(into)] name: String) -> impl IntoView {
    view! {<ds-icon name=name></ds-icon>}
}
#[component]
pub fn Empty(#[prop(into)] text: String) -> impl IntoView {
    view! {<div class="empty">{text}</div>}
}
#[component]
pub fn Heading(#[prop(into)] title: String, #[prop(optional, into)] note: String) -> impl IntoView {
    view! {<div class="sec-h"><h2>{title}</h2><span>{note}</span></div>}
}
#[component]
pub fn Status(
    #[prop(into)] value: Signal<Value>,
    #[prop(default = "state")] field: &'static str,
) -> impl IntoView {
    view! {<span class="ru-status" data-state=move||text(&value.get()[field]).to_owned()>{move||state_label(text(&value.get()[field])).to_owned()}</span>}
}
#[component]
pub fn JsonPanel(
    #[prop(into)] value: Signal<Value>,
    #[prop(default = "상세 정보")] title: &'static str,
) -> impl IntoView {
    view! {<details class="ru-detail"><summary>{title}</summary><pre>{move||serde_json::to_string_pretty(&value.get()).unwrap_or_default()}</pre></details>}
}
#[component]
pub fn Markdown(#[prop(into)] source: Signal<String>) -> impl IntoView {
    view! {<article class="ru-markdown" inner_html=move||markdown(&source.get())></article>}
}
#[component]
pub fn Search(
    #[prop(into)] value: RwSignal<String>,
    #[prop(default = "검색")] placeholder: &'static str,
) -> impl IntoView {
    view! {<input class="field ru-search" type="search" placeholder=placeholder aria-label=placeholder prop:value=move||value.get() on:input=move|ev|value.set(event_target_value(&ev))/>}
}
#[component]
pub fn ErrorLine(data: Data) -> impl IntoView {
    view! {<Show when=move||!data.error.get().is_empty()><div class="ru-error" role="alert">{move||data.error.get()}</div></Show><Show when=move||data.busy.get()&&data.value.get().is_null()><div class="empty">"불러오는 중…"</div></Show>}
}
#[component]
pub fn Action(
    #[prop(into)] label: String,
    #[prop(into)] method: String,
    #[prop(optional, into)] dynamic_method: Option<Signal<String>>,
    #[prop(into)] args: Signal<Value>,
    #[prop(default = false)] danger: bool,
    #[prop(default = false)] confirm: bool,
    #[prop(optional, into)] disabled: Signal<bool>,
) -> impl IntoView {
    let c = context();
    let busy = RwSignal::new(false);
    let method2 = method.clone();
    let label2 = label.clone();
    view! {<button type="button" class="act" class:danger=danger disabled=move||busy.get()||disabled.get() on:click=move|_|{let method=dynamic_method.map(|s|s.get_untracked()).unwrap_or_else(||method2.clone());let args=args.get_untracked();if confirm{c.ask(&label2,format!("{} 작업을 진행할까요?",label2),&method,args);return;}busy.set(true);leptos::task::spawn_local(async move{if let Err(e)=c.request(&method,args).await{c.toast.set(e);}let _=busy.try_set(false);});}>{move||if busy.get(){"처리 중…".into()}else{label.clone()}}</button>}
}
#[component]
pub fn Progress(#[prop(into)] ratio: Signal<f64>) -> impl IntoView {
    view! {<div class="ru-progress" role="progressbar" aria-valuenow=move||(ratio.get()*100.).round().to_string() aria-valuemin="0" aria-valuemax="100"><i style:width=move||format!("{}%",ratio.get().clamp(0.,1.)*100.)></i></div>}
}
#[component]
pub fn Metric(#[prop(into)] title: String, #[prop(into)] value: Signal<String>) -> impl IntoView {
    view! {<div class="ru-metric"><span>{title}</span><b>{move||value.get()}</b></div>}
}
#[component]
pub fn Steps(#[prop(into)] steps: Signal<Value>) -> impl IntoView {
    view! {<ol class="ru-steps"><For each={move||array(&steps.get()).iter().enumerate().map(|(i,x)|(i,x.clone())).collect::<Vec<_>>()} key=|(i,x)|format!("{i}:{}",label(x,&["t","text","cb"])) children=|(i,x)|{let st=label(&x,&["st","status"]);view!{<li data-state=st.clone()><span>{if ["done","skip","passed"].contains(&st.as_str()){"✓".into()}else{(i+1).to_string()}}</span><div>{label(&x,&["t","text","title","cb"])}<small>{label(&x,&["note","at"])}</small></div></li>}}/></ol>}
}
#[component]
pub fn Bars(#[prop(into)] values: Signal<Value>) -> impl IntoView {
    view! {<div class="ru-bars"><For each={move||array(&values.get()).iter().enumerate().map(|(i,v)|(i,number(v))).collect::<Vec<_>>()} key=|(i,_)|*i children=move|(i,n)|{let max=array(&values.get_untracked()).iter().map(number).fold(1.,f64::max);view!{<div title=format!("{i}: {n:.2}")><i style:height=format!("{}%",(n/max*100.).max(1.))></i><small>{i}</small></div>}}/></div>}
}
#[component]
pub fn WebPanel(#[prop(into)] url: Signal<String>) -> impl IntoView {
    view! {<Show when=move||!url.get().is_empty()><div class="ru-web"><a class="act" href=move||url.get() target="_blank" rel="noopener">"새 창에서 열기"</a><iframe src=move||bridge::local_frame(&url.get()) title="웹 편집기"></iframe></div></Show>}
}
#[component]
pub fn TextField(
    #[prop(into)] label: String,
    value: RwSignal<String>,
    #[prop(default = false)] multiline: bool,
) -> impl IntoView {
    view! {<label class="ru-field"><span>{label}</span>{if multiline{view!{<textarea class="field" prop:value=move||value.get() on:input=move|e|value.set(event_target_value(&e))></textarea>}.into_any()}else{view!{<input class="field" prop:value=move||value.get() on:input=move|e|value.set(event_target_value(&e))/>}.into_any()}}</label>}
}
#[component]
pub fn Modal() -> impl IntoView {
    let c = context();
    let confirmed = RwSignal::new(false);
    Effect::new(move |_| {
        c.confirm.get();
        confirmed.set(false);
    });
    view! {<Show when=move||c.confirm.get().is_some()><div class="ru-modal" role="dialog" aria-modal="true"><div class="box"><h2>{move||c.confirm.get().map(|d|d.title).unwrap_or_default()}</h2><p>{move||c.confirm.get().map(|d|d.message).unwrap_or_default()}</p>{move||c.confirm.get().and_then(|d|d.flag).map(|(_,label)|view!{<label><input type="checkbox" prop:checked=move||confirmed.get() on:change=move|e|confirmed.set(event_target_checked(&e))/>{label}</label>})}<div class="ru-actions"><button class="act" on:click=move|_|c.confirm.set(None)>"취소"</button><button class="act danger" on:click=move|_|{if let Some(mut action)=c.confirm.get_untracked(){if let Some((i,_))=action.flag{action.args[i]=json!(confirmed.get_untracked());}c.confirm.set(None);c.act(&action.method,action.args);}}>"확인"</button></div></div></div></Show><Show when=move||!c.output.get().is_empty()><div class="ru-modal" role="dialog" aria-modal="true"><div class="box"><h2>"실행 결과"</h2><pre>{move||c.output.get()}</pre><button class="act" on:click=move|_|c.output.set(String::new())>"닫기"</button></div></div></Show><Show when=move||!c.toast.get().is_empty()><button class="ru-toast" role="status" on:click=move|_|c.toast.set(String::new())>{move||c.toast.get()}</button></Show>}
}
pub fn value_signal(value: Value) -> Signal<Value> {
    Signal::derive(move || value.clone())
}
pub fn string_signal(value: String) -> Signal<String> {
    Signal::derive(move || value.clone())
}
