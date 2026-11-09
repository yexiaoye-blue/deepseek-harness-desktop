use super::pet_drag::{BackendCaps, Bounds, Effect, PetSession, Phase, Platform, Point};
use serde::{Deserialize, Serialize};
use std::sync::{mpsc, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "pet";

#[derive(Default)]
pub struct PetHost(OnceLock<mpsc::Sender<Message>>);

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    Sync {
        enabled: bool,
        throw_enabled: bool,
    },
    State,
    Ready,
    Pointer {
        action: String,
    },
    Frame {
        frame: u64,
        rectangles: Vec<electron_rs::rpc::Rectangle>,
    },
    Resize {
        width: u32,
        height: u32,
    },
    Menu,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    pub desktop_supported: bool,
    pub desktop_open: bool,
    pub overlay_supported: bool,
    pub dragging: bool,
    pub position: [i32; 2],
}

struct Message {
    request: Request,
    origin: tauri::Url,
    profile: String,
    reply: tokio::sync::oneshot::Sender<Result<Snapshot, String>>,
}

#[derive(Serialize, Deserialize)]
struct SavedPosition {
    position: [i32; 2],
}

struct Worker {
    app: crate::AppHandle,
    session: Option<PetSession>,
    caps: BackendCaps,
    profile: String,
    origin: Option<tauri::Url>,
    start: Instant,
    persist: Option<Instant>,
    mask: Vec<electron_rs::rpc::Rectangle>,
    pending_size: Option<(u32, u32)>,
    warned: bool,
    last_step: Instant,
    x11: Option<super::pet_x11::Host>,
}

pub fn backend_caps() -> BackendCaps {
    if separate_x11_pet() {
        return BackendCaps::programmable();
    }
    let args = std::env::var("TAURI_RUNTIME_ELECTRON_ARGS").unwrap_or_default();
    if cfg!(target_os = "linux")
        && std::env::var_os("WAYLAND_DISPLAY").is_some()
        && args
            .split_whitespace()
            .rev()
            .find(|arg| arg.starts_with("--ozone-platform="))
            != Some("--ozone-platform=x11")
    {
        BackendCaps::wayland_constrained()
    } else {
        BackendCaps::programmable()
    }
}

pub fn separate_x11_pet() -> bool {
    cfg!(target_os = "linux")
        && super::pet_x11::separate_from_env(
            std::env::var_os("WAYLAND_DISPLAY").is_some(),
            &std::env::var("TAURI_RUNTIME_ELECTRON_ARGS").unwrap_or_default(),
        )
}

#[tauri::command]
pub async fn pet_native(
    app: crate::AppHandle,
    webview: crate::Webview,
    host: tauri::State<'_, PetHost>,
    request: Request,
) -> Result<Snapshot, String> {
    if webview.label() == LABEL {
        if matches!(request, Request::Sync { .. }) {
            return Err("PET_COMMAND_DENIED: settings belong to the shell".into());
        }
    } else {
        crate::desktop::window::require_shell(&webview)?;
        if !matches!(request, Request::Sync { .. } | Request::State) {
            return Err("PET_COMMAND_DENIED: input belongs to the pet window".into());
        }
    }
    let url = webview.url().map_err(|error| error.to_string())?;
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) || url.scheme() != "http" {
        return Err("PET_ORIGIN_DENIED".into());
    }
    let profile = if webview.label() == LABEL {
        crate::service::workflow::instances::window_profile(&app, LABEL)
    } else {
        crate::service::workflow::instances::window_profile(&app, webview.window().label())
    };
    let sender = host.0.get_or_init(|| {
        let (sender, receiver) = mpsc::channel();
        let app = app.clone();
        std::thread::spawn(move || Worker::new(app).run(receiver));
        sender
    });
    let (reply, result) = tokio::sync::oneshot::channel();
    sender
        .send(Message {
            request,
            origin: url,
            profile,
            reply,
        })
        .map_err(|_| "PET_HOST_STOPPED".to_string())?;
    result.await.map_err(|_| "PET_HOST_STOPPED".to_string())?
}

