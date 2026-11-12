use agent_dashboard::{
    app::App,
    core::{Config, absolute, real},
    http,
};
use clap::Parser;

#[derive(Parser)]
#[command(version, about = "Agent dashboard metrics server — REST and SSE")]
struct Args {
    #[arg(long, default_value_t = 8787)]
    port: u16,
    #[arg(long, default_value_t = 24.)]
    hours: f64,
    #[arg(long, default_value_t = 8)]
    runs: usize,
    #[arg(long)]
    host: Vec<String>,
    #[arg(long)]
    origin: Vec<String>,
    #[arg(long)]
    projects_dir: Vec<String>,
    #[arg(long)]
    design_dir: Vec<String>,
    #[arg(long, default_value_t = 14.)]
    design_days: f64,
    #[arg(long)]
    vault: Option<String>,
    /// Serve an empty, isolated state without background collectors (for API contract tests).
    #[arg(long, hide = true)]
    no_collect: bool,
}
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(name) = args.first().filter(|n| agent_dashboard::cli::recognized(n)) {
        std::process::exit(agent_dashboard::cli::run(name, &args[1..]));
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("Tokio runtime");
    if let Err(e) = runtime.block_on(run()) {
        eprintln!("agent-dashboard: {e}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    if !args.hours.is_finite()
        || args.hours <= 0.
        || !args.design_days.is_finite()
        || args.design_days < 0.
    {
        return Err("hours must be positive and design-days nonnegative".into());
    }
    let mut c = Config {
        port: args.port,
        hours: args.hours,
        runs: args.runs,
        design_days: args.design_days,
        hosts: if args.host.is_empty() {
            vec!["127.0.0.1".into()]
        } else {
            args.host
        },
        origins: args.origin,
        projects: args.projects_dir.into_iter().map(absolute).collect(),
        designs: args.design_dir.into_iter().map(real).collect(),
        ..Config::default()
    };
    if let Some(p) = args.vault {
        c.vault = absolute(p);
    }
    let mut listeners = vec![];
    for h in &c.hosts {
        let l = tokio::net::TcpListener::bind((h.as_str(), c.port)).await?;
        eprintln!("agent-dashboard API → http://{}/", l.local_addr()?);
        listeners.push(l);
    }
    let app = App::new(c);
    app.build_snapshot().map_err(std::io::Error::other)?;
    if !args.no_collect {
        app.start();
    }
    let router = http::router(app);
    let mut handles = vec![];
    for listener in listeners {
        let router = router.clone();
        handles.push(tokio::spawn(
            async move { axum::serve(listener, router).await },
        ));
    }
    tokio::select! {_=tokio::signal::ctrl_c()=>{},r=handles.remove(0)=>{r??;}}
    Ok(())
}
