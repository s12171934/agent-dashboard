use crate::{bridge, components::*, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};

#[component]
pub fn Projects() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let query = RwSignal::new(String::new());
    let timeline = RwSignal::new(false);
    Effect::new(move |_| {
        c.projects_epoch.get();
        data.load("projects", json!([]), "projects");
    });
    view! {<Heading title="프로젝트" note="단계·스텝·일정과 연결된 문서"/><div class="controls"><Search value=query/><label><input type="checkbox" on:change=move|e|timeline.set(event_target_checked(&e))/>"시계열로 보기"</label></div><ErrorLine data=data/><Sources data=data/><div class="ru-list" class:ru-project-timeline=move||timeline.get()><For each={move||{let mut rows=data.rows.items.get().into_iter().filter(|r|search(&r.value.get(),&query.get())).collect::<Vec<_>>();if timeline.get(){rows.sort_by_key(|r|label(&r.value.get(),&["start"]));}rows}} key=|r|r.key.clone() children=|row|view!{<ProjectCard row=row/>}/></div>}
}
#[component]
fn Sources(data: Data) -> impl IntoView {
    view! {<Show when=move||data.value.get()["enabled"]==false><Empty text="연결된 서버에서 제공하는 문서가 없습니다"/>{move||array(&data.value.get()["sources"]).iter().map(|s|view!{<p class="ru-muted">{label(s,&["server"])}" · "{match text(&s["state"]){"off"=>"서버에서 이 기능을 제공하지 않습니다","old"=>"서버 업데이트가 필요합니다","error"=>"연결할 수 없습니다",v=>v}.to_owned()}</p>}).collect_view()}</Show>}
}
#[component]
fn ProjectCard(row: Row) -> impl IntoView {
    let c = context();
    let r = row.read();
    let open = RwSignal::new(false);
    let full = Data::default();
    let note = Data::default();
    let path = RwSignal::new(String::new());
    Effect::new(move |_| {
        if open.get() {
            c.projects_epoch.get();
            let v = r.get();
            full.load("project", json!([v["server"], v["name"]]), "");
        }
    });
    Effect::new(move |_| {
        let p = path.get();
        if !p.is_empty() {
            let v = r.get();
            note.load("note", json!([v["server"], v["name"], p]), "");
        }
    });
    view! {<article class="box ru-section"><button class="ru-summary" aria-expanded=move||open.get() on:click=move|_|open.update(|v|*v = !*v)><h2>{move||label(&r.get(),&["name"])}</h2><Status value=r field="status"/><b>{move||format!("{:.0}% · {} / {}",number(&r.get()["ratio"])*100.,count(&r.get()["counts"]["done"]),count(&r.get()["total"]))}</b></button><Progress ratio=Signal::derive(move||number(&r.get()["ratio"]))/><p class="ru-muted">{move||format!("{} → {} · 현재 {}",label(&r.get(),&["start"]),label(&r.get(),&["end"]),label(&r.get()["current"],&["name"]))}</p><div class="ru-stage-track">{move||array(&r.get()["stages"]).iter().map(|s|view!{<span class="ru-status" data-state=label(s,&["status"])>{format!("{}. {}",s["no"],label(s,&["name"]))}</span>}).collect_view()}</div><Show when=move||open.get()><ErrorLine data=full/><div class="ru-split"><div>{move||array(&full.value.get()["stages"]).iter().map(|s|view!{<section class="ru-section"><h3>{format!("{}. {}",s["no"],label(s,&["name"]))}</h3><p class="ru-muted">{format!("{} → {}",label(s,&["start"]),label(s,&["end"]))}</p><ol class="ru-steps">{array(&s["steps"]).iter().map(|st|{let p=label(st,&["path"]);view!{<li data-state=label(st,&["status"])><button class="ru-link" on:click=move|_|path.set(p.clone())>{label(st,&["title","path"])}</button><small>{format!("{} · {} → {}",state_label(text(&st["status"])),label(st,&["date"]),label(st,&["endDate"]))}</small></li>}}).collect_view()}</ol></section>}).collect_view()}</div><Show when=move||!path.get().is_empty()><aside class="ru-note"><button class="act" on:click=move|_|path.set(String::new())>"문서 닫기"</button><ErrorLine data=note/><Markdown source=Signal::derive(move||label(&note.value.get(),&["content"]))/><div class="ru-actions">{move||array(&note.value.get()["links"]).iter().filter(|v|v["path"].is_string()).map(|l|{let p=label(l,&["path"]);view!{<button class="act" on:click=move|_|path.set(p.clone())>{label(l,&["target","path"])}</button>}}).collect_view()}</div><a href=move||obsidian(c,&label(&note.value.get(),&["abs"]))>"Obsidian에서 열기"</a></aside></Show></div></Show></article>}
}
pub fn obsidian(c: Context, path: &str) -> String {
    let state = c.state.get_untracked();
    if let Some(root) = array(&state["vaults"])
        .iter()
        .filter_map(Value::as_str)
        .find(|v| path.starts_with(&format!("{v}/")))
    {
        let vault = root.rsplit('/').next().unwrap_or("");
        let relative = path[root.len() + 1..].trim_end_matches(".md");
        format!(
            "obsidian://open?vault={}&file={}",
            urlencoding::encode(vault),
            urlencoding::encode(relative)
        )
    } else {
        format!("obsidian://open?path={}", urlencoding::encode(path))
    }
}
#[component]
pub fn Designs() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let doc = Data::default();
    let query = RwSignal::new(String::new());
    let recent = Data::default();
    let readers = RwSignal::new(true);
    let meta = Memo::new(move |_| {
        let r = c.route.get();
        (r.server, r.id)
    });
    let version = Memo::new(move |_| c.state.get()["design"]["version"].clone());
    Effect::new(move |_| {
        version.get();
        data.load("designs", json!([]), "docs");
        recent.load("vaultRecent", json!([30]), "notes");
    });
    Effect::new(move |_| {
        let (server, key) = meta.get();
        if !key.is_empty() {
            doc.load("design", json!([server, key]), "");
        }
    });
    Effect::new(move |_| {
        let r = c.route.get();
        doc.value.get();
        if !r.section.is_empty() {
            bridge::scroll_id(&format!("design-{}", r.section));
        }
    });
    view! {<Heading title="설계문서" note="문서·챕터와 읽은 세션의 연결"/><ErrorLine data=data/><Sources data=data/><div class="ru-design"><aside class="box ru-section ru-doc-side"><details open=move||c.route.get().id.is_empty()><summary>"문서 선택"</summary><Search value=query/><nav class="ru-doc-list"><For each={move||data.rows.items.get().into_iter().filter(|r|search(&r.value.get(),&query.get())).collect::<Vec<_>>()} key=|r|r.key.clone() children=|row|{let r=row.read();view!{<a href=move||design_hash(text(&r.get()["server"]),text(&r.get()["key"]),"")><b>{move||label(&r.get(),&["title","key"])}</b><small>{move||format!("{} · {}개 세션",label(&r.get(),&["chapter","ch"]),count(&r.get()["sessions"]))}</small></a>}}/></nav></details><details><summary>"최근 볼트 문서"</summary><For each=move||recent.rows.items.get() key=|r|r.key.clone() children=move|row|{let r=row.read();view!{<p><a href=move||obsidian(c,text(&r.get()["abs"]))>{move||label(&r.get(),&["title","path"])}</a><small>{move||label(&r.get(),&["session_title"])}</small></p>}}/></details></aside><section class="ru-doc-main"><ErrorLine data=doc/><Show when=move||!c.route.get().id.is_empty()><div class="box ru-section"><h2>{move||label(&doc.value.get(),&["title","key"])}</h2><p class="ru-muted">{move||format!("{} · {}",label(&doc.value.get()["source"],&["repo","dir"]),label(&doc.value.get()["source"],&["branch"]))}</p><div class="controls"><button class="act" on:click=move|_|readers.update(|v|*v = !*v)>"읽은 세션"</button><a class="act" target="_blank" rel="noopener" href=move||file_url(c,"design",&c.route.get().server,&c.route.get().id)>"원본 열기"</a></div><nav class="ru-toc">{move||array(&doc.value.get()["toc"]).iter().map(|s|view!{<a href=design_hash(&c.route.get_untracked().server,&c.route.get_untracked().id,text(&s["id"]))>{label(s,&["title"])}</a>}).collect_view()}</nav></div>{move||match text(&doc.value.get()["kind"]){"image"=>view!{<img class="ru-design-image" src=file_url(c,"design",&c.route.get_untracked().server,&c.route.get_untracked().id) alt=c.route.get_untracked().id/>}.into_any(),"pdf"=>view!{<iframe class="ru-pdf" title="설계 PDF" src=file_url(c,"design",&c.route.get_untracked().server,&c.route.get_untracked().id)></iframe>}.into_any(),_=>view!{<article class="box ru-section ru-markdown" inner_html=move||design_markdown(&doc.value.get())></article>}.into_any()}}<Show when=move||readers.get()><div class="box ru-section"><h3>"읽은 세션"</h3>{move||array(&doc.value.get()["refs"]).iter().map(|s|view!{<a class="ru-reader" href=session_hash(text(&s["path"]))><b>{label(s,&["title","session"])}</b><small>{format!("{} · 읽기 {} · 검색 {} · 커버 {}%",label(s,&["section"]),count(&s["reads"]),count(&s["searches"]),number(&s["cover"])*100.)}</small></a>}).collect_view()}<JsonPanel title="문서 복사본·구현 기준 커밋" value=Signal::derive(move||json!({"copies":doc.value.get()["copies"],"plans":doc.value.get()["plans"]})) /></div></Show></Show></section></div>}
}
fn design_markdown(doc: &Value) -> String {
    let source = text(&doc["content"]);
    let mut html = markdown(source);
    for s in array(&doc["toc"]) {
        let title = markdown(text(&s["title"]));
        let title = title
            .trim()
            .trim_start_matches("<p>")
            .trim_end_matches("</p>");
        let id = label(s, &["id"]).replace(['"', '<', '>', '&'], "");
        for level in 1..=6 {
            let needle = format!("<h{level}>{title}</h{level}>");
            if html.contains(&needle) {
                html = html.replacen(
                    &needle,
                    &format!("<h{level} id=\"design-{id}\">{title}</h{level}>"),
                    1,
                );
                break;
            }
        }
    }
    html
}
pub fn file_url(c: Context, kind: &str, server: &str, path: &str) -> String {
    let url = c.servers.with_untracked(|s| {
        array(s)
            .iter()
            .find(|s| s["id"] == server)
            .map(|s| label(s, &["url"]))
            .unwrap_or_default()
    });
    format!(
        "{}/api/{kind}/file?path={}",
        url.trim_end_matches('/'),
        urlencoding::encode(path)
    )
}
#[component]
pub fn Media() -> impl IntoView {
    let data = Data::default();
    let query = RwSignal::new(String::new());
    let selected = RwSignal::new(String::new());
    let kind = RwSignal::new(String::new());
    data.load("media", json!([]), "videos");
    view! {<Heading title="녹화 영상" note="QA·학습 영상 · 타임라인 · 자막 · 앱 PiP"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|kind.set(event_target_value(&e))><option value="">"전체"</option><option value="qa">"QA"</option><option value="learn">"학습"</option></select><button class="act" on:click=move|_|data.load("media",json!([]),"videos")>"새로 고침"</button></div><ErrorLine data=data/><div class="ru-media-layout"><aside class="ru-list"><For each={move||data.rows.items.get().into_iter().filter(|r|{let v=r.value.get();search(&v,&query.get())&&(kind.get().is_empty()||v["kind"]==kind.get())}).collect::<Vec<_>>()} key=|r|r.key.clone() children=move|row|{let id=row.key.clone();let id2=id.clone();let r=row.read();view!{<button class="box ru-section ru-media-choice" class:on=move||selected.get()==id2 on:click={let id=id.clone();move|_|selected.set(id.clone())}><b>{move||label(&r.get(),&["name","path"])}</b><small>{move||format!("{} · {} MB",label(&r.get(),&["kind"]),number(&r.get()["size"])/1048576.)}</small></button>}}/></aside><section>{move||{let id=selected.get();let row=data.rows.get(&id);row.map(|row|view!{<Player row=row/>})}}</section></div><Show when=move||!array(&data.value.get()["missing"]).is_empty()><JsonPanel title="파일을 찾을 수 없는 녹화" value=Signal::derive(move||data.value.get()["missing"].clone())/></Show>}
}
#[component]
fn Player(row: Row) -> impl IntoView {
    let c = context();
    let r = row.read();
    let video = NodeRef::<leptos::html::Video>::new();
    let now = RwSignal::new(0.0);
    let caption = RwSignal::new(true);
    let full = RwSignal::new(false);
    Effect::new(move |_| {
        if let Some(v) = video.get() {
            let cleanup = bridge::video_bridge(&v);
            on_cleanup(move || {
                let _ = cleanup.call0(&wasm_bindgen::JsValue::NULL);
            });
        }
    });
    let seek = move |t: f64| {
        if let Some(v) = video.get_untracked() {
            v.set_current_time(t);
        }
    };
    view! {<div class="box ru-section ru-player" class:ru-player-full=move||full.get()><h2>{move||label(&r.get(),&["name"])}</h2><video node_ref=video controls playsinline src=move||file_url(c,"media",text(&r.get()["server"]),text(&r.get()["path"])) on:timeupdate=move|_|{if let Some(v)=video.get_untracked(){now.set(v.current_time());}}></video><div class="controls"><button class="act" on:click=move|_|full.update(|v|*v = !*v)>{move||if full.get(){"크게 보기 닫기"}else{"크게 보기"}}</button><label>"속도 "<select class="field" on:change=move|e|{if let Some(v)=video.get_untracked(){v.set_playback_rate(event_target_value(&e).parse().unwrap_or(1.));}}>{[0.5,1.,1.25,1.5,2.].into_iter().map(|n|view!{<option value=n.to_string() selected=n==1.>{format!("{n}×")}</option>}).collect_view()}</select></label><label><input type="checkbox" checked on:change=move|e|caption.set(event_target_checked(&e))/>"자막"</label></div><Show when=move||caption.get()><p class="ru-caption" aria-live="off">{move||array(&r.get()["captions"]).iter().rev().find(|s|number(&s["t"])<=now.get()).map(|s|label(s,&["text"])).unwrap_or_default()}</p></Show><div class="ru-timeline-notes">{move||array(&r.get()["timeline"]).iter().map(|s|{let t=number(&s["t"]);view!{<button class="ru-row" on:click=move|_|seek(t)><time>{format!("{}:{:02}",(t as u64)/60,(t as u64)%60)}</time><span class="ru-status">{label(s,&["kind"])}</span><span>{label(s,&["text"])}</span></button>}}).collect_view()}</div></div>}
}
#[component]
pub fn Canvas() -> impl IntoView {
    let data = Data::default();
    let selected = RwSignal::new(String::new());
    data.load("canvas", json!([]), "");
    view! {<Heading title="워크플로 캔버스" note="연결된 맥에서 제공하는 캔버스"/><button class="act" on:click=move|_|data.load("canvas",json!([]),"")>"연결 새로 고침"</button><ErrorLine data=data/><div class="controls"><For each=move||data.rows.items.get() key=|r|r.key.clone() children=move|row|{let r=row.read();view!{<button class="act" disabled=move||r.get()["up"]!=true on:click=move|_|selected.set(label(&r.get_untracked(),&["url"]))>{move||label(&r.get(),&["name","server"])}" · "{move||if r.get()["up"]==true{"연결됨".into()}else{label(&r.get(),&["error"])}}</button>}}/></div><WebPanel url=Signal::derive(move||selected.get())/>}
}
