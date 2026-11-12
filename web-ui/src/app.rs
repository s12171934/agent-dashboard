use crate::{bridge, components::*, model::*, state::*, views::*};
use leptos::prelude::*;
use serde_json::{Value, json};
use wasm_bindgen::{JsCast, closure::Closure};
#[component]
pub fn App() -> impl IntoView {
    let c = Context::new();
    provide_context(c);
    let callback = Closure::<dyn FnMut(String)>::new(move |kind: String| {
        if kind == "motion" {
            c.motion.set(js_sys::Date::now());
            return;
        }
        if kind == "route" {
            c.route.set(Route::parse(
                &web_sys::window()
                    .unwrap()
                    .location()
                    .hash()
                    .unwrap_or_default(),
            ));
            c.popup.set(String::new());
            web_sys::window().unwrap().scroll_to_with_x_and_y(0., 0.);
        } else {
            c.pulse.set(js_sys::Date::now() as u64 / 30000);
            if kind == "projects" {
                c.projects_epoch.update(|n| *n += 1);
            }
            c.tick();
        }
    });
    let connections = bridge::connect(callback.as_ref().unchecked_ref());
    let resume = bridge::native_resume(callback.as_ref().unchecked_ref());
    let callback = send_wrapper::SendWrapper::new(callback);
    on_cleanup(move || {
        let _ = connections.call0(&wasm_bindgen::JsValue::NULL);
        let _ = resume.call0(&wasm_bindgen::JsValue::NULL);
        drop(callback);
    });
    c.tick();
    let roster_clock = Memo::new(move |_| c.pulse.get() / 2);
    Effect::new(move |_| {
        roster_clock.get();
        leptos::task::spawn_local(async move {
            if let Ok(v) = bridge::load_roster().await
                && let Ok(v) = serde_wasm_bindgen::from_value(v)
                && c.roster.get_untracked() != v
            {
                c.roster.set(v);
            }
        });
    });
    Effect::new(move |_| {
        let route = c.route.get();
        let title = SCREENS
            .iter()
            .find(|(k, _, _)| *k == route.group())
            .map(|(_, t, _)| *t)
            .unwrap_or("에이전트");
        web_sys::window()
            .unwrap()
            .document()
            .unwrap()
            .set_title(&format!("{title} — Agent Dashboard"));
    });
    let page = Memo::new(move |_| c.route.get().page);
    view! {<div id="app" data-ui="rust-wasm"><Chrome/><main id="view" class="ru-view">{move||match page.get().as_str(){"home"=>view!{<insights::Home/>}.into_any(),"agents"=>view!{<agents::Agents/>}.into_any(),"session"=>view!{<agents::Session/>}.into_any(),"run"=>view!{<agents::Run/>}.into_any(),"driver"=>view!{<agents::Driver/>}.into_any(),"decide"=>view!{<decisions::Decisions/>}.into_any(),"usage"=>view!{<insights::Usage/>}.into_any(),"compare"=>view!{<insights::Compare/>}.into_any(),"talk"=>view!{<insights::Talk/>}.into_any(),"tests"=>view!{<insights::Tests/>}.into_any(),"projects"=>view!{<content::Projects/>}.into_any(),"designs"=>view!{<content::Designs/>}.into_any(),"media"=>view!{<content::Media/>}.into_any(),"canvas"=>view!{<content::Canvas/>}.into_any(),"trees"=>view!{<operations::Worktrees/>}.into_any(),"worktrees"=>view!{<operations::Reviews/>}.into_any(),"chars"=>view!{<operations::Characters/>}.into_any(),_=>view!{<insights::Home/>}.into_any()}}</main><Modal/><ds-tooltip id="tip"></ds-tooltip></div>}
}
#[component]
fn Chrome() -> impl IntoView {
    let c = context();
    view! {<ds-dock id="dock">{SCREENS.iter().enumerate().map(|(i,(key,title,icon))|{let key=*key;view!{<a href=format!("#{key}") data-v=key data-name=if key=="worktrees"{"QA"}else{*title} data-tip=*title data-more=(i>=5).then_some("") aria-label=*title class:on=move||c.route.get().group()==key><Icon name=*icon/><b class="dn" hidden=move||if key=="decide"{array(&c.state.get()["decisions"]["pending"]).is_empty()}else{true}>{move||array(&c.state.get()["decisions"]["pending"]).len()}</b></a>}}).collect_view()}
    <button id="launch-btn" class="dock-btn" data-fab data-tip="새 에이전트" on:click=move|_|c.popup.set("launch".into())><Icon name="plus"/></button>
    <label class="dock-btn" data-more data-tip="실행 중만"><input id="only-live" type="checkbox" prop:checked=move||c.only_live.get() on:change=move|e|{let on=event_target_checked(&e);c.only_live.set(on);bridge::storage_set("adash.live",if on{"1"}else{"0"});}/><Icon name="pulse"/></label>
    <label class="dock-btn" data-more data-tip="Orca 에 열린 것만"><input id="only-orca" type="checkbox" prop:checked=move||c.only_orca.get() on:change=move|e|{let on=event_target_checked(&e);c.only_orca.set(on);bridge::storage_set("adash.orca",if on{"1"}else{"0"});}/><Icon name="terminal"/></label>
    <label class="dock-btn" data-more data-tip="캐릭터 모드"><input id="char-mode" type="checkbox" prop:checked=move||c.chars.get() on:change=move|e|{let on=event_target_checked(&e);c.chars.set(on);bridge::storage_set("adash.charmode",if on{"1"}else{"0"});}/><Icon name="smile"/></label>
    {[("stat","현황","gauge"),("servers","메트릭 서버","server"),("editor","에디터","terminal"),("icons","앱 아이콘","shapes")].into_iter().map(|(key,title,icon)|view!{<button class="dock-btn" data-more data-tip=title id=format!("{key}-btn") on:click=move|_|c.popup.set(if c.popup.get_untracked()==key{String::new()}else{key.into()})><Icon name=icon/></button>}).collect_view()}
    <ds-theme-toggle data-more data-tip="테마"></ds-theme-toggle><a href="ds/stories.html" target="_blank" data-more data-tip="디자인 시스템"><Icon name="grid"/></a>
    </ds-dock><Show when=move||!c.popup.get().is_empty()><div class="popover dock-pop ru-popup" data-sticky><div class="pop-h"><b>{move||match c.popup.get().as_str(){"launch"=>"새 에이전트","servers"=>"메트릭 서버","editor"=>"에디터","icons"=>"앱 아이콘",_=>"현황"}}</b><button class="act" on:click=move|_|c.popup.set(String::new())>"닫기"</button></div>{move||match c.popup.get().as_str(){"launch"=>view!{<operations::Launch/>}.into_any(),"servers"=>view!{<Servers/>}.into_any(),"editor"=>view!{<select class="field" prop:value=move||c.editor.get() on:change=move|e|{let v=event_target_value(&e);bridge::storage_set("adash.editor",&v);c.editor.set(v);}>
    <option value="vscode">"VS Code"</option><option value="zed">"Zed"</option></select>}.into_any(),"icons"=>view!{<Icons/>}.into_any(),_=>view!{<Overview/>}.into_any()}}</div></Show>}
}
#[component]
fn Overview() -> impl IntoView {
    let c = context();
    view! {<div class="ru-metrics"><Metric title="에이전트" value=Signal::derive(move||array(&c.state.get()["sessions"]).len().to_string())/><Metric title="실행 중" value=Signal::derive(move||array(&c.state.get()["sessions"]).iter().filter(|s|s["live"]==true).count().to_string())/><Metric title="비용" value=Signal::derive(move||format!("${:.2}",array(&c.state.get()["sessions"]).iter().map(|s|number(&s["cost"])).sum::<f64>()))/></div><div class="ru-errors">{move||array(&c.state.get()["server_errors"]).iter().map(|e|view!{<p>{text(e).to_owned()}</p>}).collect_view()}{move||c.health.get()["loops"].as_object().map(|o|o.iter().filter(|(_,v)|v["error"].is_string()).map(|(k,v)|format!("{k}: {}",text(&v["error"]))).collect::<Vec<_>>().join(" · ")).unwrap_or_default()}</div>}
}
#[component]
fn Servers() -> impl IntoView {
    let c = context();
    let url = RwSignal::new(String::new());
    let name = RwSignal::new(String::new());
    view! {<div class="ru-list">{move||array(&c.servers.get()).iter().map(|server|{let id=text(&server["id"]).to_owned();let id2=id.clone();let on=server["on"]==true;view!{<div class="ru-server"><label><input type="checkbox" prop:checked=on on:change=move|e|{let mut servers=c.servers.get_untracked();if let Some(s)=servers.as_array_mut().and_then(|ss|ss.iter_mut().find(|s|s["id"]==id)){s["on"]=json!(event_target_checked(&e));}c.act("setServers",json!([servers]));}/><b>{text(&server["name"]).to_owned()}</b></label><code>{text(&server["url"]).to_owned()}</code><button class="act danger" on:click=move|_|{let values=array(&c.servers.get_untracked()).iter().filter(|s|s["id"]!=id2).cloned().collect::<Vec<_>>();c.act("setServers",json!([values]));}>"제거"</button></div>}}).collect_view()}</div><TextField label="이름" value=name/><TextField label="서버 주소" value=url/><button class="act accent" on:click=move|_|{let u=url.get_untracked();let n=name.get_untracked();leptos::task::spawn_local(async move{match bridge::call("probe",json!([u])).await{Ok(v)if v["ok"]==true=>{let mut servers=array(&c.servers.get_untracked()).to_vec();servers.push(json!({"url":u.trim_end_matches('/'),"name":n,"on":true}));c.act("setServers",json!([servers]));url.set(String::new());name.set(String::new());},Ok(v)=>c.toast.set(label(&v,&["error"])),Err(e)=>c.toast.set(e)}});}>"확인 후 추가"</button>}
}
#[component]
fn Icons() -> impl IntoView {
    let c = context();
    let list: Vec<Value> = serde_wasm_bindgen::from_value(bridge::icons()).unwrap_or_default();
    view! {<div class="ru-icon-grid">{list.into_iter().map(|v|{let id=text(&v["id"]).to_owned();view!{<button class="act" on:click=move|_|bridge::set_icon(&id)><img src=text(&v["src"]).to_owned() alt=label(&v,&["concept"])/></button>}}).collect_view()}{move||c.roster.get()["chars"].as_object().map(|chars|chars.iter().map(|(id,v)|{let who=id.clone();view!{<button class="act" on:click=move|_|bridge::set_icon(&format!("face-{who}"))><img src=format!("chars/{id}-icon-192.png") alt=label(v,&["name"])/></button>}}).collect_view())}</div>}
}
