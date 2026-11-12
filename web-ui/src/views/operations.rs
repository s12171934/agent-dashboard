use crate::{bridge, components::*, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};
use wasm_bindgen::JsCast;
#[component]
fn ServerSelect(value: RwSignal<String>) -> impl IntoView {
    let c = context();
    Effect::new(move |_| {
        let servers = c.servers.get();
        let ids = array(&servers)
            .iter()
            .filter(|s| s["on"] != false)
            .map(|s| label(s, &["id"]))
            .collect::<Vec<_>>();
        if !ids.contains(&value.get_untracked()) {
            value.set(ids.first().cloned().unwrap_or_default());
        }
    });
    view! {<label class="ru-field"><span>"서버"</span><select class="field" prop:value=move||value.get() on:change=move|e|value.set(event_target_value(&e))>{move||array(&c.servers.get()).iter().filter(|s|s["on"]!=false).map(|s|view!{<option value=label(s,&["id"])>{label(s,&["name","id"])}</option>}).collect_view()}</select></label>}
}
#[component]
pub fn Launch() -> impl IntoView {
    let c = context();
    let server = RwSignal::new(String::new());
    let mode = RwSignal::new("worktree".to_owned());
    let places = Data::default();
    let repo = RwSignal::new(String::new());
    let wt = RwSignal::new(String::new());
    let name = RwSignal::new(String::new());
    let agent = RwSignal::new("claude".to_owned());
    let model = RwSignal::new(String::new());
    let effort = RwSignal::new(String::new());
    let title = RwSignal::new(String::new());
    let prompt = RwSignal::new(String::new());
    let handle = RwSignal::new(String::new());
    Effect::new(move |_| {
        let s = server.get();
        if !s.is_empty() {
            places.load("places", json!([s, false]), "");
        }
    });
    view! {<div class="controls">{[("worktree","새 워크트리"),("agent","기존 워크트리"),("send","프롬프트 보내기")].into_iter().map(|(k,t)|view!{<button class="act" class:on=move||mode.get()==k on:click=move|_|mode.set(k.into())>{t}</button>}).collect_view()}</div><ServerSelect value=server/><ErrorLine data=places/>
    <Show when=move||mode.get()!="send"><label class="ru-field"><span>{move||if mode.get()=="worktree"{"저장소"}else{"워크트리"}}</span><select class="field" prop:value=move||if mode.get()=="worktree"{repo.get()}else{wt.get()} on:change=move|e|{let v=event_target_value(&e);if mode.get_untracked()=="worktree"{repo.set(v);}else{wt.set(v);}}><option value="">"고르세요"</option>{move||array(&places.value.get()[if mode.get()=="worktree"{"repos"}else{"worktrees"}]).iter().map(|v|view!{<option value=label(v,&["id"])>{label(v,&["name","path"])}</option>}).collect_view()}</select></label><Show when=move||mode.get()=="worktree"><TextField label="워크트리 이름" value=name/></Show><label class="ru-field"><span>"에이전트"</span><select class="field" on:change=move|e|agent.set(event_target_value(&e))><option value="claude">"Claude"</option><option value="codex">"Codex"</option></select></label><TextField label="모델 (비우면 기본값)" value=model/><label class="ru-field"><span>"추론 강도"</span><select class="field" disabled=move||model.get().is_empty() on:change=move|e|effort.set(event_target_value(&e))><option value="">"기본"</option>{["low","medium","high","xhigh","max"].into_iter().map(|v|view!{<option value=v>{v}</option>}).collect_view()}</select></label><TextField label="탭 이름" value=title/><button class="act" on:click=move|_|places.load("places",json!([server.get_untracked(),true]),"")>"목록 새로 고침"</button></Show>
    <Show when=move||mode.get()=="send"><label class="ru-field"><span>"보낼 에이전트"</span><select class="field" prop:value=move||handle.get() on:change=move|e|handle.set(event_target_value(&e))><option value="">"고르세요"</option>{move||c.sessions.items.get().into_iter().filter(|r|r.value.get()["orca_focus"].is_string()).map(|r|{let v=r.value.get();view!{<option value=label(&v,&["orca_focus"])>{label(&v,&["title","id"])}</option>}}).collect_view()}</select></label></Show><TextField label="프롬프트" value=prompt multiline=true/>
    <Action label="실행·전송" method="launch" dynamic_method=Signal::derive(move||if mode.get()=="send"{"send".to_owned()}else{"launch".to_owned()}) args=Signal::derive(move||if mode.get()=="send"{json!([handle.get(),prompt.get()])}else{json!([server.get(),{"kind":mode.get(),"repo":repo.get(),"worktree":wt.get(),"name":name.get().trim(),"agent":agent.get(),"model":model.get(),"effort":if model.get().is_empty(){String::new()}else{effort.get()},"title":title.get(),"prompt":prompt.get()}])}) disabled=Signal::derive(move||server.get().is_empty()||if mode.get()=="send"{handle.get().is_empty()||prompt.get().trim().is_empty()}else if mode.get()=="worktree"{repo.get().is_empty()||!valid_name(&name.get())}else{wt.get().is_empty()})/>
    }
}
fn valid_name(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty()
        && s.len() <= 60
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
#[component]
pub fn Worktrees() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let rows = Rows::default();
    let query = RwSignal::new(String::new());
    let dirty = RwSignal::new(false);
    let stamp = Memo::new(move |_| c.pulse.get());
    Effect::new(move |_| {
        stamp.get();
        data.load("worktrees", json!([false]), "");
    });
    Effect::new(move |_| {
        let mut ws = vec![];
        for s in array(&data.value.get()["servers"]) {
            for rp in array(&s["repos"]) {
                for w in array(&rp["worktrees"]) {
                    let mut w = w.clone();
                    w["server"] = s["server"].clone();
                    w["local"] = s["local"].clone();
                    w["repository"] = rp["name"].clone();
                    ws.push(w);
                }
            }
        }
        rows.sync(ws);
    });
    view! {<Heading title="워크트리" note="저장소·브랜치·변경·서브모듈과 메모"/><div class="controls"><Search value=query/><label><input type="checkbox" on:change=move|e|dirty.set(event_target_checked(&e))/>"미커밋 있는 것만"</label><button class="act" on:click=move|_|data.load("worktrees",json!([true]),"")>"새로 고침"</button></div><ErrorLine data=data/><div class="ru-list"><For each={move||rows.items.get().into_iter().filter(|r|{let v=r.value.get();search(&v,&query.get())&&(!dirty.get()||number(&v["dirty"])>0.)}).collect::<Vec<_>>()} key=|r|r.key.clone() children=|row|view!{<WorktreeCard row=row/>}/></div>{move||array(&data.value.get()["servers"]).iter().flat_map(|s|array(&s["repos"])).filter(|r|r["error"].is_string()).map(|r|view!{<p class="ru-error">{label(r,&["name"])}" · "{label(r,&["error"])}</p>}).collect_view()}}
}
#[component]
fn WorktreeCard(row: Row) -> impl IntoView {
    let c = context();
    let r = row.read();
    let editing = RwSignal::new(false);
    let note = RwSignal::new(String::new());
    let web = RwSignal::new(String::new());
    view! {<article class="box ru-section" data-tr=move||identity(&r.get())><div class="ru-row"><small>{move||label(&r.get(),&["repository"])}</small><h3>{move||label(&r.get(),&["name"])}</h3><b>{move||label(&r.get(),&["branch","head"])}</b><span>{move||format!("미커밋 {}",count(&r.get()["dirty"]))}</span>{move||["main","orca","detached","locked","prunable","missing"].iter().filter(|k|r.get()[**k]==true).map(|k|view!{<span class="ru-status">{*k}</span>}).collect_view()}</div><code>{move||label(&r.get(),&["path"])}</code><p>{move||label(&r.get(),&["comment","subject"])}</p><div class="ru-actions"><button class="act" on:click=move|_|{note.set(label(&r.get_untracked()["note"],&["text"]));editing.set(true);}>"메모 수정"</button><Action label="에디터로 열기" method="worktreeOpen" args=Signal::derive(move||json!([r.get()["server"],r.get()["path"],c.editor.get()])) disabled=Signal::derive(move||r.get()["local"]!=true||r.get()["missing"]==true)/><button class="act" disabled=move||r.get()["local"]!=true||r.get()["missing"]==true on:click=move|_|{if !web.get_untracked().is_empty(){web.set(String::new());return;}let v=r.get_untracked();leptos::task::spawn_local(async move{match c.request("worktreeWeb",json!([v["server"],v["path"]])).await{Ok(v)=>{let _=web.try_set(label(&v["body"],&["url"]));},Err(e)=>c.toast.set(e)}});}>"웹 편집기 열기·닫기"</button><Show when=move||r.get()["main"]!=true&&r.get()["bare"]!=true><button class="act danger" disabled=move||r.get()["local"]!=true on:click=move|_|{let v=r.get_untracked();c.ask("워크트리 삭제",format!("{}\n{}\n이 워크트리의 폴더와 git 등록을 삭제합니다.",label(&v,&["name"]),label(&v,&["path"])),"worktreeRemove",json!([v["server"],v["path"],false]));}>"삭제"</button></Show></div><div class="ru-submodules">{move||array(&r.get()["submodules"]).iter().map(|s|view!{<span class="ru-status">{label(s,&["path"])}" · "{label(s,&["branch","head"])}</span>}).collect_view()}</div><p class="ru-worktree-note">{move||label(&r.get()["note"],&["text"])}</p><Show when=move||editing.get()><TextField label="워크트리 메모" value=note multiline=true/><div class="ru-actions"><button class="act" on:click=move|_|editing.set(false)>"취소"</button><button class="act accent" on:click=move|_|{let v=r.get_untracked();let text=note.get_untracked();leptos::task::spawn_local(async move{match c.request("worktreeNote",json!([v["server"],v["path"],text])).await{Ok(_)=>{let _=editing.try_set(false);},Err(e)=>c.toast.set(e)}});}>"저장"</button></div></Show><WebPanel url=Signal::derive(move||web.get())/></article>}
}
#[component]
pub fn Reviews() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let query = RwSignal::new(String::new());
    let stage = RwSignal::new(String::new());
    let stamp = Memo::new(move |_| c.state.get()["reviews_at"].clone());
    Effect::new(move |_| {
        stamp.get();
        data.load("reviews", json!([]), "sets");
    });
    view! {<Heading title="QA · 워크트리 리뷰" note="티켓 진행·자동화·변경 검토와 승인"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|stage.set(event_target_value(&e))><option value="">"전체 리뷰"</option>{[("pending","리뷰 대기"),("done","리뷰 완료"),("changed","리뷰 후 변경"),("reopened","재오픈"),("none","워크트리 없음")].into_iter().map(|(v,t)|view!{<option value=v>{t}</option>}).collect_view()}</select></div><ErrorLine data=data/><div class="ru-list"><For each=move||data.rows.items.get() key=|r|r.key.clone() children=move|row|view!{<ReviewSet row=row query=query stage=stage jira=Signal::derive(move||label(&data.value.get(),&["jira"]))/>}/></div>}
}
const QA: &[(&str, &str)] = &[
    ("selected", "선별"),
    ("worktree", "워크트리"),
    ("analysis", "분석"),
    ("implementing", "구현"),
    ("reviewing", "검토"),
    ("committed", "커밋 완료"),
    ("approved", "반출 승인"),
    ("delivered", "반출"),
    ("cleaned", "정리"),
];
#[component]
fn ReviewSet(
    row: Row,
    query: RwSignal<String>,
    stage: RwSignal<String>,
    jira: Signal<String>,
) -> impl IntoView {
    let c = context();
    let r = row.read();
    let tickets = Rows::default();
    Effect::new(move |_| {
        let set = r.get();
        tickets.sync(
            array(&set["tickets"])
                .iter()
                .map(|t| {
                    let mut t = t.clone();
                    t["server"] = set["server"].clone();
                    t
                })
                .collect(),
        );
    });
    view! {<section class="box ru-section"><h2>{move||format!("{} · {}",label(&r.get(),&["epic"]),label(&r.get(),&["summary"]))}</h2><p class="ru-error">{move||label(&r.get(),&["error"])}</p><Show when=move||r.get()["retired"]==true><p class="ru-status" data-state="done">"종료된 QA · 읽기 전용"</p></Show><div class="ru-metrics">{move||["total","pass","fail","blocked","ntest"].into_iter().filter(|k|!r.get()["sheet"][*k].is_null()).map(|k|view!{<Metric title=k value=string_signal(count(&r.get_untracked()["sheet"][k]))/>}).collect_view()}</div><a target="_blank" rel="noopener" href=move||label(&r.get()["sheet"],&["url"])>"TC 시트 열기"</a><Show when=move||r.get()["retired"]!=true><div class="ru-list">{move||array(&r.get()["automations"]).iter().map(|a|{let args=json!([r.get_untracked()["server"],r.get_untracked()["epic"],a["id"],if a["enabled"]==true{"disable"}else{"enable"}]);view!{<div class="ru-row"><b>{label(a,&["name","id"])}</b><small>{label(a,&["rrule"])}" · "{label(a,&["next"])}</small><Action label=if a["enabled"]==true{"끄기"}else{"켜기"} method="qaAutomation" args=value_signal(args)/><Action label="지금 실행" method="qaAutomation" args=value_signal(json!([r.get_untracked()["server"],r.get_untracked()["epic"],a["id"],"run"])) /></div>}}).collect_view()}</div><details><summary>"QA 묶음 관리"</summary><Adopt set=r/><div class="ru-actions"><Action label="종료 보고서 작성" method="qaTicket" args=Signal::derive(move||json!([r.get()["server"],r.get()["epic"],null,"report"])) confirm=true/><button class="act" on:click=move|_|qa_check(c,r.get_untracked(),Value::Null,"retire_check","retire","QA 종료")>"QA 종료 점검"</button><Action label="끝난 티켓 터미널 닫기" method="qaTicket" confirm=true args=Signal::derive(move||json!([r.get()["server"],r.get()["epic"],null,"close_finished",{"keys":array(&r.get()["tickets"]).iter().filter(|t|["delivered","cleaned"].contains(&text(&t["qa"]["stage"]))).map(|t|t["key"].clone()).collect::<Vec<_>>()}]))/></div></details></Show>
    <div class="ru-list"><For each={move||tickets.items.get().into_iter().filter(|row|{let v=row.value.get();search(&v,&query.get())&&(stage.get().is_empty()||v["review"]==stage.get())}).collect::<Vec<_>>()} key=|r|r.key.clone() children=move|row|view!{<Ticket row=row set=r jira=jira/>}/></div><JsonPanel title="QA 통계·보고서·착수 시트" value=Signal::derive(move||json!({"stats":r.get()["stats"],"report":r.get()["report"],"sheet":r.get()["sheet"]})) /></section>}
}
fn qa_check(
    c: Context,
    set: Value,
    key: Value,
    check: &'static str,
    action: &'static str,
    title: &'static str,
) {
    leptos::task::spawn_local(async move {
        match bridge::call("qaTicket", json!([set["server"], set["epic"], key, check])).await {
            Ok(v) => {
                let out = label(&v["body"], &["output", "error"]);
                if v["status"] != 200 || v["body"]["code"] == 3 {
                    c.output.set(out);
                } else {
                    c.ask(
                        title,
                        out,
                        "qaTicket",
                        json!([set["server"], set["epic"], key, action]),
                    );
                }
            }
            Err(e) => c.toast.set(e),
        }
    });
}
#[component]
fn Ticket(row: Row, set: Signal<Value>, jira: Signal<String>) -> impl IntoView {
    let c = context();
    let r = row.read();
    let web = RwSignal::new(String::new());
    let webdata = Data::default();
    let enabled = Signal::derive(move || set.get()["retired"] != true);
    let early = Signal::derive(move || {
        let s = set.get();
        let v = r.get();
        s["driver"] == true
            && v["qa"].is_object()
            && number(&v["qa"]["stage_no"])
                < array(&s["stages"])
                    .iter()
                    .position(|v| v == "committed")
                    .map(|i| i as f64 + 1.)
                    .unwrap_or(6.)
            && v["review"] != "done"
    });
    view! {<article class="ru-ticket" data-wt-tk=move||label(&r.get(),&["key"])><div class="ru-row"><a target="_blank" rel="noopener" href=move||format!("{}/browse/{}",jira.get(),label(&r.get(),&["key"]))><b>{move||label(&r.get(),&["key"])}</b></a><span class="ru-status" data-state=move||label(&r.get(),&["review"])>{move||label(&r.get(),&["review"])}</span><span>{move||label(&r.get(),&["status"])}</span><h3>{move||label(&r.get(),&["summary"])}</h3></div><div class="ru-stage-track">{QA.iter().map(|(k,t)|{let k=*k;view!{<span class="ru-status" class:on=move||r.get()["qa"]["stage"]==k>{*t}</span>}}).collect_view()}</div><p class="ru-error">{move||label(&r.get()["qa"],&["blocked_reason"])}</p><p>{move||format!("{} / {} 워커 완료 · {}회차",count(&r.get()["qa"]["done"]),count(&r.get()["qa"]["handoffs"]),count(&r.get()["qa"]["round"]))}</p><div class="ru-actions">{move||array(&r.get()["qa"]["prs"]).iter().map(|u|view!{<a href=text(u).to_owned() target="_blank" rel="noopener">"PR 열기"</a>}).collect_view()}<a href=move||super::content::obsidian(c,text(&r.get()["step"]))>"스텝 노트"</a></div><div class="ru-repos">{move||array(&r.get()["repos"]).iter().chain(array(&r.get()["gone"])).map(|rp|view!{<div class="ru-row"><b>{label(rp,&["repo"])}</b><code>{label(rp,&["branch"])}</code><small>{format!("vs {} · {}파일 · +{} / −{} · 미커밋 {}",label(rp,&["base_ref","base"]),count(&rp["files"]),count(&rp["ins"]),count(&rp["dels"]),count(&rp["dirty"]))}</small><a target="_blank" rel="noopener" href=label(&rp["pr"],&["url"])>{label(&rp["pr"],&["state"])}</a></div>}).collect_view()}</div>
    <Show when=move||enabled.get()><div class="ru-actions"><Action label="에디터로 열기" method="reviewOpen" args=Signal::derive(move||json!([r.get()["server"],r.get()["key"],c.editor.get()])) disabled=Signal::derive(move||set.get()["local"]!=true)/><button class="act" on:click=move|_|webdata.load("reviewWeb",json!([r.get_untracked()["server"],r.get_untracked()["key"]]),"")>"웹 편집기"</button><Action label="리뷰 완료·취소" method="reviewMark" args=Signal::derive(move||json!([r.get()["server"],r.get()["key"],r.get()["review"]!="done"])) disabled=Signal::derive(move||early.get()||!r.get()["step"].is_string()) confirm=true/><Show when=move||set.get()["driver"]==true&&r.get()["qa"]["stage"]=="committed"><Action label="반출 승인" method="qaTicket" args=Signal::derive(move||json!([r.get()["server"],set.get()["epic"],r.get()["key"],"approve"])) confirm=true/></Show><Show when=move||set.get()["driver"]!=true><Action label="PR 후 머지" method="reviewShip" args=Signal::derive(move||json!([r.get()["server"],r.get()["key"]])) confirm=true/></Show><Show when=move||r.get()["qa"]["stage"]=="delivered"&&r.get()["qa"]["merge_at"].is_null()><Action label="PR 머지 지시" method="qaTicket" args=Signal::derive(move||json!([r.get()["server"],set.get()["epic"],r.get()["key"],"merge"])) confirm=true/></Show><button class="act" on:click=move|_|qa_check(c,set.get_untracked(),r.get_untracked()["key"].clone(),"cleanup_check","cleanup","워크트리 정리")>"워크트리 정리 점검"</button><Action label="코디네이터 재기동" method="qaTicket" args=Signal::derive(move||json!([r.get()["server"],set.get()["epic"],r.get()["key"],"restart"])) confirm=true/></div></Show><ErrorLine data=webdata/><div class="controls">{move||array(&webdata.value.get()["body"]["repos"]).iter().map(|rp|{let url=label(rp,&["url"]);view!{<button class="act" on:click=move|_|web.set(url.clone())>{label(rp,&["repo"])}</button>}}).collect_view()}<Show when=move||!web.get().is_empty()><button class="act" on:click=move|_|web.set(String::new())>"편집기 닫기"</button></Show></div><WebPanel url=Signal::derive(move||web.get())/></article>}
}
#[component]
pub fn Characters() -> impl IntoView {
    let c = context();
    let jobs = Data::default();
    let server = RwSignal::new(String::new());
    let selected = RwSignal::new(String::new());
    let kind = RwSignal::new("sd-bust".to_owned());
    let pose = RwSignal::new(0u32);
    let set = RwSignal::new("a".to_owned());
    let query = RwSignal::new(String::new());
    let who = RwSignal::new(String::new());
    let name = RwSignal::new(String::new());
    let look = RwSignal::new(String::new());
    let boss = RwSignal::new(false);
    let driver = RwSignal::new(false);
    let image = RwSignal::new(String::new());
    let notes = RwSignal::new(String::new());
    let target = RwSignal::new(String::new());
    Effect::new(move |_| {
        c.epoch.get();
        jobs.load("charState", json!([]), "jobs");
    });
    Effect::new(move |_| {
        let k = selected.get();
        let roster = c.roster.get_untracked();
        if let Some(v) = roster["chars"].get(&k) {
            who.set(k);
            name.set(label(v, &["name"]));
            look.set(label(v, &["look"]));
            boss.set(v["boss"] == true);
            driver.set(v["driver"] == true);
        }
    });
    view! {<Heading title="캐릭터" note="표정·의상·역할 · 생성·재그리기 · 세션 배정"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|kind.set(event_target_value(&e))>{[("full","전신"),("bust","상반신"),("sd","SD 전신"),("sd-bust","SD 상반신")].into_iter().map(|(k,t)|view!{<option value=k selected=k=="sd-bust">{t}</option>}).collect_view()}</select><select class="field" on:change=move|e|set.set(event_target_value(&e))>{["a","b","c","d"].into_iter().map(|v|view!{<option value=v>{v.to_uppercase()}</option>}).collect_view()}</select><select class="field" on:change=move|e|pose.set(event_target_value(&e).parse().unwrap_or(0))>{["대기","작업","휴식","응답 없음","유휴","완료","질문","눈 깜박임"].into_iter().enumerate().map(|(i,t)|view!{<option value=i.to_string()>{t}</option>}).collect_view()}</select></div><div class="ru-character-grid">{move||c.roster.get()["chars"].as_object().map(|m|m.iter().filter(|(_,v)|search(v,&query.get())).map(|(id,v)|{let key=id.clone();let show=id.clone();view!{<button class="box ru-character" on:click=move|_|selected.set(key.clone())><CharacterArt who=show kind=Signal::derive(move||kind.get()) pose=Signal::derive(move||pose.get()) set=Signal::derive(move||set.get())/><b>{label(v,&["name"])}</b><small>{label(v,&["look"])}</small></button>}}).collect_view())}</div>
    <section class="box ru-section"><h2>{move||if selected.get().is_empty(){"새 캐릭터".to_owned()}else{format!("{} 편집·배정",selected.get())}}</h2><button class="act" on:click=move|_|{selected.set(String::new());who.set(String::new());name.set(String::new());look.set(String::new());image.set(String::new());}>"새 캐릭터 만들기"</button><ServerSelect value=server/><TextField label="캐릭터 ID (영문)" value=who/><TextField label="이름" value=name/><TextField label="외형·설명" value=look multiline=true/><div class="controls"><label><input type="checkbox" prop:checked=move||boss.get() on:change=move|e|boss.set(event_target_checked(&e))/>"코디네이터"</label><label><input type="checkbox" prop:checked=move||driver.get() on:change=move|e|driver.set(event_target_checked(&e))/>"드라이버"</label></div><Show when=move||!selected.get().is_empty()><div class="ru-actions"><Action label="이름·역할 저장" method="charMeta" args=Signal::derive(move||json!([server.get(),{"who":selected.get(),"name":name.get(),"look":look.get(),"boss":boss.get(),"driver":driver.get()}]))/><Action label="선택 의상 다시 그리기" method="charRedraw" confirm=true args=Signal::derive(move||json!([server.get(),{"who":selected.get(),"kind":if kind.get().starts_with("sd"){"sd".into()}else{kind.get()},"set":set.get(),"name":name.get(),"look":look.get(),"boss":boss.get(),"driver":driver.get(),"agent":"claude"}]))/><Action label="캐릭터 삭제" method="charUnpublish" danger=true confirm=true args=Signal::derive(move||json!([server.get(),selected.get()]))/></div><label class="ru-field"><span>"배정할 세션"</span><select class="field" on:change=move|e|target.set(event_target_value(&e))><option value="">"고르세요"</option>{move||c.sessions.items.get().into_iter().map(|r|{let v=r.value.get();view!{<option value=label(&v,&["path"])>{label(&v,&["title","id"])}</option>}}).collect_view()}</select></label><Action label="세션에 배정" method="pref" disabled=Signal::derive(move||target.get().is_empty()) args=Signal::derive(move||json!(["char",[target.get()],{"who":selected.get(),"set":set.get()}]))/></Show><Show when=move||selected.get().is_empty()><TextField label="그리기 지시" value=notes multiline=true/><label class="ru-field"><span>"참고 이미지 (10MB 이하)"</span><input type="file" accept="image/*" on:change=move|e|{let input=e.target().unwrap().unchecked_into::<web_sys::HtmlInputElement>();leptos::task::spawn_local(async move{match bridge::read_file(&input).await{Ok(v)=>{if let Ok(v)=serde_wasm_bindgen::from_value::<Value>(v){let _=image.try_set(label(&v,&["data"]));}},Err(e)=>c.toast.set(e.as_string().unwrap_or_default())}});}/></label><Action label="캐릭터 생성" method="charCreate" args=Signal::derive(move||json!([server.get(),{"who":who.get(),"name":name.get(),"look":look.get(),"boss":boss.get(),"driver":driver.get(),"notes":notes.get(),"agent":"claude","image":image.get()}])) disabled=Signal::derive(move||!valid_name(&who.get())||name.get().is_empty()||image.get().is_empty()||server.get().is_empty())/></Show></section><ErrorLine data=jobs/><div class="ru-grid"><For each=move||jobs.rows.items.get() key=|r|r.key.clone() children=|row|{let r=row.read();view!{<article class="box ru-section"><Status value=r/><h3>{move||label(&r.get(),&["name","who"])}</h3><p class="ru-error">{move||label(&r.get(),&["error"])}</p><JsonPanel title="생성 단계·이미지" value=r/><Action label="작업 삭제" method="charRemove" args=Signal::derive(move||json!([r.get()["server"],r.get()["id"]])) confirm=true/></article>}}/></div><JsonPanel title="재그리기 진행" value=Signal::derive(move||jobs.value.get()["redraws"].clone())/>}
}
#[component]
pub fn CharacterArt(
    who: String,
    kind: Signal<String>,
    pose: Signal<u32>,
    set: Signal<String>,
) -> impl IntoView {
    let c = context();
    let who = StoredValue::new(who);
    view! {<div class="ru-art-window"><div class="ru-character-art" style=move||{let roster=c.roster.get();let w=who.get_value();let k=kind.get();let art=&roster["chars"][&w]["art"][match k.as_str(){"sd-bust"=>"sdb",v=>v}];let width=number(&art["pw"]).max(number(&art["w"])).max(64.);let height=number(&art["ph"]).max(number(&art["h"])).max(80.);let si=match set.get().as_str(){"b"=>1,"c"=>2,"d"=>3,_=>0};let n=array(&art["top"]).len().max(8);let frame=(si*8+pose.get()as usize)%n;let extension=if k.starts_with("sd"){"png"}else{"webp"};let scale=(220./height).min(180./width);format!("width:{width}px;height:{height}px;transform:scale({scale});background-image:url('chars/{w}-{k}.{extension}?v={}');background-size:{}px auto;background-position:{}px 0",label(&roster["chars"][&w],&["v"]),width*n as f64,-(frame as f64)*width)}></div></div>}
}

