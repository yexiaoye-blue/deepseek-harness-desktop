//! 桌宠窗口的单一位置写入者。
//!
//! Codex 在 macOS 上会先尝试 performWindowDrag。那个接口只存在于 darwin，
//! Linux 必须走程序定位。鼠标监听只把样本交到这里；窗口坐标只由
//! Effect::SetPosition 写出。拖动期间持久化、抛射和自动布局都不写出，
//! 松手后再各执行一次。原生 Wayland 不能绝对定位时进入 Phase::Constrained，
//! PET_OVERLAY_UNSUPPORTED 只记录一次。

use std::collections::VecDeque;

pub const PERSIST_DELAY_MS: u32 = 300;
pub const DRAG_ENGAGE_PX: i32 = 1;
const SAMPLE_WINDOW_MS: u64 = 150;
const THROW_SPEED_PX_PER_SEC: i32 = 600;
const THROW_REST_PX_PER_SEC: i32 = 40;
const MAX_SAMPLES: usize = 64;

pub const OVERLAY_UNSUPPORTED_MESSAGE: &str = concat!(
    "PET_OVERLAY_UNSUPPORTED: always-on-top and absolute positioning are unavailable ",
    "on a native Wayland session; drag and throw are disabled. ",
    "Enable the XWayland option and restart to restore them."
);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    MacOs,
    Windows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BackendCaps {
    pub absolute_position: bool,
    pub always_on_top: bool,
}

