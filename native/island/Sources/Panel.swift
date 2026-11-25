import AppKit
import SwiftUI

/// The island's window: borderless, above the menu bar, on every Space and over full-screen apps.
/// It never activates Kettu, and takes the keyboard only while the user opened it with a click.
final class IslandPanel: NSPanel {
  var keyable = false

  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }

  // The island sits over the menu bar, where AppKit would otherwise push a window down.
  override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
    frameRect
  }
}

/// Places the island on the screen with the menu bar and turns the pointer, clicks and keys into
/// what the model does. The window keeps the largest size the island can take; outside the shape
/// it lets every click through.
final class IslandController {
  private let model: IslandModel
  private let panel: IslandPanel
  /// The middle of the island's top edge, in screen coordinates.
  private var top = CGPoint.zero
  private var monitors: [Any] = []
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []
  private var hoverTimer: Timer?
  private var leaveTimer: Timer?
  private var inside = false
  /// The pointer's latest place and time, and its speed in points per ms, smoothed.
  private var lastPoint: CGPoint?
  private var lastMove: TimeInterval = 0
  private var speed: Double = 0
  private var hideWork: DispatchWorkItem?
  private let floating: Bool
  private let notchScreen: Bool
  private let fakeNotch: Bool
  private let fixedRoom: BarRoom?
  /// Huli: the menu bar's room beside the notch, measured on events, and where it was measured.
  private let watcher = MenuBarWatcher()
  private var area: BarArea?
  private var inBar = false

  /// `floating`, `notchScreen`, `fakeNotch` and `fixedRoom` are development switches: draw the
  /// island as on a screen without a notch, keep to the screen with the notch whichever display is
  /// in use, draw a notch on a screen without one, and take this room instead of measuring it.
  init(
    model: IslandModel, floating: Bool = false, notchScreen: Bool = false, fakeNotch: Bool = false,
    fixedRoom: BarRoom? = nil
  ) {
    self.model = model
    self.floating = floating
    self.notchScreen = notchScreen
    self.fakeNotch = fakeNotch
    self.fixedRoom = fixedRoom
    panel = IslandPanel(
      contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered,
      defer: true)
    panel.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
    panel.collectionBehavior = [
      .canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle,
    ]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isMovable = false
    panel.isReleasedWhenClosed = false
    panel.ignoresMouseEvents = true
    panel.acceptsMouseMovedEvents = true
    panel.becomesKeyOnlyIfNeeded = true
    panel.animationBehavior = .none
    let host = NSHostingView(rootView: IslandRoot(model: model))
    host.sizingOptions = []
    panel.contentView = host

    model.onModeChange = { [weak self] mode in self?.modeChanged(mode) }
    model.onAnnounce = { [weak self] text in self?.announce(text) }
    model.onSidesChange = { [weak self] in self?.watcher.check() }
    model.drawsNotch = fakeNotch
    if let fixedRoom { model.room = fixedRoom }
    watcher.area = { [weak self] in self?.measuredArea() }
    watcher.onRoom = { [weak self] room in self?.setRoom(room) }
    place()
    watch()
  }

  // MARK: The menu bar's room

  /// The area to measure, while measuring matters: not once the island is gone, nor while
  /// Settings keeps it in the notch, nor with a room given for development.
  private func measuredArea() -> BarArea? {
    guard model.mode != .hidden, model.sides == .auto, fixedRoom == nil else { return nil }
    return area
  }

  private func setRoom(_ room: BarRoom) {
    guard room != model.room else { return }
    log("Menu bar room beside the notch: left \(Int(room.left)), right \(Int(room.right))")
    model.room = room
  }

  // MARK: Placement