impl Worker {
    fn new(app: crate::AppHandle) -> Self {
        Self {
            app,
            session: None,
            caps: backend_caps(),
            profile: String::new(),
            origin: None,
            start: Instant::now(),
            persist: None,
            mask: Vec::new(),
            pending_size: None,
            warned: false,
            last_step: Instant::now(),
            x11: None,
        }
    }
    fn run(mut self, receiver: mpsc::Receiver<Message>) {
        loop {
            self.drain_x11();
            match receiver.recv_timeout(Duration::from_millis(16)) {
                Ok(message) => {
                    let result = self.handle(message.request, message.origin, message.profile);
                    let _ = message.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if let Err(error) = self.tick() {
                log::warn!("PET_HOST_FAILED: {error}");
            }
        }
    }
    fn snapshot(&self) -> Snapshot {
        let position = self.actual().unwrap_or(Point::new(0, 0));
        Snapshot {
            desktop_supported: true,
            desktop_open: self.open(),
            overlay_supported: self.caps.absolute_position && self.caps.always_on_top,
            dragging: self
                .session
                .as_ref()
                .is_some_and(|s| s.phase() == Phase::Dragging),
            position: [position.x, position.y],
        }
    }
    fn window(&self) -> Option<crate::WebviewWindow> {
        self.app.get_webview_window(LABEL)
    }
    fn open(&self) -> bool {
        self.x11.is_some() || self.window().is_some()
    }
    fn drain_x11(&mut self) {
        let events = self.x11.as_ref().map(|host| host.poll()).unwrap_or_default();
        for event in events {
            match event {
                super::pet_x11::Incoming::Page { id, request } => {
                    if !matches!(request, Request::Ready | Request::Pointer { .. } | Request::Frame { .. } | Request::Resize { .. } | Request::Menu) {
                        self.x11.as_ref().map(|host| host.reply_page(id, Err("PET_COMMAND_DENIED".into())));
                        continue;
                    }
                    let origin = self.origin.clone();
                    let profile = self.profile.clone();
                    let result = match origin {
                        Some(origin) => self.handle(request, origin, profile).map(|snapshot| serde_json::to_value(snapshot).unwrap_or(serde_json::Value::Null)),
                        None => Err("PET_OWNER_MISMATCH".into()),
                    };
                    if let Some(host) = &self.x11 {
                        host.reply_page(id, result);
                    }
                }
                super::pet_x11::Incoming::Menu(action) => self.menu_action(&action),
                super::pet_x11::Incoming::Closed => {
                    self.x11 = None;
                    self.session = None;
                    self.persist = None;
                }
            }
        }
    }
    fn actual(&self) -> Result<Point, String> {
        if let Some(host) = &self.x11 {
            let (x, y) = host.position()?;
            return Ok(Point::new(x, y));
        }
        let p = self
            .window()
            .ok_or("PET_WINDOW_MISSING")?
            .outer_position()
            .map_err(|e| e.to_string())?;
        Ok(Point::new(p.x, p.y))
    }
    fn pointer(&self) -> Result<Point, String> {
        if let Some(host) = &self.x11 {
            let (x, y) = host.cursor()?;
            return Ok(Point::new(x, y));
        }
        let p = self.app.cursor_position().map_err(|e| e.to_string())?;
        Ok(Point::new(p.x.round() as i32, p.y.round() as i32))
    }
    fn handle(
        &mut self,
        request: Request,
        origin: tauri::Url,
        profile: String,
    ) -> Result<Snapshot, String> {
        match request {
            Request::Sync {
                enabled,
                throw_enabled,
            } => {
                if !enabled {
                    self.dismiss();
                } else {
                    if self.profile != profile
                        || self
                            .origin
                            .as_ref()
                            .is_some_and(|old| old.origin() != origin.origin())
                    {
                        self.dismiss();
                    }
                    self.profile = profile;
                    self.origin = Some(origin.clone());
                    if !self.open() {
                        self.create(origin, throw_enabled)?;
                    }
                    if let Some(session) = &mut self.session {
                        session.set_throw_enabled(throw_enabled && self.caps.absolute_position);
                    }
                    self.refresh();
                }
            }
            Request::State => {}
            _ => {
                if profile != self.profile
                    || self
                        .origin
                        .as_ref()
                        .is_none_or(|old| old.origin() != origin.origin())
                {
                    return Err("PET_OWNER_MISMATCH".into());
                }
                match request {
                    Request::Ready => {
                        self.show()?;
                    }
                    Request::Pointer { action } => self.input(&action)?,
                    Request::Frame { frame, rectangles } => {
                        if rectangles.len() > 4096
                            || rectangles.iter().any(|r| {
                                r.x < 0
                                    || r.y < 0
                                    || r.width == 0
                                    || r.height == 0
                                    || r.width > 2048
                                    || r.height > 2048
                            })
                        {
                            return Err("PET_INPUT_REGION_INVALID".into());
                        }
                        self.mask = rectangles;
                        let effects = self
                            .session
                            .as_mut()
                            .map(|s| s.note_frame(frame))
                            .unwrap_or_default();
                        self.effects(effects)?;
                    }
                    Request::Resize { width, height } => {
                        if !(1..=2048).contains(&width) || !(1..=2048).contains(&height) {
                            return Err("PET_SIZE_INVALID".into());
                        }
                        self.pending_size = Some((width, height));
                        self.layout()?;
                    }
                    Request::Menu => self.menu()?,
                    _ => {}
                }
            }
        }
        Ok(self.snapshot())
    }
    fn create(&mut self, origin: tauri::Url, throw_enabled: bool) -> Result<(), String> {
        let url = origin
            .join("/dsh-pet-lite/desktop")
            .map_err(|e| e.to_string())?;
        if separate_x11_pet() {
            return self.create_x11(url, throw_enabled);
        }
        let trusted_origin = url.origin();
        let overlay = self.caps.absolute_position && self.caps.always_on_top;
        let native_drag = !self.caps.absolute_position;
        let builder = WebviewWindowBuilder::new(&self.app, LABEL, WebviewUrl::External(url))
            .title("DeepSeek Pet")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .fullscreen(false)
            .skip_taskbar(true)
            .always_on_top(self.caps.always_on_top)
            .focusable(native_drag)
            .focused(false)
            .visible_on_all_workspaces(true)
            .visible(false)
            .inner_size(296., 209.)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .on_navigation(move |url| {
                url.origin() == trusted_origin && url.path() == "/dsh-pet-lite/desktop"
            })
            .initialization_script(format!(
                "globalThis.__DSH_PET_OVERLAY__ = {overlay}; globalThis.__DSH_PET_NATIVE_DRAG__ = {native_drag};"
            ));
        let window = builder
            .build()
            .map_err(|e| format!("PET_WINDOW_CREATE_FAILED: {e}"))?;
        tauri_runtime_electron::window::set_fullscreenable(&window.as_ref().window(), false)
            .map_err(|e| e.to_string())?;
        if overlay {
            let position = self.restored_position(296, 209);
            window
                .set_position(tauri::PhysicalPosition::new(position.x, position.y))
                .map_err(|e| e.to_string())?;
        }
        self.mask.clear();
        self.persist = None;
        self.pending_size = None;
        crate::service::workflow::instances::bind_window(LABEL, &self.profile);
        let platform = if cfg!(target_os = "macos") {
            Platform::MacOs
        } else if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Linux
        };
        let (session, effects) =
            PetSession::open(platform, self.caps, throw_enabled, self.actual()?);
        self.session = Some(session);
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        self.effects(effects)
    }
    fn create_x11(&mut self, url: tauri::Url, throw_enabled: bool) -> Result<(), String> {
        let dir = crate::config::get_base_dir(&self.app).join("pet-x11");
        let host = super::pet_x11::Host::spawn(&dir, url.as_str())?;
        let position = self.x11_position(&host);
        host.set_position(position.x, position.y)?;
        host.always_on_top(true)?;
        self.x11 = Some(host);
        self.mask.clear();
        self.persist = None;
        self.pending_size = None;
        let (session, effects) = PetSession::open(Platform::Linux, self.caps, throw_enabled, self.actual()?);
        self.session = Some(session);
        self.effects(effects)
    }
    fn x11_position(&self, host: &super::pet_x11::Host) -> Point {
        let saved = std::fs::read(self.position_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SavedPosition>(&bytes).ok())
            .map(|saved| Point::new(saved.position[0], saved.position[1]));
        if let Ok((x, y, width, height)) = host.work_area() {
            if let Some(saved) = saved {
                if saved.x >= x && saved.y >= y && saved.x < x + width && saved.y < y + height {
                    return saved;
                }
            }
            return Point::new(x + 48, y + 48);
        }
        saved.unwrap_or(Point::new(48, 48))
    }
    fn dismiss(&mut self) {
        if let Some(mut host) = self.x11.take() {
            host.close();
        }
        if let Some(window) = self.window() {
            let _ = window.close();
        }
        self.session = None;
        self.persist = None;
    }
    fn refresh(&self) {
        if let Some(host) = &self.x11 {
            let _ = host.refresh();
            return;
        }
        if let Some(window) = self.window() {
            let _ = window.emit("dsh-pet-refresh", ());
        }
    }
    fn show(&self) -> Result<(), String> {
        if let Some(host) = &self.x11 {
            return host.show();
        }
        if let Some(window) = self.window() {
            window.show().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn menu_action(&mut self, action: &str) {
        if action == "pet-open" {
            crate::utils::show_main_window(&self.app);
        }
        if action == "pet-close" {
            let origin = self.origin.clone();
            self.dismiss();
            if let Some(origin) = origin {
                if let Ok(url) = origin.join("/dsh-pet-lite/settings") {
                    tauri::async_runtime::spawn(async move {
                        let _ = reqwest::Client::new().put(url).json(&serde_json::json!({"enabled": false})).send().await;
                    });
                }
            }
        }
    }
    fn restored_position(&self, width: u32, height: u32) -> Point {
        let saved = std::fs::read(self.position_file())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SavedPosition>(&bytes).ok());
        let monitors = self.app.available_monitors().unwrap_or_default();
        if let Some(saved) = saved {
            if monitors.iter().any(|m| {
                let p = m.position();
                let s = m.size();
                let width = (f64::from(width) * m.scale_factor()).ceil() as u32;
                let height = (f64::from(height) * m.scale_factor()).ceil() as u32;
                saved.position[0] >= p.x
                    && saved.position[1] >= p.y
                    && i64::from(saved.position[0]) + i64::from(width)
                        <= i64::from(p.x) + i64::from(s.width)
                    && i64::from(saved.position[1]) + i64::from(height)
                        <= i64::from(p.y) + i64::from(s.height)
            }) {
                return Point::new(saved.position[0], saved.position[1]);
            }
        }
        self.app
            .primary_monitor()
            .ok()
            .flatten()
            .map(|m| {
                let area = m.work_area();
                let width = (f64::from(width) * m.scale_factor()).ceil() as u32;
                let height = (f64::from(height) * m.scale_factor()).ceil() as u32;
                Point::new(
                    area.position.x + area.size.width.saturating_sub(width + 24) as i32,
                    area.position.y + area.size.height.saturating_sub(height + 24) as i32,
                )
            })
            .unwrap_or(Point::new(24, 24))
    }
    fn input(&mut self, action: &str) -> Result<(), String> {
        if matches!(action, "release" | "cancel")
            && self
                .session
                .as_ref()
                .is_some_and(|s| s.phase() == Phase::Dragging)
        {
            self.input("move")?;
        }
        if !matches!(action, "press" | "move" | "release" | "cancel") {
            return Err("PET_POINTER_ACTION_INVALID".into());
        }
        if !self.caps.absolute_position {
            if action == "press" {
                let effects = self
                    .session
                    .as_mut()
                    .map(|session| session.press(0, Point::new(0, 0)))
                    .unwrap_or_default();
                self.effects(effects)?;
            }
            return Ok(());
        }
        let actual = self.actual()?;
        let pointer = self.pointer()?;
        let at = self.start.elapsed().as_millis() as u64;
        let Some(session) = self.session.as_mut() else {
            return Ok(());
        };
        let effects = match action {
            "press" => {
                self.persist = None;
                session.press_at(at, pointer, actual)
            }
            "move" => session.pointer_moved(at, pointer, actual),
            "release" | "cancel" => session.release(at, pointer, actual),
            _ => return Err("PET_POINTER_ACTION_INVALID".into()),
        };
        if action == "press" {
            if let Some(host) = &self.x11 {
                let (width, height) = host.content_size()?;
                host.set_shape(&[electron_rs::rpc::Rectangle { x: 0, y: 0, width, height }])?;
            } else if let Some(window) = self.window() {
                let size = window
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<u32>(window.scale_factor().map_err(|e| e.to_string())?);
                tauri_runtime_electron::window::set_input_shape(
                    &window.as_ref().window(),
                    vec![electron_rs::rpc::Rectangle {
                        x: 0,
                        y: 0,
                        width: size.width,
                        height: size.height,
                    }],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        self.effects(effects)?;
        if self
            .session
            .as_ref()
            .is_some_and(|s| s.phase() == Phase::Idle)
        {
            self.layout()?;
            self.input_shape()?;
        }
        Ok(())
    }
    fn tick(&mut self) -> Result<(), String> {
        let elapsed = self.last_step.elapsed();
        if elapsed < Duration::from_millis(16) {
            return Ok(());
        }
        self.last_step = Instant::now();
        if !self.open() {
            self.session = None;
            self.persist = None;
            return Ok(());
        }
        let Some(phase) = self.session.as_ref().map(PetSession::phase) else {
            return Ok(());
        };
        if phase == Phase::Dragging {
            self.input("move")?;
        }
        if phase == Phase::Thrown {
            let bounds = if let Some(host) = &self.x11 {
                let (x, y, width, height) = host.work_area()?;
                let (window_width, window_height) = host.content_size()?;
                Some(Bounds {
                    min_x: x,
                    min_y: y,
                    max_x: x + width.saturating_sub(window_width as i32),
                    max_y: y + height.saturating_sub(window_height as i32),
                })
            } else if let Some(window) = self.window() {
                match window.current_monitor().map_err(|e| e.to_string())? {
                    Some(monitor) => {
                        let area = monitor.work_area();
                        let size = window.inner_size().map_err(|e| e.to_string())?;
                        Some(Bounds {
                            min_x: area.position.x,
                            min_y: area.position.y,
                            max_x: area.position.x + area.size.width.saturating_sub(size.width) as i32,
                            max_y: area.position.y + area.size.height.saturating_sub(size.height) as i32,
                        })
                    }
                    None => None,
                }
            } else {
                None
            };
            if let Some(bounds) = bounds {
                let effects = self
                    .session
                    .as_mut()
                    .map(|session| session.step_throw(bounds, elapsed.as_millis().min(32) as u64))
                    .unwrap_or_default();
                self.effects(effects)?;
                if self
                    .session
                    .as_ref()
                    .is_some_and(|s| s.phase() == Phase::Idle)
                {
                    self.layout()?;
                    self.input_shape()?;
                }
            }
        }
        if self.persist.is_some_and(|at| Instant::now() >= at)
            && self
                .session
                .as_ref()
                .is_some_and(|s| s.phase() == Phase::Idle)
        {
            self.persist = None;
            let position = self.actual()?;
            let file = self.position_file();
            let parent = file.parent().ok_or("PET_POSITION_PATH_INVALID")?;
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let bytes = serde_json::to_vec(&SavedPosition {
                position: [position.x, position.y],
            })
            .map_err(|e| e.to_string())?;
            let tmp = file.with_extension("tmp");
            std::fs::write(&tmp, bytes)
                .and_then(|_| std::fs::rename(tmp, file))
                .map_err(|e| format!("PET_POSITION_SAVE_FAILED: {e}"))?;
        }
        Ok(())
    }
    fn position_file(&self) -> std::path::PathBuf {
        use sha2::{Digest, Sha256};
        let id = format!("{:x}", Sha256::digest(self.profile.as_bytes()));
        crate::config::get_base_dir(&self.app)
            .join("pet-window")
            .join(format!("{}.json", &id[..16]))
    }
    fn layout(&mut self) -> Result<(), String> {
        if self
            .session
            .as_ref()
            .is_some_and(|s| matches!(s.phase(), Phase::Dragging | Phase::Thrown))
        {
            return Ok(());
        }
        if let Some((width, height)) = self.pending_size.take() {
            if let Some(host) = &self.x11 {
                host.set_content_size(width, height)?;
            } else if let Some(window) = self.window() {
                let size = window
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<u32>(window.scale_factor().map_err(|e| e.to_string())?);
                if size.width != width || size.height != height {
                    window
                        .set_size(tauri::LogicalSize::new(width, height))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }
    fn input_shape(&self) -> Result<(), String> {
        if !self.caps.absolute_position
            || self
                .session
                .as_ref()
                .is_some_and(|s| s.phase() == Phase::Dragging)
        {
            return Ok(());
        }
        if let Some(host) = &self.x11 {
            return host.set_shape(&self.mask);
        }
        if let Some(window) = self.window() {
            window
                .set_ignore_cursor_events(self.mask.is_empty())
                .map_err(|e| e.to_string())?;
            if self.mask.is_empty() {
                return Ok(());
            }
            tauri_runtime_electron::window::set_input_shape(
                &window.as_ref().window(),
                self.mask.clone(),
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    fn effects(&mut self, effects: Vec<Effect>) -> Result<(), String> {
        for effect in effects {
            match effect {
                Effect::SetPosition(position) => {
                    if let Some(host) = &self.x11 {
                        let (x, y) = host.position()?;
                        if x != position.x || y != position.y {
                            host.set_position(position.x, position.y)?;
                        }
                    } else if let Some(window) = self.window() {
                        let actual = window.outer_position().map_err(|e| e.to_string())?;
                        if actual.x != position.x || actual.y != position.y {
                            window
                                .set_position(tauri::PhysicalPosition::new(position.x, position.y))
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
                Effect::Persist { delay_ms, .. } => {
                    self.persist = Some(Instant::now() + Duration::from_millis(u64::from(delay_ms)))
                }
                Effect::Layout => self.layout()?,
                Effect::UpdateInputShape => self.input_shape()?,
                Effect::SetAlwaysOnTop(value) => {
                    if let Some(host) = &self.x11 {
                        host.always_on_top(value)?;
                    } else if let Some(window) = self.window() {
                        window.set_always_on_top(value).map_err(|e| e.to_string())?;
                    }
                }
                Effect::WarnOverlayUnsupported if !self.warned => {
                    self.warned = true;
                    log::warn!("{}", super::pet_drag::OVERLAY_UNSUPPORTED_MESSAGE);
                }
                Effect::Raise => {
                    if let Some(window) = self.window() {
                        if let Err(error) = window.set_focus() {
                            log::warn!("PET_RAISE_FAILED: {error}");
                        }
                    }
                }
                Effect::BeginSystemDrag => {
                    if let Some(window) = self.window() {
                        if window.start_dragging().is_err() {
                            if let Some(session) = self.session.as_mut() {
                                let _ = session.system_drag_failed();
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn menu(&self) -> Result<(), String> {
        if let Some(host) = &self.x11 {
            return host.show_menu();
        }
        let Some(window) = self.window() else {
            return Ok(());
        };
        let open =
            tauri::menu::MenuItem::with_id(&self.app, "pet-open", "显示主界面", true, None::<&str>)
                .map_err(|e| e.to_string())?;
        let close =
            tauri::menu::MenuItem::with_id(&self.app, "pet-close", "关闭宠物", true, None::<&str>)
                .map_err(|e| e.to_string())?;
        let menu = tauri::menu::Menu::with_items(&self.app, &[&open, &close])
            .map_err(|e| e.to_string())?;
        let app = self.app.clone();
        let origin = self.origin.clone();
        tauri_runtime_electron::window::popup_context_menu(
            &window.as_ref().window(),
            &menu,
            move |id| {
                if id.as_ref() == "pet-open" {
                    crate::utils::show_main_window(&app);
                }
                if id.as_ref() == "pet-close" {
                    let app = app.clone();
                    let origin = origin.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(origin) = origin {
                            if let Ok(url) = origin.join("/dsh-pet-lite/settings") {
                                let _ = reqwest::Client::new()
                                    .put(url)
                                    .json(&serde_json::json!({"enabled":false}))
                                    .send()
                                    .await;
                            }
                        }
                        if let Some(window) = app.get_webview_window(LABEL) {
                            let _ = window.close();
                        }
                    });
                }
            },
        )
        .map_err(|e| e.to_string())
    }
}