impl BackendCaps {
    pub const fn programmable() -> Self {
        Self {
            absolute_position: true,
            always_on_top: true,
        }
    }
    pub const fn wayland_constrained() -> Self {
        Self {
            absolute_position: false,
            always_on_top: false,
        }
    }
    const fn can_position(self) -> bool {
        self.absolute_position && self.always_on_top
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

impl Point {
    pub const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
    fn saturating_add(self, other: Self) -> Self {
        Self::new(
            self.x.saturating_add(other.x),
            self.y.saturating_add(other.y),
        )
    }
    fn saturating_sub(self, other: Self) -> Self {
        Self::new(
            self.x.saturating_sub(other.x),
            self.y.saturating_sub(other.y),
        )
    }
    fn distance_exceeds(self, other: Self, px: i32) -> bool {
        let dx = i64::from(self.x) - i64::from(other.x);
        let dy = i64::from(self.y) - i64::from(other.y);
        dx * dx + dy * dy > i64::from(px) * i64::from(px)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Dragging,
    Thrown,
    Constrained,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Writer {
    None,
    System,
    Program,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    SetPosition(Point),
    Persist { position: Point, delay_ms: u32 },
    Layout,
    UpdateInputShape,
    WarnOverlayUnsupported,
    SetAlwaysOnTop(bool),
    BeginSystemDrag,
}

impl Effect {
    fn position(self) -> Option<Point> {
        match self {
            Self::SetPosition(position) => Some(position),
            _ => None,
        }
    }
}

#[derive(Clone, Copy)]
struct Sample {
    at_ms: u64,
    point: Point,
}

pub struct Controller {
    platform: Platform,
    caps: BackendCaps,
    throw_enabled: bool,
    phase: Phase,
    writer: Writer,
    offset: Point,
    origin: Option<Point>,
    last_request: Option<(Point, Point)>,
    observed: Option<Point>,
    position: Point,
    velocity: (i32, i32),
    samples: VecDeque<Sample>,
    overlay_warned: bool,
    layout_deferred: bool,
    engaged: bool,
    frame: u64,
}

impl Controller {
    pub fn new(platform: Platform, caps: BackendCaps, throw_enabled: bool) -> Self {
        Self {
            platform,
            caps,
            throw_enabled,
            phase: if caps.can_position() {
                Phase::Idle
            } else {
                Phase::Constrained
            },
            writer: Writer::None,
            offset: Point::new(0, 0),
            origin: None,
            last_request: None,
            observed: None,
            position: Point::new(0, 0),
            velocity: (0, 0),
            samples: VecDeque::new(),
            overlay_warned: false,
            layout_deferred: false,
            engaged: false,
            frame: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn position(&self) -> Point {
        self.position
    }

    /// macOS 才有系统拖动。Linux 与 Windows 返回 false，不能把 performWindowDrag 照搬过去。
    pub const fn system_drag_available(platform: Platform) -> bool {
        matches!(platform, Platform::MacOs)
    }

    pub fn activate(&mut self) -> Vec<Effect> {
        if self.caps.can_position() {
            self.phase = Phase::Idle;
            return vec![Effect::SetAlwaysOnTop(true)];
        }
        self.phase = Phase::Constrained;
        self.warn_once()
    }

    pub fn press(&mut self, at_ms: u64, pointer: Point, window: Point) -> Vec<Effect> {
        if !self.caps.can_position() {
            self.phase = Phase::Constrained;
            return self.warn_once();
        }
        if self.phase == Phase::Dragging {
            return Vec::new();
        }
        self.phase = Phase::Dragging;
        self.position = window;
        self.offset = window.saturating_sub(pointer);
        self.origin = Some(pointer);
        self.last_request = None;
        self.observed = None;
        self.velocity = (0, 0);
        self.samples.clear();
        self.remember(at_ms, pointer);
        self.engaged = false;
        self.layout_deferred = false;
        if Self::system_drag_available(self.platform) {
            self.writer = Writer::System;
            vec![Effect::BeginSystemDrag]
        } else {
            self.writer = Writer::Program;
            Vec::new()
        }
    }

    pub fn system_drag_failed(&mut self) -> Vec<Effect> {
        if self.phase != Phase::Dragging || self.writer != Writer::System {
            return Vec::new();
        }
        self.writer = Writer::Program;
        Vec::new()
    }

    pub fn pointer_moved(&mut self, at_ms: u64, pointer: Point, actual: Point) -> Vec<Effect> {
        if !self.caps.can_position() || self.phase == Phase::Constrained {
            return self.warn_once();
        }
        if self.phase != Phase::Dragging {
            return Vec::new();
        }
        self.remember(at_ms, pointer);
        if self
            .origin
            .is_some_and(|origin| pointer.distance_exceeds(origin, DRAG_ENGAGE_PX))
        {
            self.engaged = true;
        }
        if self.writer != Writer::Program || !self.engaged {
            return Vec::new();
        }
        let previously = self.observed;
        self.observed = Some(actual);
        if let Some((requested, request_pointer)) = self.last_request {
            let changed = previously.is_some_and(|previous| previous != actual);
            if actual != requested && changed {
                self.offset = actual.saturating_sub(request_pointer);
            }
        }
        let target = pointer.saturating_add(self.offset);
        if target == actual
            || self
                .last_request
                .is_some_and(|(requested, _)| requested == target)
        {
            self.position = actual;
            return Vec::new();
        }
        self.last_request = Some((target, pointer));
        self.position = target;
        vec![Effect::SetPosition(target)]
    }

    pub fn release(&mut self, at_ms: u64, pointer: Point, actual: Point) -> Vec<Effect> {
        if self.phase != Phase::Dragging {
            return Vec::new();
        }
        self.remember(at_ms, pointer);
        let velocity = self.release_velocity(at_ms);
        let engaged = self.engaged;
        self.writer = Writer::None;
        self.engaged = false;
        self.origin = None;
        self.last_request = None;
        self.observed = None;
        self.samples.clear();
        self.position = actual;
        if engaged && self.throw_enabled && speed(velocity.0, velocity.1) > THROW_SPEED_PX_PER_SEC {
            self.phase = Phase::Thrown;
            self.velocity = velocity;
            return Vec::new();
        }
        self.phase = Phase::Idle;
        self.velocity = (0, 0);
        self.settle(actual)
    }

    pub fn layout(&mut self) -> Vec<Effect> {
        match self.phase {
            Phase::Dragging | Phase::Thrown => {
                self.layout_deferred = true;
                Vec::new()
            }
            Phase::Constrained => Vec::new(),
            Phase::Idle => vec![Effect::Layout],
        }
    }

    pub fn persist(&mut self) -> Vec<Effect> {
        if self.phase != Phase::Idle {
            return Vec::new();
        }
        vec![self.persist_effect(self.position)]
    }

    pub fn step_throw(&mut self, bounds: Bounds, dt_ms: u64) -> Vec<Effect> {
        if self.phase != Phase::Thrown || dt_ms == 0 {
            return Vec::new();
        }
        let mut x = self
            .position
            .x
            .saturating_add(scale_velocity(self.velocity.0, dt_ms));
        let mut y = self
            .position
            .y
            .saturating_add(scale_velocity(self.velocity.1, dt_ms));
        let (mut vx, mut vy) = self.velocity;
        if x < bounds.min_x {
            x = bounds.min_x;
            vx = damp(-vx);
        } else if x > bounds.max_x {
            x = bounds.max_x;
            vx = damp(-vx);
        } else {
            vx = damp(vx);
        }
        if y < bounds.min_y {
            y = bounds.min_y;
            vy = damp(-vy);
        } else if y > bounds.max_y {
            y = bounds.max_y;
            vy = damp(-vy);
        } else {
            vy = damp(vy);
        }
        self.velocity = (vx, vy);
        let next = Point::new(x, y);
        let mut effects = Vec::new();
        if next != self.position {
            self.position = next;
            effects.push(Effect::SetPosition(next));
        }
        if speed(self.velocity.0, self.velocity.1) < THROW_REST_PX_PER_SEC {
            let landed = self.position;
            self.phase = Phase::Idle;
            self.velocity = (0, 0);
            effects.extend(self.settle(landed));
        }
        effects
    }

    pub fn note_frame(&mut self, frame: u64) -> Vec<Effect> {
        if frame == self.frame {
            return Vec::new();
        }
        self.frame = frame;
        vec![Effect::UpdateInputShape]
    }

    /// 主窗口最小化或隐藏不改变宠物阶段和位置。宠物窗口不跟随主窗口销毁。
    pub fn main_window_changed(&mut self, _minimized: bool, _hidden: bool) -> Vec<Effect> {
        Vec::new()
    }

    fn settle(&mut self, position: Point) -> Vec<Effect> {
        let mut effects = vec![self.persist_effect(position)];
        if self.layout_deferred {
            self.layout_deferred = false;
            effects.push(Effect::Layout);
        }
        effects
    }

    fn persist_effect(&self, position: Point) -> Effect {
        Effect::Persist {
            position,
            delay_ms: PERSIST_DELAY_MS,
        }
    }

    fn warn_once(&mut self) -> Vec<Effect> {
        if self.overlay_warned {
            return Vec::new();
        }
        self.overlay_warned = true;
        self.phase = Phase::Constrained;
        vec![
            Effect::WarnOverlayUnsupported,
            Effect::SetAlwaysOnTop(false),
        ]
    }

    fn remember(&mut self, at_ms: u64, point: Point) {
        self.samples.push_back(Sample { at_ms, point });
        while self.samples.len() > MAX_SAMPLES {
            self.samples.pop_front();
        }
    }

    fn release_velocity(&self, at_ms: u64) -> (i32, i32) {
        let Some(last) = self.samples.back() else {
            return (0, 0);
        };
        let start = self
            .samples
            .iter()
            .rev()
            .find(|sample| at_ms.saturating_sub(sample.at_ms) >= SAMPLE_WINDOW_MS)
            .or_else(|| self.samples.front());
        let Some(start) = start else {
            return (0, 0);
        };
        let dt = last.at_ms.saturating_sub(start.at_ms);
        if dt == 0 {
            return (0, 0);
        }
        let elapsed = i64::try_from(dt).unwrap_or(i64::MAX);
        let dx = (i64::from(last.point.x) - i64::from(start.point.x)) * 1000 / elapsed;
        let dy = (i64::from(last.point.y) - i64::from(start.point.y)) * 1000 / elapsed;
        (clamp_i32(dx), clamp_i32(dy))
    }
}

/// 独立宠物窗口的固定属性。主窗口最小化、隐藏或恢复时不销毁它。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PetWindowSpec {
    pub transparent: bool,
    pub frame: bool,
    pub shadow: bool,
    pub resizable: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub fullscreenable: bool,
    pub skip_taskbar: bool,
    pub always_on_top: bool,
    pub focusable: bool,
    pub independent_of_main: bool,
}

impl PetWindowSpec {
    pub const fn independent(always_on_top: bool) -> Self {
        Self {
            transparent: true,
            frame: false,
            shadow: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skip_taskbar: true,
            always_on_top,
            focusable: false,
            independent_of_main: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PetDisplay {
    pub visible: bool,
    pub position: Point,
}

pub struct PetSession {
    spec: PetWindowSpec,
    display: PetDisplay,
    motion: Controller,
}

impl PetSession {
    pub fn open(
        platform: Platform,
        caps: BackendCaps,
        throw_enabled: bool,
        position: Point,
    ) -> (Self, Vec<Effect>) {
        let mut motion = Controller::new(platform, caps, throw_enabled);
        motion.position = position;
        let effects = motion.activate();
        (
            Self {
                spec: PetWindowSpec::independent(caps.can_position()),
                display: PetDisplay {
                    visible: true,
                    position,
                },
                motion,
            },
            effects,
        )
    }
    pub fn spec(&self) -> PetWindowSpec {
        self.spec
    }
    pub fn display(&self) -> PetDisplay {
        self.display
    }
    pub fn phase(&self) -> Phase {
        self.motion.phase()
    }
    pub fn on_main_window(&mut self, minimized: bool, hidden: bool) -> PetDisplay {
        let _ = self.motion.main_window_changed(minimized, hidden);
        self.display
    }
    pub fn press(&mut self, at_ms: u64, pointer: Point) -> Vec<Effect> {
        self.motion.press(at_ms, pointer, self.display.position)
    }
    pub fn pointer_moved(&mut self, at_ms: u64, pointer: Point, actual: Point) -> Vec<Effect> {
        let effects = self.motion.pointer_moved(at_ms, pointer, actual);
        self.apply_display(&effects);
        effects
    }
    pub fn release(&mut self, at_ms: u64, pointer: Point, actual: Point) -> Vec<Effect> {
        let effects = self.motion.release(at_ms, pointer, actual);
        self.apply_display(&effects);
        effects
    }
    pub fn system_drag_failed(&mut self) -> Vec<Effect> {
        self.motion.system_drag_failed()
    }
    pub fn layout(&mut self) -> Vec<Effect> {
        self.motion.layout()
    }
    pub fn step_throw(&mut self, bounds: Bounds, dt_ms: u64) -> Vec<Effect> {
        let effects = self.motion.step_throw(bounds, dt_ms);
        self.apply_display(&effects);
        effects
    }
    pub fn note_frame(&mut self, frame: u64) -> Vec<Effect> {
        self.motion.note_frame(frame)
    }
    fn apply_display(&mut self, effects: &[Effect]) {
        if let Some(position) = effects.iter().rev().find_map(|effect| effect.position()) {
            self.display.position = position;
        }
        for effect in effects {
            if let Effect::Persist { position, .. } = effect {
                self.display.position = *position;
            }
        }
    }
}

fn scale_velocity(px_per_sec: i32, dt_ms: u64) -> i32 {
    clamp_i32(i64::from(px_per_sec) * i64::try_from(dt_ms).unwrap_or(i64::MAX) / 1000)
}
fn damp(velocity: i32) -> i32 {
    velocity.saturating_mul(4) / 5
}
fn speed(vx: i32, vy: i32) -> i32 {
    let mag = ((i64::from(vx) * i64::from(vx) + i64::from(vy) * i64::from(vy)) as f64).sqrt();
    if !mag.is_finite() {
        return i32::MAX;
    }
    let rounded = mag.round();
    if rounded >= f64::from(i32::MAX) {
        i32::MAX
    } else if rounded <= f64::from(i32::MIN) {
        i32::MIN
    } else {
        rounded as i32
    }
}
fn clamp_i32(value: i64) -> i32 {
    i32::try_from(value).unwrap_or(if value < 0 { i32::MIN } else { i32::MAX })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn linux(throw_enabled: bool) -> PetSession {
        let (session, effects) = PetSession::open(
            Platform::Linux,
            BackendCaps::programmable(),
            throw_enabled,
            Point::new(100, 80),
        );
        assert!(effects.contains(&Effect::SetAlwaysOnTop(true)));
        assert!(
            !effects
                .iter()
                .any(|effect| matches!(effect, Effect::BeginSystemDrag))
        );
        session
    }
    fn positions(effects: &[Effect]) -> Vec<Point> {
        effects
            .iter()
            .filter_map(|effect| effect.position())
            .collect()
    }
    fn persists(effects: &[Effect]) -> Vec<Effect> {
        effects
            .iter()
            .copied()
            .filter(|effect| matches!(effect, Effect::Persist { .. }))
            .collect()
    }

    #[test]
    fn linux_records_offset_and_never_starts_system_drag() {
        assert!(!Controller::system_drag_available(Platform::Linux));
        assert!(Controller::system_drag_available(Platform::MacOs));
        let mut session = linux(false);
        assert!(session.press(0, Point::new(10, 20)).is_empty());
        let moved = session.pointer_moved(16, Point::new(14, 20), Point::new(100, 80));
        assert_eq!(positions(&moved), vec![Point::new(104, 80)]);
        assert!(!moved.iter().any(|effect| matches!(
            effect,
            Effect::BeginSystemDrag | Effect::Persist { .. } | Effect::Layout
        )));
    }

    #[test]
    fn unchanged_actual_position_does_not_repeat_the_same_target() {
        let mut session = linux(false);
        session.press(0, Point::new(0, 0));
        assert_eq!(
            positions(&session.pointer_moved(16, Point::new(4, 0), Point::new(100, 80))),
            vec![Point::new(104, 80)]
        );
        assert!(
            positions(&session.pointer_moved(32, Point::new(4, 0), Point::new(100, 80))).is_empty()
        );
        assert!(
            positions(&session.pointer_moved(48, Point::new(4, 0), Point::new(104, 80))).is_empty()
        );
    }

    #[test]
    fn clamped_position_updates_offset_instead_of_replaying_the_old_one() {
        let mut session = linux(false);
        session.press(0, Point::new(0, 0));
        assert_eq!(
            positions(&session.pointer_moved(16, Point::new(10, 0), Point::new(100, 80))),
            vec![Point::new(110, 80)]
        );
        assert!(
            positions(&session.pointer_moved(32, Point::new(10, 0), Point::new(100, 80)))
                .is_empty()
        );
        assert_eq!(
            positions(&session.pointer_moved(48, Point::new(12, 0), Point::new(105, 80))),
            vec![Point::new(107, 80)]
        );
    }

    #[test]
    fn drag_blocks_persist_throw_and_layout_until_one_final_save() {
        let mut session = linux(true);
        session.press(0, Point::new(0, 0));
        assert_eq!(
            positions(&session.pointer_moved(16, Point::new(8, 0), Point::new(100, 80))),
            vec![Point::new(108, 80)]
        );
        assert!(session.layout().is_empty());
        assert!(session.motion.persist().is_empty());
        assert!(
            session
                .step_throw(
                    Bounds {
                        min_x: 0,
                        min_y: 0,
                        max_x: 500,
                        max_y: 500
                    },
                    16
                )
                .is_empty()
        );
        let released = session.release(32, Point::new(8, 0), Point::new(108, 80));
        assert!(positions(&released).is_empty());
        assert_eq!(
            persists(&released),
            vec![Effect::Persist {
                position: Point::new(108, 80),
                delay_ms: 300
            }]
        );
        assert_eq!(
            released
                .iter()
                .filter(|effect| matches!(effect, Effect::Layout))
                .count(),
            1
        );
        assert_eq!(session.phase(), Phase::Idle);
    }

    #[test]
    fn wayland_disables_drag_and_throw_and_warns_once() {
        let (mut session, effects) = PetSession::open(
            Platform::Linux,
            BackendCaps::wayland_constrained(),
            true,
            Point::new(0, 0),
        );
        assert_eq!(
            effects,
            vec![
                Effect::WarnOverlayUnsupported,
                Effect::SetAlwaysOnTop(false)
            ]
        );
        assert_eq!(session.phase(), Phase::Constrained);
        assert!(!session.spec().always_on_top && session.spec().independent_of_main);
        assert!(session.press(0, Point::new(3, 3)).is_empty());
        for step in 1_i32..30 {
            assert!(
                session
                    .pointer_moved(
                        u64::try_from(step).unwrap() * 16,
                        Point::new(step * 8, 0),
                        Point::new(0, 0)
                    )
                    .is_empty(),
                "{}",
                OVERLAY_UNSUPPORTED_MESSAGE
            );
        }
        assert!(
            session
                .release(1_000, Point::new(40, 0), Point::new(0, 0))
                .is_empty()
        );
        assert!(
            session
                .step_throw(
                    Bounds {
                        min_x: 0,
                        min_y: 0,
                        max_x: 100,
                        max_y: 100
                    },
                    16
                )
                .is_empty()
        );
        assert_eq!(session.display().position, Point::new(0, 0));
    }

    #[test]
    fn monotonic_drag_does_not_reverse_and_crosses_screens() {
        let mut session = linux(false);
        let mut actual = Point::new(1_800, 100);
        session.display.position = actual;
        session.press(0, Point::new(1_800, 100));
        let mut written = Vec::new();
        for x in [1_804, 1_820, 1_900, 2_050, 2_200] {
            let next = positions(&session.pointer_moved(16, Point::new(x, 100), actual));
            assert!(next.len() <= 1);
            if let Some(position) = next.first() {
                assert!(position.x >= actual.x);
                actual = *position;
                written.push(*position);
            }
        }
        assert_eq!(written.last().copied(), Some(Point::new(2_200, 100)));
        assert!(written.iter().any(|position| position.x > 1_920));
    }

    #[test]
    fn twenty_drags_end_on_the_pointer_offset_without_a_second_save() {
        let mut session = linux(false);
        for index in 0..20 {
            let origin = index * 25;
            session.display.position = Point::new(origin, 40);
            assert!(session.press(0, Point::new(origin, 40)).is_empty());
            let moved =
                session.pointer_moved(16, Point::new(origin + 6, 42), Point::new(origin, 40));
            assert_eq!(positions(&moved), vec![Point::new(origin + 6, 42)]);
            assert!(persists(&moved).is_empty());
            let released =
                session.release(40, Point::new(origin + 6, 42), Point::new(origin + 6, 42));
            assert_eq!(persists(&released).len(), 1);
            assert_eq!(session.display().position, Point::new(origin + 6, 42));
        }
    }

    #[test]
    fn macos_system_drag_is_the_only_writer_until_it_fails() {
        let (mut session, _) = PetSession::open(
            Platform::MacOs,
            BackendCaps::programmable(),
            false,
            Point::new(10, 10),
        );
        assert_eq!(
            session.press(0, Point::new(1, 1)),
            vec![Effect::BeginSystemDrag]
        );
        assert!(
            positions(&session.pointer_moved(16, Point::new(12, 1), Point::new(10, 10))).is_empty()
        );
        assert!(session.system_drag_failed().is_empty());
        let moved = session.pointer_moved(32, Point::new(14, 1), Point::new(10, 10));
        assert_eq!(positions(&moved), vec![Point::new(23, 10)]);
        assert!(
            !moved
                .iter()
                .any(|effect| matches!(effect, Effect::BeginSystemDrag))
        );
    }

    #[test]
    fn throw_starts_after_release_and_reverses_once_at_the_edge() {
        let mut session = linux(true);
        session.display.position = Point::new(0, 0);
        session.press(0, Point::new(0, 0));
        assert_eq!(
            positions(&session.pointer_moved(200, Point::new(400, 0), Point::new(0, 0))),
            vec![Point::new(400, 0)]
        );
        assert!(session.layout().is_empty());
        assert!(
            session
                .release(200, Point::new(400, 0), Point::new(400, 0))
                .is_empty()
        );
        assert_eq!(session.phase(), Phase::Thrown);
        let bounds = Bounds {
            min_x: 0,
            min_y: 0,
            max_x: 450,
            max_y: 200,
        };
        assert_eq!(
            positions(&session.step_throw(bounds, 50)),
            vec![Point::new(450, 0)]
        );
        let inward = positions(&session.step_throw(bounds, 50));
        assert_eq!(inward.len(), 1);
        assert!(inward[0].x < 450);
        let mut saw_rest = false;
        for _ in 0..40 {
            let effects = session.step_throw(bounds, 50);
            if persists(&effects).len() == 1 {
                saw_rest = true;
                assert_eq!(
                    effects
                        .iter()
                        .filter(|effect| matches!(effect, Effect::Layout))
                        .count(),
                    1
                );
                break;
            }
            assert!(persists(&effects).is_empty());
        }
        assert!(saw_rest);
        assert_eq!(session.phase(), Phase::Idle);
    }

    #[test]
    fn input_shape_tracks_frames_and_main_window_minimize_keeps_the_pet() {
        let mut session = linux(false);
        let before = session.display();
        assert_eq!(session.on_main_window(true, false), before);
        assert_eq!(session.on_main_window(false, true), before);
        assert_eq!(session.on_main_window(false, false), before);
        let spec = session.spec();
        assert!(spec.transparent && !spec.frame && !spec.shadow && !spec.resizable);
        assert!(!spec.minimizable && !spec.maximizable && !spec.fullscreenable);
        assert!(
            spec.skip_taskbar && !spec.focusable && spec.independent_of_main && spec.always_on_top
        );
        assert!(session.press(0, before.position).is_empty());
        assert!(
            session
                .pointer_moved(
                    16,
                    Point::new(before.position.x + 2, before.position.y),
                    before.position
                )
                .iter()
                .all(|effect| !matches!(effect, Effect::UpdateInputShape))
        );
        assert_eq!(session.note_frame(1), vec![Effect::UpdateInputShape]);
        assert!(session.note_frame(1).is_empty());
        assert_eq!(session.note_frame(2), vec![Effect::UpdateInputShape]);
        assert!(session.display().visible);
    }

    #[test]
    fn overlay_message_names_the_capability_once() {
        assert!(OVERLAY_UNSUPPORTED_MESSAGE.starts_with("PET_OVERLAY_UNSUPPORTED"));
        let mut motion = Controller::new(Platform::Linux, BackendCaps::wayland_constrained(), true);
        assert_eq!(
            motion
                .activate()
                .iter()
                .filter(|effect| matches!(effect, Effect::WarnOverlayUnsupported))
                .count(),
            1
        );
        assert!(motion.activate().is_empty());
        assert!(
            motion
                .press(0, Point::new(1, 1), Point::new(2, 2))
                .is_empty()
        );
    }
}
