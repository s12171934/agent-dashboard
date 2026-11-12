use crate::{bridge, components::*, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};
#[component]
pub fn Agents() -> impl IntoView {
    let c = context();
    let mode = RwSignal::new(bridge::saved("adash.agview", "tree"));
    let query = RwSignal::new(String::new());
    let limit = RwSignal::new(100usize);
    view! {<Heading title="에이전트" note="세션·코디네이터·워커의 실행 상태"/><div class="controls"><Search value=query/><select class="field" prop:value=move||mode.get() on:change=move|e|{let v=event_target_value(&e);bridge::storage_set("adash.agview",&v);mode.set(v);}>
    <option value="tree">"코디네이터 트리"</option><option value="wt">"워크트리별"</option><option value="map">"관계 지도"</option><option value="tl">"타임라인"</option></select><button class="act" on:click=move|_|{let paths=c.sessions.items.get_untracked().into_iter().filter_map(|s|{let v=s.value.get_untracked();(v["state"]=="stalled").then(||v["path"].clone())}).collect::<Vec<_>>();c.ask("유휴로 표시",format!("응답이 없는 {}개 세션을 유휴로 표시할까요?",paths.len()),"pref",json!(["idle",paths,{}]));}>"응답 없음 정리"</button></div>{move||if c.chars.get(){view!{<Office query=Signal::derive(move||query.get())/>}.into_any()}else if mode.get()=="wt"{view!{<For each={move||{let mut places=c.index.get().places.into_iter().collect::<Vec<_>>();places.sort_by(|a,b|a.0.cmp(&b.0));places}} key=|(p,_)|p.clone() children=move|(p,_)|{let p2=p.clone();view!{<section class="box ru-section"><h2>{p}</h2><div class="ru-grid"><For each=move||c.rows_for(&c.index.get().places.get(&p2).cloned().unwrap_or_default()) key=|r|r.key.clone() children=|r|view!{<AgentCard row=r/>}/></div></section>}}/>}.into_any()}else if mode.get()=="map"{view!{<Relations/>}.into_any()}else if mode.get()=="tl"{view!{<Timeline/>}.into_any()}else{view!{<div class="ru-list"><For each={move||{let ids=c.index.get().roots;let ids=if query.get().is_empty(){ids}else{c.sessions.items.get().iter().filter(|r|search(&r.value.get(),&query.get())).map(|r|r.key.clone()).collect()};c.rows_for(&ids).into_iter().filter(|r|c.family_visible(&r.value.get(),0)).take(limit.get()).collect::<Vec<_>>()}} key=|r|r.key.clone() children=|r|view!{<Family row=r depth=0/>}/></div>}.into_any()}}<OrcaBoard/><button class="act ru-more" on:click=move|_|limit.update(|n|*n+=100)>"100개 더 보기"</button>}
}
#[component]
fn Family(row: Row, depth: usize) -> AnyView {
    let c = context();
    let r = row.clone().read();
    view!{<div class="ru-family"><AgentCard row=row/><Show when=move||depth<6><div class="ru-children"><For each={move||{let v=r.get();let ix=c.index.get();let mut ids=ix.by_coord.get(&relation(&v,"own_handle")).cloned().unwrap_or_default();ids.extend(ix.subs.get(&relation(&v,"id")).cloned().unwrap_or_default());c.rows_for(&ids)}} key=|r|r.key.clone() children=move|child|view!{<Family row=child depth=depth+1/>}/></div></Show></div>}.into_any()
}
#[component]
pub fn AgentCard(row: Row) -> impl IntoView {
    let c = context();
    let r = row.read();
    view! {<article class="box ru-agent" data-state=move||label(&r.get(),&["state"]) data-path=move||label(&r.get(),&["path"])><div class="ru-row"><Status value=r/><small>{move||label(&r.get(),&["role"])}</small><small>{move||label(&r.get(),&["model"])}</small></div><a class="ru-agent-title" href=move||session_hash(text(&r.get()["path"]))>{move||label(&r.get(),&["title","id"])}</a><div class="ru-agent-meta"><span>{move||label(&r.get()["place"],&["worktree","project","path"])}</span><b>{move||money(&r.get()["cost"])}</b><span>{move||format!("출력 {} · {}턴",count(&r.get()["tokens"]["output"]),count(&r.get()["turns"]))}</span></div><Progress ratio=Signal::derive(move||{let v=r.get();number(&v["ctx_now"])/number(&v["ctx_window"]).max(1.)})/><small>{move||label(&r.get(),&["state_reason"])}</small><p class="ru-current">{move||label(&r.get()["plan"],&["cur_text"]).chars().take(160).collect::<String>()}</p><div class="ru-actions"><Action label="Orca에서 열기" method="focus" args=Signal::derive(move||json!([r.get()["orca_focus"]])) disabled=Signal::derive(move||!r.get()["orca_focus"].is_string())/><Action label="고정" method="pref" args=Signal::derive(move||json!([if r.get()["pinned"]==true{"unpin"}else{"pin"},[r.get()["path"]],{}]))/><Action label="유휴 전환" method="pref" args=Signal::derive(move||json!([if r.get()["manual_idle"]==true{"unidle"}else{"idle"},[r.get()["path"]],{}]))/><button class="act danger" disabled=move||!r.get()["orca_focus"].is_string() on:click=move|_|{let v=r.get_untracked();let children=array(&v["orca_close_tree"]).len();c.confirm.set(Some(Confirm{title:"에이전트 닫기".into(),message:format!("{} 세션을 닫습니다. 기록은 유지됩니다. 하위 터미널 {children}개.",label(&v,&["title"])),method:"close".into(),args:json!([v["orca_focus"],false]),flag:(children>0).then(||(1,"하위 워커·드라이버도 닫기".into()))}));}>"닫기"</button></div></article>}
}
#[component]
pub fn Office(#[prop(into)] query: Signal<String>) -> impl IntoView {
    let c = context();
    let zoom = RwSignal::new(1.0f64);
    view! {<div class="controls"><button class="act" on:click=move|_|zoom.update(|v|*v=(*v-0.1).max(0.4))>"−"</button><button class="act" on:click=move|_|zoom.set(1.)>"맞춤"</button><button class="act" on:click=move|_|zoom.update(|v|*v=(*v+0.1).min(2.))>"+"</button></div><div class="ru-office-scroll"><div class="ru-office" style:zoom=move||zoom.get().to_string()><For each={move||{let mut keys=c.index.get().places.into_keys().collect::<Vec<_>>();keys.sort();keys}} key=|p|p.clone() children=move|place|{let p=place.clone();view!{<section class="ru-room"><h3>{place}</h3><div class="ru-desks"><For each=move||c.rows_for(&c.index.get().places.get(&p).cloned().unwrap_or_default()) key=|r|r.key.clone() children=move|row|{let r=row.read();view!{<Show when=move||c.visible(&r.get())&&search(&r.get(),&query.get())><a class="ru-desk" href=move||session_hash(text(&r.get()["path"]))><Sprite value=r/><b>{move||label(&r.get(),&["title","id"])}</b><Status value=r/><small>{move||label(&r.get()["plan"],&["cur_text"])}</small></a></Show>}}/></div></section>}}/></div></div>}
}
#[component]
pub fn Sprite(#[prop(into)] value: Signal<Value>) -> impl IntoView {
    let c = context();
    let who = Memo::new(move |_| {
        let v = value.get();
        let roster = c.roster.get();
        let named = text(&v["char"]["who"]);
        if roster["chars"].get(named).is_some() {
            return named.to_owned();
        }
        let role = label(&v, &["role"]);
        let choices = roster["chars"]
            .as_object()
            .into_iter()
            .flat_map(|o| o.iter())
            .filter(|(_, a)| (a["boss"] == true) == (role == "coordinator") && a["driver"] != true)
            .map(|(who, _)| who.clone())
            .collect::<Vec<_>>();
        let seed = key(&v)
            .bytes()
            .fold(0usize, |a, b| a.wrapping_mul(31).wrapping_add(b as usize));
        choices
            .get(seed % choices.len().max(1))
            .cloned()
            .unwrap_or("hina".into())
    });
    let pose = Memo::new(move |_| {
        let v = value.get();
        if v["decision"].is_object() {
            6
        } else {
            match text(&v["state"]) {
                "run" => 1,
                "bg" => 2,
                "stalled" => 3,
                "idle" => 4,
                "done" => 5,
                _ => 0,
            }
        }
    });
    let node = NodeRef::<leptos::html::Div>::new();
    let visible = RwSignal::new(false);
    Effect::new(move |_| {
        if let Some(el) = node.get() {
            use wasm_bindgen::{JsCast, closure::Closure};
            let cb = Closure::<dyn FnMut(bool)>::new(move |on| visible.set(on));
            let stop = bridge::observe_visible(el.unchecked_ref(), cb.as_ref().unchecked_ref());
            let cb = send_wrapper::SendWrapper::new(cb);
            on_cleanup(move || {
                let _ = stop.call0(&wasm_bindgen::JsValue::NULL);
                drop(cb);
            });
        }
    });
    view! {<div class="ru-sprite" node_ref=node style=move||{
      let roster=c.roster.get();let name=who.get();let v=value.get();let art=&roster["chars"][&name]["art"];let state=text(&v["state"]);let animation=if state=="run"&&art["sdbr"].is_object(){"-run"}else if state=="done"&&art["sdbd"].is_object(){"-done"}else{""};let meta=&art[if animation=="-run"{"sdbr"}else if animation=="-done"{"sdbd"}else{"sdb"}];let w=number(&meta["pw"]).max(64.);let h=number(&meta["ph"]).max(80.);let n=array(&meta["top"]).len().max(8);let set=match text(&v["char"]["set"]){"b"=>1,"c"=>2,"d"=>3,_=>0};let frame=if !animation.is_empty()&&visible.get(){let clock=c.motion.get();let seed=key(&v).bytes().map(|b|b as usize).sum::<usize>();(set*8+((clock/650.)as usize+seed)%8)%n}else{(pose.get()+8*set)%n};let file=format!("{name}-sd-bust{animation}.png");let version=label(&roster["chars"][&name],&["v"]);let version=if version.is_empty(){text(&roster["files"][&file]).to_owned()}else{version};format!("width:{w}px;height:{h}px;background-image:url('chars/{file}?v={version}');background-size:{}px {h}px;background-position:{}px 0",w*n as f64,-(frame as f64)*w)
    }></div>}
}
#[component]
fn Relations() -> impl IntoView {
    let c = context();
    view! {<section class="box ru-section"><Heading title="관계 지도" note="코디네이터 → 워커 · 누르면 해당 세션"/><div class="ru-relations"><For each={move||c.rows_for(&c.index.get().roots)} key=|r|r.key.clone() children=move|row|{let r=row.clone().read();view!{<div class="ru-relation"><AgentCard row=row/><div class="ru-children"><For each={move||c.rows_for(&c.index.get().by_coord.get(&relation(&r.get(),"own_handle")).cloned().unwrap_or_default())} key=|r|r.key.clone() children=|r|view!{<AgentCard row=r/>}/></div></div>}}/></div></section>}
}
#[component]
fn Timeline() -> impl IntoView {
    let c = context();
    view! {<section class="box ru-section"><Heading title="진행 타임라인" note="시작 시간순 · 세션의 현재 단계"/><For each={move||{let mut rows=c.sessions.items.get();rows.sort_by(|a,b|text(&a.value.get()["started"]).cmp(text(&b.value.get()["started"])));rows}} key=|r|r.key.clone() children=move|row|{let r=row.read();view!{<a class="ru-timeline-row" href=move||session_hash(text(&r.get()["path"]))><time>{move||bridge::timestamp(text(&r.get()["started"]))}</time><b>{move||label(&r.get(),&["title"])}</b><Status value=r/><span>{move||label(&r.get()["plan"],&["cur_text"])}</span></a>}}/></section>}
}
#[component]
pub fn Session() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let chat = Data::default();
    let tab = RwSignal::new("summary".to_owned());
    let prompt = RwSignal::new(String::new());
    Effect::new(move |_| {
        let route = c.route.get();
        c.epoch.get();
        data.load("session", json!([route.id]), "");
    });
    Effect::new(move |_| {
        if tab.get() == "chat" {
            chat.load("chat", json!([c.route.get().id]), "");
        }
    });
    let r = Signal::derive(move || data.value.get());
    view! {<a class="back" href="#agents">"← 에이전트"</a><Heading title="세션 상세"/><ErrorLine data=data/><div class="ru-row"><h2>{move||label(&data.value.get(),&["title","id"])}</h2><Status value=r/></div><div class="ru-metrics"><Metric title="비용" value=Signal::derive(move||money(&data.value.get()["cost"]))/><Metric title="턴" value=Signal::derive(move||count(&data.value.get()["turns"]))/><Metric title="컨텍스트" value=Signal::derive(move||count(&data.value.get()["ctx_now"]))/></div><div class="controls">{[("summary","요약·계획"),("chat","대화"),("log","도구·로그"),("usage","토큰·도구")].into_iter().map(|(k,title)|view!{<button class="act" class:on=move||tab.get()==k on:click=move|_|tab.set(k.into())>{title}</button>}).collect_view()}<Action label="Orca에서 열기" method="focus" args=Signal::derive(move||json!([data.value.get()["orca_focus"]]))/></div>{move||match tab.get().as_str(){"chat"=>view!{<ErrorLine data=chat/>{move||array(&chat.value.get()).iter().map(|line|view!{<article class="box ru-section"><b>{label(line,&["role"])}</b><Markdown source=string_signal(label(line,&["text"]))/></article>}).collect_view()}}.into_any(),"log"=>view!{<div class="box ru-section">{move||array(&data.value.get()["log"]).iter().map(|l|view!{<details class="ru-log"><summary><small>{label(l,&["ts"])}</small><b>{label(l,&["role"])}</b>{label(l,&["text"])}</summary><pre>{label(l,&["detail"])}</pre></details>}).collect_view()}</div>}.into_any(),"usage"=>view!{<section class="box ru-section"><h3>"턴별 컨텍스트"</h3><Bars values=Signal::derive(move||json!(array(&data.value.get()["turn_list"]).iter().map(|t|t["ctx"].clone()).collect::<Vec<_>>()))/></section><section class="box ru-section"><h3>"도구별 사용"</h3>{move||data.value.get()["by_tool"].as_object().map(|m|m.iter().map(|(name,v)|view!{<div class="ru-row"><b>{name.clone()}</b><span>{format!("{}회 · 컨텍스트 +{}",count(&v["calls"]),count(&v["ctx_growth"]))}</span></div>}).collect_view())}</section><JsonPanel title="턴별 토큰" value=Signal::derive(move||data.value.get()["turn_list"].clone())/><JsonPanel title="도구별 사용량" value=Signal::derive(move||data.value.get()["by_tool"].clone())/><JsonPanel title="스킬·MCP" value=Signal::derive(move||json!({"skills":data.value.get()["skill_use"],"mcp":data.value.get()["mcp_use"]}))/>}.into_any(),_=>view!{<section class="box ru-section"><h3>"작업 계획"</h3>{move||array(&data.value.get()["plans"]).iter().rev().map(|p|view!{<details open><summary>{label(p,&["prompt"])}</summary><Steps steps=value_signal(p["steps"].clone())/></details>}).collect_view()}</section><section class="box ru-section"><h3>"볼트 문서"</h3>{move||array(&data.value.get()["vault_notes"]).iter().map(|n|view!{<p><a href=super::content::obsidian(c,text(&n["abs"]))>{label(n,&["title","path"])}</a></p>}).collect_view()}<h3>"읽은 설계문서"</h3>{move||array(&data.value.get()["design_refs"]).iter().map(|n|view!{<p><a href=design_hash(text(&data.value.get_untracked()["server"]),text(&n["doc"]),text(&n["section"]))>{label(n,&["doc_title","doc"])}" · "{label(n,&["section"])}</a></p>}).collect_view()}</section>}.into_any()}}<section class="box ru-section"><TextField label="후속 프롬프트" value=prompt multiline=true/><Action label="터미널에 전송" method="send" args=Signal::derive(move||json!([data.value.get()["orca_focus"],prompt.get()])) disabled=Signal::derive(move||prompt.get().trim().is_empty()||!data.value.get()["orca_focus"].is_string())/></section>}
}
#[component]
pub fn Run() -> impl IntoView {
    let c = context();
    let data = Data::default();
    Effect::new(move |_| {
        c.epoch.get();
        data.load("run", json!([c.route.get().id]), "tasks");
    });
    view! {<a class="back" href="#agents">"← 에이전트"</a><Heading title="Run"/><ErrorLine data=data/><h2>{move||label(&data.value.get()["run"],&["objective","id"])}</h2><div class="ru-grid"><For each={move||data.rows.items.get()} key=|r|r.key.clone() children=move|row|{let r=row.read();view!{<article class="box ru-section"><Status value=r field="status"/><h3>{move||label(&r.get(),&["display_name","task_title","id"])}</h3><Markdown source=Signal::derive(move||label(&r.get(),&["spec"]))/><details><summary>"결과"</summary><Markdown source=Signal::derive(move||label(&r.get(),&["result"]))/></details><JsonPanel title="의존성·워커" value=r/></article>}}/></div>}
}
#[component]
pub fn Driver() -> impl IntoView {
    let c = context();
    let data = Data::default();
    Effect::new(move |_| {
        c.epoch.get();
        data.load("implProgress", json!([{"term":c.route.get().id}]), "");
    });
    view! {<a class="back" href="#agents">"← 에이전트"</a><Heading title="드라이버 진행"/><ErrorLine data=data/>{move||array(&data.value.get()).iter().map(|p|view!{<section class="box ru-section"><h2>{label(p,&["title","launch"])}</h2>{array(&p["tickets"]).iter().map(|t|view!{<details open><summary><b>{label(t,&["key"])}</b>" · "{label(t,&["current","state"])}</summary><Steps steps=value_signal(t["items"].clone())/></details>}).collect_view()}</section>}).collect_view()}<section class="box ru-section"><h2>"외부 계획"</h2>{move||array(&c.state.get()["ext_plans"]).iter().filter(|p|p["coordinator_terminal"]==c.route.get().id||p["scheduler_terminal"]==c.route.get().id).map(|p|view!{<JsonPanel title="티켓·실행·E2E 계획" value=value_signal(p.clone())/>}).collect_view()}</section>}
}

