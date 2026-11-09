//! 主程序留在原生 Wayland 时，宠物窗口单独跑在 X11（XWayland）上。
//! 同一个 Electron 进程不能混用两种后端，所以这里再拉起一个只含宠物窗口的进程。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const HOST_JS: &str = r#"
'use strict'
const { app, BrowserWindow, Menu, screen, ipcMain } = require('electron')
const net = require('node:net')
const path = require('node:path')
const fs = require('node:fs')
const args = process.argv.slice(process.argv.indexOf('--') + 1)
const read = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : '' }
const url = read('--url')
const port = Number(read('--connect'))
const appName = read('--app-name')
const desktopFile = read('--desktop-file')
const wmClass = read('--wm-class')
const icon = read('--icon')
if (appName) {
  process.env.ELECTRON_RS_APP_NAME = appName
  app.setName(appName)
}
if (desktopFile) app.setDesktopName(desktopFile)
if (wmClass) app.commandLine.appendSwitch('class', wmClass)
let win
let socket
const send = (value) => { if (socket && !socket.destroyed) socket.write(JSON.stringify(value) + '\n') }
const reply = (id, ok, result, error) => send({ kind: 'reply', id, ok, result, error })
function bounds() {
  const b = win.getBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}
function handle(message) {
  const { id, method, params } = message
  try {
    let result = null
    if (method === 'cursor') result = screen.getCursorScreenPoint()
    else if (method === 'bounds') result = bounds()
    else if (method === 'workArea') {
      const area = screen.getDisplayMatching(win.getBounds()).workArea
      result = { x: area.x, y: area.y, width: area.width, height: area.height }
    }
    else if (method === 'setPosition') win.setPosition(Math.round(params.x), Math.round(params.y))
    else if (method === 'setSize') win.setContentSize(Math.max(1, Math.round(params.width)), Math.max(1, Math.round(params.height)))
    else if (method === 'setShape') {
      const rectangles = Array.isArray(params.rectangles) ? params.rectangles : []
      win.setIgnoreMouseEvents(rectangles.length === 0, { forward: true })
      if (rectangles.length) win.setShape(rectangles)
    }
    else if (method === 'alwaysOnTop') win.setAlwaysOnTop(params.value === true)
    else if (method === 'show') { try { win.showInactive() } catch (error) { win.show() } }
    else if (method === 'refresh') win.webContents.executeJavaScript('window.dispatchEvent(new Event(\'dsh-pet-refresh\'))').catch(() => {})
    else if (method === 'menu') {
      Menu.buildFromTemplate([
        { label: '显示主界面', click: () => send({ kind: 'event', name: 'menu', action: 'pet-open' }) },
        { label: '关闭宠物', click: () => send({ kind: 'event', name: 'menu', action: 'pet-close' }) },
      ]).popup({ window: win })
    }
    else if (method === 'quit') { app.quit(); return }
    else throw new Error('PET_X11_METHOD')
    reply(id, true, result, null)
  } catch (error) {
    reply(id, false, null, String(error && error.message || error))
  }
}
app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 296, height: 209, show: false, frame: false, transparent: true, resizable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
    alwaysOnTop: true, focusable: false, hasShadow: false, type: 'toolbar', backgroundColor: '#00000000',
    ...(icon && fs.existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  })
  win.setFocusable(false)
  win.setAlwaysOnTop(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
  win.on('closed', () => send({ kind: 'event', name: 'closed' }))
  win.webContents.on('did-fail-load', (_event, code, description, target) => console.error('PET_X11_FAIL', code, description, target))
  win.webContents.on('render-process-gone', (_event, details) => console.error('PET_X11_GONE', JSON.stringify(details)))
  ipcMain.handle('dsh-pet-command', (_event, request) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9)
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('PET_X11_PAGE_TIMEOUT')) }, 3000)
    pending.set(id, (value) => { clearTimeout(timer); value.ok ? resolve(value.result) : reject(new Error(value.error || 'PET_X11_PAGE_FAILED')) })
    send({ kind: 'page', id, request })
  }))
  socket = net.connect(port, '127.0.0.1', () => win.loadURL(url).catch((error) => console.error('PET_X11_LOAD_FAILED', error)))
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.kind === 'host') handle(message)
      else if (message.kind === 'reply') {
        const done = pending.get(message.id)
        if (done) { pending.delete(message.id); done(message) }
      }
    }
  })
  socket.on('error', (error) => console.error('PET_X11_SOCKET', error))
  socket.on('close', () => app.quit())
})
const pending = new Map()
"#;