  /// The screen with the menu bar; with a menu bar on every display, the one in use.
  private func screen() -> NSScreen? {
    if notchScreen, let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
      return notched
    }
    if NSScreen.screensHaveSeparateSpaces, let main = NSScreen.main { return main }
    return NSScreen.screens.first
  }

  func place() {
    guard let screen = screen() else { return }
    let frame = screen.frame
    let menuBar = frame.maxY - screen.visibleFrame.maxY
    var g = IslandGeometry()
    if !floating, screen.safeAreaInsets.top > 0, let left = screen.auxiliaryTopLeftArea,
      let right = screen.auxiliaryTopRightArea
    {
      g.notchWidth = frame.width - left.width - right.width
      g.notchHeight = screen.safeAreaInsets.top
      g.hasNotch = true
      top = CGPoint(x: frame.minX + left.width + g.notchWidth / 2, y: frame.maxY)
    } else if fakeNotch {
      // A 13-inch MacBook Air's notch in the middle of a menu bar that has none.
      g.notchWidth = 185
      g.notchHeight = menuBar > 0 ? menuBar : Metrics.bandHeight
      g.hasNotch = true
      top = CGPoint(x: frame.midX, y: frame.maxY)
    } else {
      // No notch: the island grows down from the middle of the top of the screen, as it would
      // from a notch. Huli: collapsed, it stays out of the menu bar (see `wings`).
      g.notchWidth = 0
      g.notchHeight = menuBar > 0 ? menuBar : Metrics.bandHeight
      g.hasNotch = false
      top = CGPoint(x: frame.midX, y: frame.maxY)
    }
    g.maxHeight = (frame.height * Metrics.maxHeightShare).rounded()
    if model.geometry != g { model.geometry = g }
    let width =
      max(
        Metrics.openWidth, g.notchWidth + Metrics.openWings, Metrics.grownWidth,
        g.notchWidth + 2 * (Metrics.maxWing + Metrics.shoulder)) + 2 * Metrics.margin
    let height = g.maxHeight + Metrics.margin
    panel.setFrame(
      NSRect(x: (top.x - width / 2).rounded(), y: top.y - height, width: width, height: height),
      display: false)
    // The window list counts from the top left of the main screen, AppKit from its bottom left.
    let mainTop = NSScreen.screens.first?.frame.maxY ?? frame.maxY
    let bandHeight = max(g.notchHeight, menuBar)
    let next = BarArea(
      notch: CGRect(
        x: top.x - g.notchWidth / 2, y: mainTop - frame.maxY, width: g.notchWidth,
        height: g.notchHeight),
      band: CGRect(x: frame.minX, y: mainTop - frame.maxY, width: frame.width, height: bandHeight))
    if next != area {
      area = next
      watcher.check()
    }
  }

  private func watch() {
    let center = NotificationCenter.default
    let workspace = NSWorkspace.shared.notificationCenter
    observers.append(
      (
        center,
        center.addObserver(
          forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
          self?.place()
          self?.watcher.check()
        }
      ))
    // With a menu bar on every display, the one in use changes with the active app and Space.
    // Huli: the front app's menus change with it too, and settle a moment after the switch.
    for name in [
      NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.didActivateApplicationNotification,
    ] {
      observers.append(
        (
          workspace,
          workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if self.model.mode != .open { self.place() }
            self.watcher.check()
            self.watcher.check(after: 0.5)
          }
        ))
    }
    // Huli: an app that starts puts its status item up a little later; one that quits takes it away.
    observers.append(
      (
        workspace,
        workspace.addObserver(
          forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.watcher.check(after: 1.5) }
      ))
    observers.append(
      (
        workspace,
        workspace.addObserver(
          forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.watcher.check(after: 0.3) }
      ))
    observers.append(
      (
        workspace,
        workspace.addObserver(
          forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil,
          queue: .main
        ) { [weak self] _ in
          self?.model.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        }
      ))

    // Moving the pointer needs no permission to be seen; keys are only read while the island
    // holds the keyboard, through the local monitor.
    let moves: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged]
    if let m = NSEvent.addGlobalMonitorForEvents(
      matching: moves,
      handler: { [weak self] _ in
        self?.pointerMoved()
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addLocalMonitorForEvents(
      matching: moves,
      handler: { [weak self] event in
        self?.pointerMoved()
        return event
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addGlobalMonitorForEvents(
      matching: [.leftMouseDown, .rightMouseDown],
      handler: { [weak self] event in
        guard let self else { return }
        if self.model.mode == .open {
          self.model.collapse()
        } else if self.model.mode == .rest || self.model.inNotch, self.inside,
          event.type == .leftMouseDown
        {
          // The island in the notch lets clicks through, so a click on the notch comes here.
          self.model.expand(byClick: true)
        }
      })
    {
      monitors.append(m)
    }
    if let m = NSEvent.addLocalMonitorForEvents(
      matching: .keyDown,
      handler: { [weak self] event in
        guard let self, self.panel.isKeyWindow else { return event }
        return self.key(event) ? nil : event
      })
    {
      monitors.append(m)
    }
  }

  // MARK: Pointer and keys

  private func islandRect() -> NSRect {
    let size = model.frameSize()
    return NSRect(
      x: top.x + model.offsetX() - size.width / 2, y: top.y - size.height, width: size.width,
      height: size.height)
  }

  /// The notch, or on a screen without one nothing.
  private func notchRect() -> NSRect {
    let g = model.geometry
    guard g.hasNotch else { return .zero }
    return NSRect(
      x: top.x - g.notchWidth / 2, y: top.y - g.notchHeight, width: g.notchWidth,
      height: g.notchHeight)
  }

  /// Huli: whether the pointer is on what the island answers to. Beside the notch the island never
  /// takes the menu bar's pointer: the notch alone opens it, and the open panel and a grown
  /// island's body under the menu bar catch it as before.
  private func answers(_ point: NSPoint) -> Bool {
    let near = { (rect: NSRect) in !rect.isEmpty && rect.insetBy(dx: -1, dy: -1).contains(point) }
    switch model.mode {
    case .hidden:
      return false
    case .rest, .collapsed:
      return near(notchRect())
    case .grown:
      var body = islandRect()
      body.size.height -= model.geometry.notchHeight
      return near(notchRect()) || near(body)
    case .open:
      return near(islandRect())
    }
  }

  private func pointerMoved() {
    let point = NSEvent.mouseLocation
    let time = ProcessInfo.processInfo.systemUptime
    if let last = lastPoint, time > lastMove {
      let now = hypot(point.x - last.x, point.y - last.y) / ((time - lastMove) * 1000)
      speed = 0.6 * now + 0.4 * speed
    }
    lastPoint = point
    lastMove = time
    let over = answers(point)
    // At rest or kept in the notch, the island lets clicks through and hears them globally.
    let catches = over && model.mode != .rest && !model.inNotch
    if panel.ignoresMouseEvents == catches { panel.ignoresMouseEvents = !catches }
    model.pointerInside = over
    // The menu bar is measured again as the pointer comes into it, so an item that appeared under
    // a wing since comes out before the user reaches it, and as it leaves a menu bar that hides.
    let bar =
      point.y >= top.y - model.geometry.notchHeight && point.y <= top.y
      && area.map { point.x >= $0.band.minX && point.x <= $0.band.maxX } ?? false
    if bar != inBar {
      inBar = bar
      if model.mode == .collapsed || model.mode == .grown { watcher.pointerCrossed() }
    }
    guard over != inside else { return }
    inside = over
    if over { entered() } else { left() }
  }

  /// The pointer rests on the island for 120 ms and moves slower than 1.2 pt per ms before it
  /// opens, so passing over it on the way to the menu bar opens nothing.
  private static let dwell: TimeInterval = 0.12
  private static let slow = 1.2
  /// How long the pointer may be off an island it opened before it closes.
  private static let grace: TimeInterval = 0.4

  private func entered() {
    leaveTimer?.invalidate()
    guard [.rest, .collapsed, .grown].contains(model.mode) else { return }
    model.holdPop(paused: true)
    // Laid out now, so the island opens straight to the panel's height.
    model.prepare()
    armHover(after: Self.dwell)
  }

  private func armHover(after seconds: TimeInterval) {
    hoverTimer?.invalidate()
    hoverTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) {
      [weak self] _ in
      guard let self, self.inside else { return }
      let still = ProcessInfo.processInfo.systemUptime - self.lastMove > 0.05
      if still || self.speed < Self.slow {
        self.model.expand(byClick: false)
      } else {
        self.armHover(after: 0.04)
      }
    }
  }

  private func left() {
    hoverTimer?.invalidate()
    if model.mode == .grown { model.holdPop() }
    if model.mode == .collapsed || model.mode == .rest { model.measuring = false }
    // An island a request opened stays until it is answered or dismissed with a click elsewhere.
    if model.mode == .open && model.opener == .hover {
      leaveTimer = Timer.scheduledTimer(withTimeInterval: Self.grace, repeats: false) {
        [weak self] _ in self?.model.collapse()
      }
    }
  }

  /// The keys of an island opened by a click: Esc closes it, the arrows move through the rows,
  /// Return opens one, and a digit answers the request on top with that option.
  private func key(_ event: NSEvent) -> Bool {
    switch event.keyCode {
    case 53:
      model.collapse()
      return true
    case 125:
      model.moveSelection(1)
      return true
    case 126:
      model.moveSelection(-1)
      return true
    case 36, 76:
      if let row = model.selected {
        model.open(row: row)
        return true
      }
      if let request = model.requests.first {
        model.open(request: request)
        return true
      }
      return false
    default:
      guard !event.modifierFlags.contains(.command),
        let digit = event.charactersIgnoringModifiers.flatMap(Int.init), (1...9).contains(digit),
        let request = model.requests.first, digit <= request.options.count
      else { return false }
      model.answer(request, option: request.options[digit - 1])
      return true
    }
  }

  // MARK: Showing

  private func modeChanged(_ mode: Mode) {
    // The words come with main's hello, after the window was made.
    panel.setAccessibilityLabel(model.text("label"))
    hideWork?.cancel()
    if mode == .hidden {
      // Out of the window list once the island has shrunk away, so nothing is drawn or composed.
      let work = DispatchWorkItem { [weak self] in
        guard let self, self.model.mode == .hidden else { return }
        self.panel.orderOut(nil)
      }
      hideWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    } else if !panel.isVisible {
      place()
      panel.orderFrontRegardless()
    }
    // Huli: about to take room beside the notch, so the room is measured again.
    if mode == .collapsed || mode == .grown { watcher.check() }
    if mode == .open && model.openedByClick {
      panel.keyable = true
      panel.makeKey()
    } else if mode != .open {
      panel.keyable = false
      if panel.isKeyWindow { panel.resignKey() }
    }
    pointerMoved()
  }

  private func announce(_ text: String) {
    guard !text.isEmpty else { return }
    NSAccessibility.post(
      element: panel, notification: .announcementRequested,
      userInfo: [
        .announcement: text,
        .priority: NSAccessibilityPriorityLevel.high.rawValue,
      ])
  }
}
