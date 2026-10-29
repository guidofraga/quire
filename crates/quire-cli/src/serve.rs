//! `quire serve`: the editor backend over localhost HTTP, so the UI can be developed
//! and tested in a plain browser (`npm run dev` proxies `/api` here). Development only:
//! it binds 127.0.0.1, checks the Host header (DNS rebinding) and requires a custom
//! header that cross-site pages cannot send without a CORS preflight it never grants.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;

use serde_json::{Value as Json, json};

const MAX_BODY: usize = 64 << 20;

fn arg<'a>(body: &'a Json, key: &str) -> Result<&'a str, String> {
    body.get(key).and_then(Json::as_str).ok_or_else(|| format!("missing \"{key}\""))
}

/// Your templates while developing in a browser: `$QUIRE_TEMPLATES`, or a scratch folder.
fn templates_dir() -> std::path::PathBuf {
    std::env::var_os("QUIRE_TEMPLATES")
        .map_or_else(|| std::env::temp_dir().join("quire-dev-templates"), Into::into)
}

fn dispatch(command: &str, body: &Json) -> Result<Json, String> {
    let err = |e: quire_service::ServiceError| e.0;
    match command {
        "report" => {
            let doc = body.get("doc").ok_or("missing \"doc\"")?;
            serde_json::to_value(quire_service::report(doc).map_err(err)?).map_err(|e| e.to_string())
        }
        "open_document" => quire_service::open(Path::new(arg(body, "path")?)).map_err(err),
        "save_document" => {
            let doc = body.get("doc").ok_or("missing \"doc\"")?;
            let from = body.get("from").and_then(Json::as_str).map(Path::new);
            quire_service::save(Path::new(arg(body, "path")?), doc, from).map_err(err)?;
            Ok(Json::Null)
        }
        "read_asset" => quire_service::read_asset(Path::new(arg(body, "bundle")?), arg(body, "src")?)
            .map(Json::String)
            .map_err(err),
        "new_document" => Ok(quire_service::new_document()),
        "library" => serde_json::to_value(quire_service::library()).map_err(|e| e.to_string()),
        "djot_html" => Ok(Json::String(quire_service::render_djot_editable(arg(body, "src")?))),
        "import_image" => {
            quire_service::assets::stage_file(Path::new(arg(body, "path")?)).map(Json::String).map_err(err)
        }
        "stage_image" => quire_service::assets::stage_base64(arg(body, "data")?, arg(body, "ext")?)
            .map(Json::String)
            .map_err(err),
        "list_templates" => {
            serde_json::to_value(quire_service::templates::list(&templates_dir())).map_err(|e| e.to_string())
        }
        "open_template" => serde_json::to_value(
            quire_service::templates::document(&templates_dir(), arg(body, "id")?).map_err(err)?,
        )
        .map_err(|e| e.to_string()),
        "save_template" => {
            let doc = body.get("doc").ok_or("missing \"doc\"")?;
            let from = body.get("from").and_then(Json::as_str).map(Path::new);
            let description = body.get("description").and_then(Json::as_str).unwrap_or("");
            quire_service::templates::save_as(&templates_dir(), arg(body, "name")?, description, doc, from)
                .map(Json::String)
                .map_err(err)
        }
        "delete_template" => {
            quire_service::templates::delete(&templates_dir(), arg(body, "id")?).map_err(err)?;
            Ok(Json::Null)
        }
        "notebook" => {
            let args = body.get("args").cloned().unwrap_or(Json::Null);
            quire_service::notebook::call(arg(body, "op")?, &args).map_err(err)
        }
        _ => Err(format!("unknown command {command}")),
    }
}

fn respond(stream: &mut TcpStream, status: &str, body: &Json) -> std::io::Result<()> {
    let text = body.to_string();
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )
}

fn handle(mut stream: TcpStream, port: u16) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let (mut length, mut host, mut dev_header) = (0usize, String::new(), false);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.to_ascii_lowercase().as_str() {
                "content-length" => length = v.parse().unwrap_or(0),
                "host" => host = v.to_string(),
                "x-quire-dev" => dev_header = v == "1",
                _ => {}
            }
        }
    }
    let allowed_hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    if !allowed_hosts.contains(&host) || !dev_header {
        return respond(&mut stream, "403 Forbidden", &json!({ "error": "forbidden" }));
    }
    let mut parts = request_line.split_whitespace();
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let Some(command) = path.strip_prefix("/api/") else {
        return respond(&mut stream, "404 Not Found", &json!({ "error": "not found" }));
    };
    if method != "POST" || length > MAX_BODY {
        return respond(&mut stream, "400 Bad Request", &json!({ "error": "expected a JSON POST" }));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let body: Json = serde_json::from_slice(&body).unwrap_or(Json::Null);
    match dispatch(command, &body) {
        Ok(v) => respond(&mut stream, "200 OK", &v),
        Err(e) => respond(&mut stream, "400 Bad Request", &json!({ "error": e })),
    }
}

pub fn serve(port: u16) -> std::io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    println!("quire dev server on http://127.0.0.1:{port}/api/ (Ctrl-C to stop)");
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        // one thread per connection: an idle keep-alive socket must not block the others
        std::thread::spawn(move || {
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(30)));
            if let Err(e) = handle(stream, port) {
                eprintln!("request failed: {e}");
            }
        });
    }
    Ok(())
}