const PRELOAD_JS: &str = r#"
'use strict'
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('__DSH_PET_OVERLAY__', true)
contextBridge.exposeInMainWorld('__DSH_PET_NATIVE_DRAG__', false)
contextBridge.exposeInMainWorld('__DSH_PET_X11__', {
  command(request) { return ipcRenderer.invoke('dsh-pet-command', request) }
})
"#;

pub enum Incoming {
    Page { id: u64, request: super::pet::Request },
    Menu(String),
    Closed,
}

pub struct Host {
    child: Child,
    writer: Mutex<std::net::TcpStream>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    incoming: Receiver<Incoming>,
    next_id: std::sync::atomic::AtomicU64,
}

pub fn separate_from_env(wayland: bool, electron_args: &str) -> bool {
    wayland
        && electron_args
            .split_whitespace()
            .rev()
            .find(|arg| arg.starts_with("--ozone-platform="))
            != Some("--ozone-platform=x11")
}

impl Host {
    pub fn spawn(dir: &Path, url: &str) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let host_js = dir.join("host.cjs");
        let preload = dir.join("preload.cjs");
        std::fs::write(&host_js, HOST_JS).map_err(|e| e.to_string())?;
        std::fs::write(&preload, PRELOAD_JS).map_err(|e| e.to_string())?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        listener.set_nonblocking(false).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let profile = dir.join("profile");
        std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
        let electron = electron_binary()?;
        let mut command = Command::new(&electron);
        command
            .arg("--ozone-platform=x11")
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(&host_js)
            .arg("--")
            .arg("--url")
            .arg(url)
            .arg("--connect")
            .arg(port.to_string());
        let product = env!("DSH_PRODUCT_NAME");
        command
            .arg("--app-name")
            .arg(product)
            .arg("--desktop-file")
            .arg(format!("{product}.desktop"))
            .arg("--wm-class")
            .arg("deepseek-harness-desktop");
        if let Some(icon) = pet_icon(&electron) {
            command.arg("--icon").arg(icon);
        }
        command
            .env_remove("ELECTRON_RUN_AS_NODE")
            .env_remove("WAYLAND_DISPLAY")
            .env("GDK_BACKEND", "x11")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        let mut child = command.spawn().map_err(|e| format!("PET_X11_SPAWN: {e}"))?;
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    log::warn!("pet-x11: {line}");
                }
            });
        }
        listener
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;
        let stream = accept_for(&listener, &mut child, Duration::from_secs(8))?;
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        let reader = stream.try_clone().map_err(|e| e.to_string())?;
        let pending = Arc::new(Mutex::new(HashMap::<u64, Sender<Value>>::new()));
        let (tx, incoming) = mpsc::channel();
        let pending_reader = Arc::clone(&pending);
        std::thread::spawn(move || read_loop(reader, pending_reader, tx));
        Ok(Self {
            child,
            writer: Mutex::new(stream),
            pending,
            incoming,
            next_id: std::sync::atomic::AtomicU64::new(1),
        })
    }

    pub fn poll(&self) -> Vec<Incoming> {
        let mut events = Vec::new();
        while let Ok(event) = self.incoming.try_recv() {
            events.push(event);
        }
        events
    }

    fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
        self.write(&json!({"kind":"host","id":id,"method":method,"params":params}))?;
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(value) => {
                if value.get("ok").and_then(Value::as_bool) == Some(false) {
                    return Err(value
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("PET_X11_CALL_FAILED")
                        .to_string());
                }
                Ok(value.get("result").cloned().unwrap_or(Value::Null))
            }
            Err(_) => {
                self.pending.lock().ok().map(|mut pending| pending.remove(&id));
                Err("PET_X11_TIMEOUT".into())
            }
        }
    }

    pub fn reply_page(&self, id: u64, result: Result<Value, String>) {
        let message = match result {
            Ok(result) => json!({"kind":"reply","id":id,"ok":true,"result":result,"error":null}),
            Err(error) => json!({"kind":"reply","id":id,"ok":false,"result":null,"error":error}),
        };
        if let Err(error) = self.write(&message) {
            log::warn!("PET_X11_REPLY_FAILED: {error}");
        }
    }

    pub fn cursor(&self) -> Result<(i32, i32), String> {
        let value = self.call("cursor", Value::Null)?;
        point(&value)
    }
    pub fn position(&self) -> Result<(i32, i32), String> {
        point(&self.call("bounds", Value::Null)?)
    }
    pub fn set_position(&self, x: i32, y: i32) -> Result<(), String> {
        self.call("setPosition", json!({"x":x,"y":y})).map(|_| ())
    }
    pub fn content_size(&self) -> Result<(u32, u32), String> {
        let value = self.call("bounds", Value::Null)?;
        Ok((
            value.get("width").and_then(Value::as_u64).unwrap_or(0) as u32,
            value.get("height").and_then(Value::as_u64).unwrap_or(0) as u32,
        ))
    }
    pub fn set_content_size(&self, width: u32, height: u32) -> Result<(), String> {
        self.call("setSize", json!({"width":width,"height":height})).map(|_| ())
    }
    pub fn work_area(&self) -> Result<(i32, i32, i32, i32), String> {
        let value = self.call("workArea", Value::Null)?;
        let (x, y) = point(&value)?;
        let width = value.get("width").and_then(Value::as_i64).unwrap_or(0) as i32;
        let height = value.get("height").and_then(Value::as_i64).unwrap_or(0) as i32;
        Ok((x, y, width, height))
    }
    pub fn set_shape(&self, rectangles: &[electron_rs::rpc::Rectangle]) -> Result<(), String> {
        self.call("setShape", json!({"rectangles": rectangles})).map(|_| ())
    }
    pub fn always_on_top(&self, value: bool) -> Result<(), String> {
        self.call("alwaysOnTop", json!({"value": value})).map(|_| ())
    }
    pub fn show(&self) -> Result<(), String> {
        self.call("show", Value::Null).map(|_| ())
    }
    pub fn refresh(&self) -> Result<(), String> {
        self.call("refresh", Value::Null).map(|_| ())
    }
    pub fn show_menu(&self) -> Result<(), String> {
        self.call("menu", Value::Null).map(|_| ())
    }

    pub fn close(&mut self) {
        let _ = self.call("quit", Value::Null);
        let pid = self.child.id();
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .status();
        let _ = self.child.wait();
    }

    fn write(&self, value: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut writer = self.writer.lock().map_err(|e| e.to_string())?;
        writer.write_all(&line).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            self.close();
        }
    }
}