#[component]
fn OrcaBoard() -> impl IntoView {
    let c = context();
    let runs = Rows::default();
    let drivers = Rows::default();
    Effect::new(move |_| {
        let s = c.state.get();
        runs.sync(array(&s["orca"]["runs"]).to_vec());
        drivers.sync(
            array(&s["orca"]["terminals"])
                .iter()
                .filter(|t| {
                    t["role"] == "driver"
                        || t["title"].as_str().is_some_and(|v| {
                            v.contains("드라이버") || v.to_lowercase().contains("driver")
                        })
                })
                .cloned()
                .collect(),
        );
    });
    view! {<Heading title="Orca Run" note="작업 의존성과 워커 진행"/><div class="ru-grid"><For each=move||runs.items.get() key=|r|r.key.clone() children=|row|{let r=row.read();view!{<a class="box ru-section" href=move||format!("#r={}",urlencoding::encode(text(&r.get()["id"])) )><Status value=r field="status"/><h3>{move||label(&r.get(),&["objective","title","id"])}</h3><small>{move||label(&r.get(),&["created_at"])}</small></a>}}/></div><Heading title="드라이버"/><div class="ru-grid"><For each=move||drivers.items.get() key=|r|r.key.clone() children=|row|{let r=row.read();view!{<a class="box ru-section" href=move||format!("#dr={}",urlencoding::encode(text(&r.get()["handle"])) )><h3>{move||label(&r.get(),&["title","handle"])}</h3><Status value=r/></a>}}/></div>}
}
