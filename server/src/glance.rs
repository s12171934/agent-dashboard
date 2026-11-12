use crate::{app::App, core::*, review, sessions::rx};
use chrono::{TimeZone, Timelike};
use serde_json::{Value, json};
use std::collections::HashMap;
pub fn collect(app: &App) -> Value {
    let (snapshot, projects, reviews) = {
        let s = app.state.read().unwrap();
        (s.snapshot.clone(), s.projects.clone(), s.reviews.clone())
    };
    let sessions = array(&snapshot["sessions"]);
    let agents = sessions
        .iter()
        .filter(|s| s["parent"].is_null() && s["role"] != "sub")
        .collect::<Vec<_>>();
    let board = agents
        .iter()
        .filter(|s| {
            matches!(text(&s["state"]), "run" | "bg" | "wait")
                || s["decision"].is_object()
                || epoch(text(&s["last_ts"])).is_some_and(|t| {
                    now() - t
                        < if s["state"] == "stalled" {
                            21600.
                        } else {
                            3600.
                        }
                })
        })
        .copied()
        .collect::<Vec<_>>();
    let order = ["run", "stalled", "wait", "bg"];
    let mut counts = obj();
    for k in order {
        counts[k] = json!(board.iter().filter(|s| s["state"] == k).count());
    }
    let mut busy = board
        .iter()
        .filter(|s| order.contains(&text(&s["state"])))
        .copied()
        .collect::<Vec<_>>();
    busy.sort_by_key(|s| order.iter().position(|k| s["state"] == *k).unwrap_or(4));
    let decisions=array(&snapshot["decisions"]["pending"]).iter().map(|d|{let q=&d["questions"][0];let session=sessions.iter().find(|s|s["id"]==d["session_id"]);json!({"id":d["id"],"title":session.map(|s|s["title"].clone()).unwrap_or_else(||d["agent"].clone()),"header":q["header"],"question":short(text(&q["question"]),240),"more":array(&d["questions"]).len().saturating_sub(1),"options":if array(&d["questions"]).len()==1&&q["multiSelect"]!=true{array(&q["options"]).iter().map(|o|o["label"].clone()).collect::<Vec<_>>()}else{vec![]},"path":session.map(|s|s["path"].clone())})}).collect::<Vec<_>>();
    let asks=agents.iter().filter(|s|s["decision"].is_null()&&s["state"]=="wait"&&number(&s["plan"]["done"])<number(&s["plan"]["total"])&&rx(r"승인|보고|컨펌|확인 요청|검토 요청|결정|피드백|선택").is_match(text(&s["plan"]["cur_text"]))&&!agents.iter().any(|x|matches!(text(&x["state"]),"run"|"bg")&&array(&s["awaits"]).contains(x.get("orca_focus").filter(|v|!v.is_null()).unwrap_or(&x["own_handle"])))).map(|s|json!({"title":s["title"],"detail":short(text(&s["plan"]["cur_text"]),120),"path":s["path"]})).collect::<Vec<_>>();
    let files = array(&snapshot["tests"]["files"]);
    let mut tests = files.to_vec();
    tests.sort_by(|a, b| {
        (a["phase"] != "running")
            .cmp(&(b["phase"] != "running"))
            .then(number(&b["mtime"]).total_cmp(&number(&a["mtime"])))
    });
    tests.truncate(4);
    let mut test_live = files
        .iter()
        .filter(|t| !matches!(text(&t["phase"]), "done" | "failed"))
        .count();
    let mut test_finished = files.len() - test_live;
    let mut test_failed = files
        .iter()
        .filter(|t| {
            !matches!(text(&t["verdict"]), "warn" | "red" | "error")
                && (t["phase"] == "failed" || number(&t["failed"]) > 0.)
        })
        .count();
    for d in snapshot["tests"]["run_tc"]
        .as_object()
        .into_iter()
        .flat_map(|o| o.values())
    {
        test_live += d["active"]
            .as_object()
            .map(|o| o.len())
            .unwrap_or_else(|| array(&d["active"]).len());
        for h in array(&d["history"]) {
            if epoch(
                h["finished_at"]
                    .as_str()
                    .or(h["started_at"].as_str())
                    .unwrap_or(""),
            )
            .is_some_and(|t| now() - t < 86400.)
            {
                test_finished += 1;
                if number(&h["failed"]) > 0.
                    || text(&h["outcome"]).contains("실패") && !text(&h["outcome"]).contains("중단")
                {
                    test_failed += 1;
                }
            }
        }
    }
    let mut ps=array(&projects["list"]).iter().map(|p|json!({"name":p["name"],"status":p["status"],"ratio":p["ratio"],"total":p["total"],"done":p["counts"]["done"],"error":p["error"],"current":p["current"]["name"],"no":p["current"]["no"],"stages":p["stage_count"],"end":p["end"],"mtime":p["mtime"]})).collect::<Vec<_>>();
    ps.sort_by(|a, b| {
        (number(&a["ratio"]) >= 1. || a["error"].is_string())
            .cmp(&(number(&b["ratio"]) >= 1. || b["error"].is_string()))
            .then(number(&b["mtime"]).total_cmp(&number(&a["mtime"])))
    });
    ps.truncate(8);
    let mut flow = array(&snapshot["flow"]["items"]).to_vec();
    flow.sort_by_key(|i| i["severity"] != "bad");
    let flow = json!({"bad":flow.iter().filter(|i|i["severity"]=="bad").count(),"warn":flow.iter().filter(|i|i["severity"]=="warn").count(),"items":flow.iter().take(5).map(|i|json!({"rule":i["rule_name"],"severity":i["severity"],"reason":short(text(&i["reason"]),120),"title":sessions.iter().find(|s|s["path"]==i["session"]).map(|s|&s["title"]),"path":i["session"]})).collect::<Vec<_>>()});
    let mut qa = vec![];
    for s in array(&reviews["sets"])
        .iter()
        .filter(|s| s["retired"] != true)
    {
        let mut groups =
            json!({"blocked":[],"approve":[],"working":[],"waiting":[],"delivered":[]});
        for t in array(&s["tickets"]) {
            let q = &t["qa"];
            let st = text(&q["stage"]);
            if !q.is_object()
                || q["ignored"] == true
                || st == "cleaned"
                || review::jira_stage(t) == "hold"
                || st == "committed" && array(&t["repos"]).is_empty()
            {
                continue;
            }
            let stuck = q["blocked"] == true
                && epoch(text(&q["at"][st])).is_some_and(|at| now() - at < 86400.);
            let key = if stuck {
                "blocked"
            } else {
                match st {
                    "committed" => "approve",
                    "analysis" | "implementing" | "reviewing" | "approved" => "working",
                    "selected" | "worktree" => "waiting",
                    "delivered" => "delivered",
                    _ => continue,
                }
            };
            groups[key].as_array_mut().unwrap().push(json!({"key":t["key"],"summary":short(text(&t["summary"]),80),"stage":st,"reason":if stuck{json!(short(text(&q["blocked_reason"]),120))}else{Value::Null}}));
        }
        let mut counts = obj();
        for (k, v) in groups.as_object().unwrap() {
            counts[k] = json!(array(v).len());
        }
        qa.push(json!({"epic":s["epic"],"summary":short(text(&s["summary"]),60),"open":counts.as_object().unwrap().values().map(number).sum::<f64>(),"counts":counts,"blocked":array(&groups["blocked"]).iter().take(4).collect::<Vec<_>>(),"approve":array(&groups["approve"]).iter().take(4).collect::<Vec<_>>()}));
    }
    let names = sessions
        .iter()
        .flat_map(|s| {
            [
                (&s["orca_focus"], &s["title"]),
                (&s["own_handle"], &s["title"]),
            ]
        })
        .filter(|(h, _)| h.is_string())
        .map(|(h, title)| (text(h).to_owned(), title.clone()))
        .collect::<HashMap<_, _>>();
    let talk=crate::interactions::get(app,40,false).ok().map(|d|array(&d["messages"]).iter().filter(|m|["question","escalation","worker_done","status","dispatch"].contains(&text(&m["type"]))).take(6).map(|m|json!({"type":m["type"],"from":names.get(text(&m["from_term"])).cloned().unwrap_or(json!("에이전트")),"to":names.get(text(&m["to_term"])).cloned().unwrap_or(json!("에이전트")),"subject":short(text(&m["subject"]),80),"body":short(text(&m["body"]),140),"at":m["created_at"]})).collect::<Vec<_>>());
    let designs = crate::designs::list(app);
    let mut recent = array(&designs["docs"]).to_vec();
    recent.sort_by(|a, b| number(&b["mtime"]).total_cmp(&number(&a["mtime"])));
    let mut read = recent.clone();
    read.sort_by(|a, b| number(&b["sessions"]).total_cmp(&number(&a["sessions"])));
    let designs = if designs["enabled"] == true {
        json!({"docs":array(&designs["docs"]).len(),"sources":array(&designs["sources"]).len(),"recent":recent.into_iter().take(5).collect::<Vec<_>>(),"read":read.into_iter().filter(|d|number(&d["sessions"])>0.).take(5).collect::<Vec<_>>()})
    } else {
        Value::Null
    };
    let trees=crate::worktrees::get(app,false).ok().map(|v|{let mut repos=vec![];let mut dirty=vec![];for r in array(&v["repos"]){let ws=array(&r["worktrees"]).iter().filter(|w|w["bare"]!=true).collect::<Vec<_>>();repos.push(json!({"name":r["name"],"worktrees":ws.len(),"dirty":ws.iter().filter(|w|number(&w["dirty"])>0.).count()}));for w in ws.into_iter().filter(|w|number(&w["dirty"])>0.){dirty.push(json!({"repo":r["name"],"name":w["name"],"branch":w["branch"],"dirty":w["dirty"],"committed":w["committed"]}));}}dirty.sort_by(|a,b|number(&b["committed"]).total_cmp(&number(&a["committed"])));dirty.truncate(6);json!({"repos":repos,"dirty":dirty})});
    let mut mine=decisions.iter().map(|d|json!({"kind":"dec","title":d["title"],"detail":d["header"].as_str().unwrap_or(text(&d["question"])),"path":d["path"]})).chain(asks.iter().map(|a|{let mut a=a.clone();a["kind"]=json!("ask");a})).collect::<Vec<_>>();
    let blocked = qa
        .iter()
        .map(|s| number(&s["counts"]["blocked"]))
        .sum::<f64>();
    let approve = qa
        .iter()
        .map(|s| number(&s["counts"]["approve"]))
        .sum::<f64>();
    for (kind, key) in [("blocked", "blocked"), ("approve", "approve")] {
        for s in &qa {
            for t in array(&s[key]) {
                mine.push(json!({"kind":kind,"title":t["key"],"detail":t["reason"].as_str().unwrap_or(text(&t["summary"])),"path":null}));
            }
        }
    }
    mine.truncate(6);
    json!({"api":1,"now":now(),"decisions":decisions,"agents":{"counts":counts,"busy":busy.iter().take(6).map(|s|json!({"title":s["title"],"state":s["state"],"model":s["model"],"last_ts":s["last_ts"],"path":s["path"]})).collect::<Vec<_>>()},"tests":tests,"test_counts":{"live":test_live,"finished":test_finished,"failed":test_failed},"asks":asks,"usage":array(&snapshot["plan_usage"]["accounts"]).iter().filter(|a|!array(&a["limits"]).is_empty()).map(|a|json!({"provider":a["provider"],"email":a["email"],"plan":a["plan"],"stale":a["stale"]==true||a["note"].is_string(),"limits":a["limits"]})).collect::<Vec<_>>(),"plans":board.iter().filter(|s|order.contains(&text(&s["state"]))&&number(&s["plan"]["total"])>0.).take(6).map(|s|json!({"title":s["title"],"state":s["state"],"path":s["path"],"steps":s["plan"]["steps"],"done":s["plan"]["done"],"total":s["plan"]["total"],"cur":short(text(&s["plan"]["cur_text"]),120)})).collect::<Vec<_>>(),"projects":ps,"flow":flow,"cost":cost(sessions),"qa":qa,"talk":talk,"designs":designs,"trees":trees,"mine":{"total":decisions.len()as f64+asks.len()as f64+blocked+approve,"counts":{"dec":decisions.len(),"ask":asks.len(),"blocked":blocked,"approve":approve},"items":mine}})
}
pub fn cost(sessions: &[Value]) -> Value {
    let local = chrono::Local::now();
    let midnight = chrono::Local
        .from_local_datetime(&local.date_naive().and_hms_opt(0, 0, 0).unwrap())
        .earliest()
        .unwrap()
        .timestamp() as f64;
    let mut hours = [0.; 24];
    let mut top = vec![];
    for s in sessions {
        let mut total = 0.;
        for (k, v) in s["slots"].as_object().into_iter().flat_map(|m| m.iter()) {
            let at = k.parse::<f64>().unwrap_or(0.) * 300.;
            if at >= midnight {
                let i = ((at - midnight) / 3600.).floor().min(23.) as usize;
                hours[i] += number(&v[4]);
                total += number(&v[4]);
            }
        }
        if total > 0. && s["role"] != "sub" && s["parent"].is_null() {
            top.push(json!({"title":s["title"],"model":s["model"],"cost":(total*100.).round()/100.,"path":s["path"]}));
        }
    }
    top.sort_by(|a, b| number(&b["cost"]).total_cmp(&number(&a["cost"])));
    top.truncate(5);
    json!({"total":(hours.iter().sum::<f64>()*100.).round()/100.,"hours":hours.map(|h|(h*100.).round()/100.),"now_hour":local.hour(),"top":top})
}
