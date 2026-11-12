use crate::{bridge, components::*, model::*, state::*};
use leptos::prelude::*;
use serde_json::{Value, json};
#[component]
pub fn Home() -> impl IntoView {
    let c = context();
    let reviews = Data::default();
    let projects = Data::default();
    Effect::new(move |_| {
        c.state.with(|s| s["reviews_at"].clone());
        reviews.load("reviews", json!([]), "sets");
    });
    Effect::new(move |_| {
        c.projects_epoch.get();
        projects.load("projects", json!([]), "projects");
    });
    view! {<Heading title="홈" note="켜진 메트릭 서버 전체의 현황"/><div class="ru-metrics"><Metric title="실행 중" value=Signal::derive(move||array(&c.state.get()["sessions"]).iter().filter(|s|live(s)).count().to_string())/><Metric title="내 차례" value=Signal::derive(move||(array(&c.state.get()["decisions"]["pending"]).len()+array(&c.state.get()["decisions"]["inbox"]).iter().filter(|r|r["read"]!=true).count()).to_string())/><Metric title="추정 비용" value=Signal::derive(move||format!("${:.2}",array(&c.state.get()["sessions"]).iter().map(|s|number(&s["cost"])).sum::<f64>()))/></div><div class="ru-grid ru-home">{SCREENS.iter().filter(|(key,_,_)|*key!="home").map(|(key,title,icon)|{let key=*key;view!{<a class="box ru-tile" href=format!("#{key}")><Icon name=*icon/><h2>{*title}</h2><b>{move||{let s=c.state.get();match key{"agents"=>array(&s["sessions"]).len().to_string(),"decide"=>array(&s["decisions"]["pending"]).len().to_string(),"tests"=>array(&s["tests"]["files"]).iter().filter(|t|t["phase"]=="running").count().to_string(),"worktrees"=>array(&reviews.value.get()["sets"]).iter().map(|x|array(&x["tickets"]).len()).sum::<usize>().to_string(),"projects"=>array(&projects.value.get()["projects"]).len().to_string(),"compare"=>format!("${:.2}",array(&s["sessions"]).iter().map(|x|number(&x["cost"])).sum::<f64>()),"usage"=>array(&s["plan_usage"]).len().to_string(),_=>"열기 →".into()}}}</b></a>}}).collect_view()}</div><Show when=move||!array(&c.state.get()["flow"]["items"]).is_empty()><section class="box ru-section"><h2>"흐름 점검"</h2>{move||array(&c.state.get()["flow"]["items"]).iter().map(|r|{let a=r.clone();view!{<div class="ru-row"><span class="ru-status" data-state="failed">{label(r,&["rule_name","rule"])}</span><span>{label(r,&["reason"])}</span><Action label="정상으로 표시" method="flowOk" args=value_signal(json!([a["server"],a["id"],true,a]))/></div>}}).collect_view()}</section></Show><section class="box ru-section"><h2>"최근 활동"</h2><For each={move||c.sessions.items.get().into_iter().take(30).collect::<Vec<_>>()} key=|r|r.key.clone() children=|row|{let r=row.read();view!{<a class="ru-row" href=move||session_hash(text(&r.get()["path"]))><time>{move||bridge::timestamp(text(&r.get()["last_ts"]))}</time><span>{move||label(&r.get(),&["title","id"])}</span><Status value=r/></a>}}/></section>}
}
#[component]
pub fn Usage() -> impl IntoView {
    let c = context();
    view! {<Heading title="플랜 사용량" note="구독 계정별 한도와 초과 크레딧"/><div class="ru-grid">{move||array(&c.state.get()["plan_usage"]).iter().map(|a|{let a=a.clone();let stale=a["stale"]==true;view!{<section class="box ru-section"><h2>{label(&a,&["email","provider"])}</h2><p>{label(&a,&["plan"])}" · "{label(&a,&["provider"])}</p><Show when=move||stale><p class="ru-error">"마지막으로 읽은 사용량입니다"</p></Show>{array(&a["limits"]).iter().map(|b|{let pct=number(&b["percent"]);view!{<div class="ru-limit"><div><b>{label(b,&["name","kind"])}</b><span>{format!("{pct:.1}%")}</span></div><Progress ratio=Signal::derive(move||pct/100.)/><small>{if b["resets_at"].is_number(){bridge::timestamp(&js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(number(&b["resets_at"])*1000.)).to_iso_string().as_string().unwrap_or_default())}else{label(b,&["resets_at"])}}</small></div>}}).collect_view()}<JsonPanel title="초과 사용량" value=value_signal(a["extra"].clone())/><p>{label(&a,&["note","error"])}</p></section>}}).collect_view()}</div>}
}
#[component]
pub fn Compare() -> impl IntoView {
    let c = context();
    let history = Data::default();
    history.load("history", json!([]), "sessions");
    let metric = RwSignal::new("cost".to_owned());
    let query = RwSignal::new(String::new());
    let include = RwSignal::new(false);
    let hours = RwSignal::new(0u32);
    let group = RwSignal::new("session".to_owned());
    let source = Memo::new(move |_| {
        let mut rows = array(&c.state.get()["sessions"]).to_vec();
        if include.get() {
            let ids = rows
                .iter()
                .map(identity)
                .collect::<std::collections::HashSet<_>>();
            rows.extend(
                array(&history.value.get()["sessions"])
                    .iter()
                    .filter(|s| !ids.contains(&identity(s)))
                    .cloned(),
            );
        }
        rows.into_iter()
            .filter(|r| search(r, &query.get()) && c.visible(r))
            .collect::<Vec<_>>()
    });
    let buckets = Memo::new(move |_| {
        let since = if hours.get() == 0 {
            0
        } else {
            (js_sys::Date::now() / 300000.) as i64 - hours.get() as i64 * 12
        };
        usage_buckets(&source.get(), since)
    });
    view! {<Heading title="비교 · 비용" note="세션·모델·워크트리별 토큰과 비용"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|metric.set(event_target_value(&e))><option value="cost">"비용"</option><option value="output">"출력 토큰"</option><option value="input">"입력 토큰"</option><option value="turns">"턴"</option><option value="tool_calls">"도구 호출"</option><option value="ctx_peak">"최대 컨텍스트"</option></select><select class="field" aria-label="기간" on:change=move|e|hours.set(event_target_value(&e).parse().unwrap_or(0))>{[(0,"전체"),(1,"1시간"),(6,"6시간"),(24,"24시간"),(168,"7일")].into_iter().map(|(n,t)|view!{<option value=n.to_string()>{t}</option>}).collect_view()}</select><select class="field" aria-label="묶음" on:change=move|e|group.set(event_target_value(&e))><option value="session">"세션별"</option><option value="model">"모델별"</option><option value="place">"워크트리별"</option></select><label><input type="checkbox" on:change=move|e|include.set(event_target_checked(&e))/>"지난 세션 포함"</label></div><ErrorLine data=history/><div class="ru-metrics"><Metric title="기간 비용" value=Signal::derive(move||format!("${:.2}",buckets.get().values().map(|b|b[4]).sum::<f64>()))/><Metric title="기간 출력" value=Signal::derive(move||count(&json!(buckets.get().values().map(|b|b[3]).sum::<f64>())))/><Metric title="세션" value=Signal::derive(move||source.get().len().to_string())/></div><div class="box ru-section"><h2>"5분 단위 사용량"</h2><p class="ru-muted">{move||{let b=buckets.get();let label=|t:i64|bridge::timestamp(&js_sys::Date::new(&wasm_bindgen::JsValue::from_f64(t as f64*300000.)).to_iso_string().as_string().unwrap_or_default());match(b.first_key_value(),b.last_key_value()){(Some((a,_)),Some((z,_)))=>format!("{} → {}",label(*a),label(*z)),_=>"사용 기록 없음".into()}}}</p><Bars values=Signal::derive(move||{let m=metric.get();let col=if m=="output"{3}else if m=="input"{0}else{4};json!(buckets.get().into_values().map(|b|b[col]).collect::<Vec<_>>())})/></div><div class="box ru-section ru-table-wrap"><table class="ru-table"><thead><tr><th>"세션·묶음"</th><th>"모델"</th><th>"비용"</th><th>"입력"</th><th>"출력"</th><th>"턴"</th><th>"도구"</th><th>"컨텍스트"</th></tr></thead><tbody>{move||{let mut rows=source.get();if hours.get()>0{let since=(js_sys::Date::now()/300000.)as i64-hours.get()as i64*12;rows=rows.into_iter().map(|mut r|{let b=usage_buckets(&[r.clone()],since);r["cost"]=json!(b.values().map(|b|b[4]).sum::<f64>());r["tokens"]["input"]=json!(b.values().map(|b|b[0]).sum::<f64>());r["tokens"]["output"]=json!(b.values().map(|b|b[3]).sum::<f64>());r}).collect();}
    if group.get()!="session"{let mut sums=std::collections::BTreeMap::<String,Value>::new();for r in rows{let name=if group.get()=="model"{label(&r,&["model"])}else{place_key(&r)};let row=sums.entry(name.clone()).or_insert_with(||json!({"title":name,"tokens":{"input":0,"output":0}}));for key in ["cost","turns","tool_calls"]{row[key]=json!(number(&row[key])+number(&r[key]));}row["ctx_peak"]=json!(number(&row["ctx_peak"]).max(number(&r["ctx_peak"])));for key in ["input","output"]{row["tokens"][key]=json!(number(&row["tokens"][key])+number(&r["tokens"][key]));}}rows=sums.into_values().collect();}let m=metric.get();let score=|r:&Value|if ["input","output"].contains(&m.as_str()){number(&r["tokens"][&m])}else{number(&r[&m])};rows.sort_by(|a,b|score(b).total_cmp(&score(a)));rows.into_iter().map(|r|view!{<tr><td><a href=if r["path"].is_string(){session_hash(text(&r["path"]))}else{"#compare".into()}>{label(&r,&["title","id"])}</a></td><td>{label(&r,&["model"])}</td><td>{money(&r["cost"])}</td><td>{count(&r["tokens"]["input"])}</td><td>{count(&r["tokens"]["output"])}</td><td>{count(&r["turns"])}</td><td>{count(&r["tool_calls"])}</td><td>{count(&r["ctx_peak"])}</td></tr>}).collect_view()}}</tbody></table></div>}
}
#[component]
pub fn Talk() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let query = RwSignal::new(String::new());
    let heartbeat = RwSignal::new(false);
    let limit = RwSignal::new(500u32);
    let kind = RwSignal::new(String::new());
    Effect::new(move |_| {
        c.epoch.get();
        data.load(
            "interactions",
            json!([limit.get(), heartbeat.get()]),
            "messages",
        );
    });
    view! {<Heading title="상호작용" note="에이전트 사이의 질문·답변·상태 메시지"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|kind.set(event_target_value(&e))><option value="">"전체 종류"</option>{["question","answer","dispatch","worker_done","status","escalation"].into_iter().map(|v|view!{<option value=v>{v}</option>}).collect_view()}</select><label><input type="checkbox" on:change=move|e|heartbeat.set(event_target_checked(&e))/>"하트비트"</label><select class="field" on:change=move|e|limit.set(event_target_value(&e).parse().unwrap_or(500))>{[100,500,1500,5000].into_iter().map(|n|view!{<option value=n.to_string() selected=n==500>{format!("{n}개")}</option>}).collect_view()}</select></div><ErrorLine data=data/><div class="ru-list"><For each={move||data.rows.items.get().into_iter().filter(|r|{let v=r.value.get();search(&v,&query.get())&&(kind.get().is_empty()||v["type"]==kind.get())}).collect::<Vec<_>>()} key=|r|r.key.clone() children=|row|{let r=row.read();view!{<details class="box ru-message"><summary><span class="ru-status">{move||label(&r.get(),&["type"])}</span><b>{move||label(&r.get(),&["subject"])}</b><small>{move||bridge::timestamp(text(&r.get()["created_at"]))}</small></summary><div class="ru-row"><b>{move||label(&r.get(),&["from"])}</b>" → "<b>{move||label(&r.get(),&["to"])}</b><Action label="보낸 터미널" method="focus" args=Signal::derive(move||json!([r.get()["from_term"]])) disabled=Signal::derive(move||!r.get()["from_term"].is_string())/></div><pre>{move||label(&r.get(),&["body"])}</pre><JsonPanel title="파일·메시지 정보" value=r/></details>}}/></div>}
}
#[component]
pub fn Tests() -> impl IntoView {
    let c = context();
    let data = Data::default();
    let query = RwSignal::new(String::new());
    let filter = RwSignal::new(String::new());
    let stamp = Memo::new(move |_| c.state.get()["tests"]["history_at"].clone());
    Effect::new(move |_| {
        stamp.get();
        data.load("tests", json!([]), "runs");
    });
    let current = Rows::default();
    Effect::new(move |_| {
        let s = c.state.get();
        let mut rows = array(&s["tests"]["files"]).to_vec();
        rows.extend(
            s["tests"]["run_tc"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .cloned(),
        );
        current.sync(rows);
    });
    view! {<Heading title="테스트" note="실행 중인 테스트와 보관된 결과"/><div class="controls"><Search value=query/><select class="field" on:change=move|e|filter.set(event_target_value(&e))>{[("","전체"),("running","진행 중"),("failed","실패"),("red","의도한 빨강"),("warn","확인 필요"),("error","실행 오류")].into_iter().map(|(k,t)|view!{<option value=k>{t}</option>}).collect_view()}</select></div><ErrorLine data=data/><section class="ru-grid"><For each={move||{let mut rows=current.items.get();let keys=rows.iter().filter_map(|r|r.value.get()["hist_id"].as_str().map(str::to_owned)).collect::<std::collections::HashSet<_>>();rows.extend(data.rows.items.get().into_iter().filter(|r|!keys.contains(text(&r.value.get()["id"]))));rows.into_iter().filter(|r|{let v=r.value.get();search(&v,&query.get())&&(filter.get().is_empty()||v["phase"]==filter.get()||v["verdict"]==filter.get())}).collect::<Vec<_>>()}} key=|r|r.key.clone() children=|r|view!{<TestCard row=r/>}/></section>}
}
#[component]
pub fn TestCard(row: Row) -> impl IntoView {
    let r = row.read();
    let detail = Data::default();
    let open = RwSignal::new(false);
    Effect::new(move |_| {
        if open.get() {
            let v = r.get();
            let id = v["hist_id"].as_str().or(v["id"].as_str());
            if let Some(id) = id {
                detail.load("testRun", json!([id, v["server"]]), "");
            }
        }
    });
    view! {<article class="box ru-section"><div class="ru-row"><Status value=r field="phase"/><b>{move||label(&r.get(),&["label","task","key"])}</b><span>{move||label(&r.get(),&["verdict"])}</span></div><Progress ratio=Signal::derive(move||{let v=r.get();number(&v["done"])/number(&v["total"]).max(1.)})/><p>{move||{let v=r.get();format!("{} / {} · 통과 {} · 실패 {}",count(&v["done"]),count(&v["total"]),count(&v["passed"]),count(&v["failed"]))}}</p><small>{move||label(&r.get(),&["detail"])}</small><button class="act" on:click=move|_|open.update(|v|*v = !*v)>{move||if open.get(){"케이스 접기"}else{"케이스 보기"}}</button><Show when=move||open.get()><ErrorLine data=detail/><div class="ru-case-list">{move||{let mut cases=detail.value.get()["cases"].clone();if cases.is_null(){cases=r.get()["cases"].clone();}array(&cases).iter().map(|case|view!{<div class="ru-row"><span class="ru-status" data-state=label(case,&["status"])>{label(case,&["status"])}</span><b>{label(case,&["id"])}</b><span>{label(case,&["title"])}</span><small>{label(case,&["msg","error"])}</small></div>}).collect_view()}}</div></Show></article>}
}