fn point(value: &Value) -> Result<(i32, i32), String> {
    Ok((
        value.get("x").and_then(Value::as_i64).ok_or("PET_X11_POINT")? as i32,
        value.get("y").and_then(Value::as_i64).ok_or("PET_X11_POINT")? as i32,
    ))
}

fn accept_for(listener: &TcpListener, child: &mut Child, timeout: Duration) -> Result<std::net::TcpStream, String> {
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > timeout {
            let _ = child.kill();
            return Err("PET_X11_CONNECT_TIMEOUT".into());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("PET_X11_EXITED: {status}"));
        }
        match listener.accept() {
            Ok((stream, _)) => return Ok(stream),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn read_loop(stream: std::net::TcpStream, pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>, tx: Sender<Incoming>) {
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
        match value.get("kind").and_then(Value::as_str) {
            Some("reply") => {
                let Some(id) = value.get("id").and_then(Value::as_u64) else { continue };
                if let Some(sender) = pending.lock().ok().and_then(|mut pending| pending.remove(&id)) {
                    let _ = sender.send(value);
                }
            }
            Some("page") => {
                let Some(id) = value.get("id").and_then(Value::as_u64) else { continue };
                let Some(request) = value.get("request").cloned() else { continue };
                match serde_json::from_value::<super::pet::Request>(request) {
                    Ok(request) => { let _ = tx.send(Incoming::Page { id, request }); }
                    Err(error) => log::warn!("PET_X11_PAGE_INVALID: {error}"),
                }
            }
            Some("event") => {
                let name = value.get("name").and_then(Value::as_str).unwrap_or("");
                let incoming = if name == "closed" {
                    Incoming::Closed
                } else if name == "menu" {
                    Incoming::Menu(value.get("action").and_then(Value::as_str).unwrap_or("").to_string())
                } else {
                    continue;
                };
                let _ = tx.send(incoming);
            }
            _ => {}
        }
    }
    let _ = tx.send(Incoming::Closed);
}

fn electron_binary() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("PET_X11_ELECTRON")?;
    let bundled = dir.join("runtime/linux-x64/electron");
    if bundled.is_file() {
        return Ok(bundled);
    }
    electron_rs::electron_binary(dir).map_err(|e| e.to_string())
}

fn pet_icon(electron: &Path) -> Option<PathBuf> {
    let packaged = electron.parent()?.join("../../icons/app.png");
    if packaged.is_file() {
        return Some(packaged);
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.png");
    dev.is_file().then_some(dev)
}

#[cfg(test)]
mod tests {
    use super::separate_from_env;

    #[test]
    fn wayland_shell_gets_a_separate_x11_pet_unless_the_shell_is_already_x11() {
        assert!(separate_from_env(true, "--remote-debugging-port=9227"));
        assert!(separate_from_env(true, "--ozone-platform=wayland"));
        assert!(!separate_from_env(true, "--ozone-platform=wayland --ozone-platform=x11"));
        assert!(!separate_from_env(false, ""));
    }
}