#[component]
fn Adopt(set: Signal<Value>) -> impl IntoView {
    let c = context();
    let info = RwSignal::new(Value::Null);
    let fields = RwSignal::new(json!({}));
    view! {<button class="act" on:click=move|_|{let s=set.get_untracked();leptos::task::spawn_local(async move{match bridge::call("qaTicket",json!([s["server"],s["epic"],null,"adopt_check"])).await{Ok(v)=>{if v["status"]==200{if let Ok(v)=serde_json::from_str::<Value>(text(&v["body"]["output"])){fields.set(v["hints"].clone());info.set(v);}}else{c.toast.set(label(&v["body"],&["error","output"]));}},Err(e)=>c.toast.set(e)}});}>"자동화 이관 점검"</button><Show when=move||!info.get().is_null()>{move||array(&info.get()["missing"]).iter().map(|k|{let key=text(k).to_owned();let key2=key.clone();view!{<label class="ru-field"><span>{key.clone()}</span><input class="field" prop:value=move||label(&fields.get(),&[&key]) on:input=move|e|fields.update(|v|{if !v.is_object(){*v=json!({});}v[&key2]=json!(event_target_value(&e));})/></label>}}).collect_view()}{move||array(&info.get()["automations"]).iter().filter(|a|a["adopted"]!=true).map(|a|view!{<Action label=format!("{} 이관",label(a,&["name","id"])) method="qaTicket" confirm=true args=value_signal(json!([set.get_untracked()["server"],set.get_untracked()["epic"],null,"adopt",{"automation":a["id"],"set":fields.get()}]))/>}).collect_view()}</Show>}
}
