import Foundation
import AppKit
import ApplicationServices

struct Command: Decodable {
    let action: String
    let x: Double?
    let y: Double?
    let button: String?
    let text: String?
    let prompt: Bool?
    let app: String?
    let key: String?
    let modifiers: [String]?
    let toX: Double?
    let toY: Double?
    let deltaX: Double?
    let deltaY: Double?
    let value: String?
    let name: String?
    let window: String?
    let expectedTarget: ExpectedTarget?
    let expiresAt: Double?
}

struct ExpectedTarget: Decodable {
    let pid: Int32
    let windowId: UInt32
    let bundleId: String
    let frame: ExpectedFrame
}

struct ExpectedFrame: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Json {
    static func write(_ object: Any) -> Never {
        let data = try! JSONSerialization.data(withJSONObject: object, options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
        exit(0)
    }

    static func fail(_ message: String) -> Never {
        let data = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": message], options: [])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
        exit(1)
    }
}

func stringAttribute(_ element: AXUIElement, _ attribute: CFString, max: Int = 80) -> String {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success, let raw else { return "" }
    let value = String(describing: raw)
    return String(value.prefix(max))
}

func pointAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let raw,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(value) == .cgPoint else { return nil }
    var point = CGPoint.zero
    guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
    return point
}

func sizeAttribute(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success,
          let raw,
          CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    guard AXValueGetType(value) == .cgSize else { return nil }
    var size = CGSize.zero
    guard AXValueGetValue(value, .cgSize, &size) else { return nil }
    return size
}

let maxAXDepth = 24
let maxAXNodes = 160
let maxAXChildren = 24

func children(_ element: AXUIElement) -> [AXUIElement] {
    var raw: CFArray?
    // Fetch one extra child to detect truncation without materializing the whole tree.
    guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0,
                                        maxAXChildren + 1, &raw) == .success,
          let array = raw as? [AXUIElement] else { return [] }
    return array
}

func walk(_ element: AXUIElement, depth: Int, deadline: TimeInterval, count: inout Int, truncated: inout Bool) -> [String: Any]? {
    if count >= maxAXNodes || depth > maxAXDepth || ProcessInfo.processInfo.systemUptime >= deadline {
        truncated = true
        return nil
    }
    AXUIElementSetMessagingTimeout(element, 0.1)
    count += 1

    let position = pointAttribute(element, kAXPositionAttribute as CFString)
    let size = sizeAttribute(element, kAXSizeAttribute as CFString)
    var childNodes: [[String: Any]] = []

    let items = children(element)
    if depth < maxAXDepth && count < maxAXNodes {
        for child in items.prefix(maxAXChildren) {
            if count >= maxAXNodes {
                truncated = true
                break
            }
            if let node = walk(child, depth: depth + 1, deadline: deadline, count: &count, truncated: &truncated) {
                childNodes.append(node)
            }
        }
        if items.count > maxAXChildren { truncated = true }
    } else if !items.isEmpty {
        truncated = true
    }

    return [
        "role": stringAttribute(element, kAXRoleAttribute as CFString),
        "title": stringAttribute(element, kAXTitleAttribute as CFString),
        "value": stringAttribute(element, kAXValueAttribute as CFString),
        "description": stringAttribute(element, kAXDescriptionAttribute as CFString),
        "x": position?.x ?? NSNull(),
        "y": position?.y ?? NSNull(),
        "width": size?.width ?? NSNull(),
        "height": size?.height ?? NSNull(),
        "children": childNodes
    ]
}

func accessibilityTrusted(prompt: Bool) -> Bool {
    if !prompt {
        return AXIsProcessTrusted()
    }
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    let options = [key: true] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func isSessionLocked() -> Bool {
    guard let dictionary = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    return (dictionary["CGSSessionScreenIsLocked"] as? Bool) == true
}

struct VisibleWindow {
    let id: CGWindowID
    let frame: CGRect
}

func visibleWindows(pid: pid_t) -> [VisibleWindow] {
    guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] else { return [] }
    return raw.compactMap { item in
        guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let number = item[kCGWindowNumber as String] as? NSNumber,
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? NSNumber,
              let y = bounds["Y"] as? NSNumber,
              let width = bounds["Width"] as? NSNumber,
              let height = bounds["Height"] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0 else { return nil }
        return VisibleWindow(
            id: CGWindowID(number.uint32Value),
            frame: CGRect(x: x.doubleValue, y: y.doubleValue,
                          width: width.doubleValue, height: height.doubleValue)
        )
    }
}

func axWindowFrame(_ window: AXUIElement) -> CGRect? {
    guard let point = pointAttribute(window, kAXPositionAttribute as CFString),
          let size = sizeAttribute(window, kAXSizeAttribute as CFString),
          size.width > 0, size.height > 0 else { return nil }
    return CGRect(origin: point, size: size)
}

func sameWindowFrame(_ left: CGRect, _ right: CGRect) -> Bool {
    let tolerance: CGFloat = 4
    return abs(left.minX - right.minX) <= tolerance &&
           abs(left.minY - right.minY) <= tolerance &&
           abs(left.width - right.width) <= tolerance &&
           abs(left.height - right.height) <= tolerance
}

func windowIdentity(_ application: NSRunningApplication, _ window: VisibleWindow) -> [String: Any] {
    return [
        "pid": Int(application.processIdentifier),
        "windowId": Int(window.id),
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? ""),
        "frame": [
            "x": Double(window.frame.minX),
            "y": Double(window.frame.minY),
            "width": Double(window.frame.width),
            "height": Double(window.frame.height)
        ]
    ]
}

func foregroundWindow() -> [String: Any] {
    guard !isSessionLocked(), let application = NSWorkspace.shared.frontmostApplication else {
        return ["ok": false, "error": "no-foreground-window"]
    }
    let candidates = visibleWindows(pid: application.processIdentifier)
    guard !candidates.isEmpty else {
        return ["ok": false, "error": "no-foreground-window"]
    }
    var matches = candidates
    if AXIsProcessTrusted() {
        let appElement = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(appElement, 0.2)
        var focusedRaw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
              let focusedRaw, CFGetTypeID(focusedRaw) == AXUIElementGetTypeID(),
              let frame = axWindowFrame(unsafeBitCast(focusedRaw, to: AXUIElement.self)) else {
            return ["ok": false, "error": "no-focused-window"]
        }
        matches = candidates.filter { sameWindowFrame($0.frame, frame) }
    }
    guard matches.count == 1, let window = matches.first else {
        return ["ok": false, "error": "ambiguous-foreground-window"]
    }
    return ["ok": true, "target": windowIdentity(application, window)]
}

func verifyExpectedTarget(_ expected: ExpectedTarget?) {
    guard let expected else { return }
    let current = foregroundWindow()
    guard current["ok"] as? Bool == true,
          let target = current["target"] as? [String: Any],
          let frame = target["frame"] as? [String: Any],
          (target["pid"] as? Int) == Int(expected.pid),
          (target["windowId"] as? Int) == Int(expected.windowId),
          (target["bundleId"] as? String) == expected.bundleId,
          let x = frame["x"] as? Double, let y = frame["y"] as? Double,
          let width = frame["width"] as? Double, let height = frame["height"] as? Double,
          sameWindowFrame(CGRect(x: x, y: y, width: width, height: height),
                          CGRect(x: expected.frame.x, y: expected.frame.y,
                                 width: expected.frame.width, height: expected.frame.height)) else {
        Json.fail("target-changed")
    }
}

func verifyUncoveredPoint(x: Double, y: Double, expected: ExpectedTarget?) {
    guard let expected else { return }
    let point = CGPoint(x: x, y: y)
    guard CGRect(x: expected.frame.x, y: expected.frame.y,
                 width: expected.frame.width, height: expected.frame.height).contains(point),
          let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                    kCGNullWindowID) as? [[String: Any]] else {
        Json.fail("target-occluded")
    }
    for item in windows {
        guard let layer = item[kCGWindowLayer as String] as? NSNumber,
              let owner = item[kCGWindowOwnerPID as String] as? NSNumber,
              (layer.intValue == 0 || owner.int32Value == expected.pid),
              let alpha = item[kCGWindowAlpha as String] as? NSNumber,
              alpha.doubleValue > 0,
              let id = item[kCGWindowNumber as String] as? NSNumber,
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let x = bounds["X"] as? NSNumber,
              let y = bounds["Y"] as? NSNumber,
              let width = bounds["Width"] as? NSNumber,
              let height = bounds["Height"] as? NSNumber else { continue }
        if CGRect(x: x.doubleValue, y: y.doubleValue,
                  width: width.doubleValue, height: height.doubleValue).contains(point) {
            guard id.uint32Value == expected.windowId else { Json.fail("target-occluded") }
            return
        }
    }
    Json.fail("target-occluded")
}

func verifyExpiry(_ expiresAt: Double?) {
    if let expiresAt, Date().timeIntervalSince1970 * 1000 > expiresAt {
        Json.fail("visual-state-expired")
    }
}

func dumpAccessibility() -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return ["ok": false, "error": "accessibility-not-trusted"]
    }
    guard let application = NSWorkspace.shared.frontmostApplication else {
        return ["ok": false, "error": "no-frontmost"]
    }

    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    AXUIElementSetMessagingTimeout(appElement, 0.2)
    var windowsRaw: CFTypeRef?
    var windows: [AXUIElement] = []
    if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success {
        windows = windowsRaw as? [AXUIElement] ?? []
    }
    var focusedRaw: CFTypeRef?
    var focusedWindow: AXUIElement?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
       let focusedRaw, CFGetTypeID(focusedRaw) == AXUIElementGetTypeID() {
        focusedWindow = unsafeBitCast(focusedRaw, to: AXUIElement.self)
    }
    if let focusedWindow {
        windows.removeAll { CFEqual($0, focusedWindow) }
        windows.insert(focusedWindow, at: 0)
    }

    func snapshot() -> (nodes: [[String: Any]], count: Int, truncated: Bool) {
        var count = 0
        var truncated = windows.count > 4
        var output: [[String: Any]] = []
        let deadline = ProcessInfo.processInfo.systemUptime + 1.5
        for window in windows.prefix(4) {
            if let node = walk(window, depth: 1, deadline: deadline, count: &count, truncated: &truncated) {
                output.append(node)
            }
        }
        return (output, count, truncated)
    }
    func hasWebContent(_ nodes: [[String: Any]]) -> Bool {
        nodes.contains { node in
            node["role"] as? String == "AXWebArea" || hasWebContent(node["children"] as? [[String: Any]] ?? [])
        }
    }
    var tree = snapshot()
    // Electron's supported assistive-technology API. Only activate when its web
    // tree is absent, avoiding re-triggering its two-second activation debounce.
    let manualAX = "AXManualAccessibility" as CFString
    var settable = DarwinBoolean(false)
    if !hasWebContent(tree.nodes),
       AXUIElementIsAttributeSettable(appElement, manualAX, &settable) == .success,
       settable.boolValue,
       AXUIElementSetAttributeValue(appElement, manualAX, true as CFTypeRef) == .success {
        Thread.sleep(forTimeInterval: 2.1)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
            return ["ok": false, "error": "foreground-changed-during-accessibility-activation"]
        }
        tree = snapshot()
    }

    var target: [String: Any]?
    if let focusedWindow, let frame = axWindowFrame(focusedWindow) {
        let matches = visibleWindows(pid: application.processIdentifier)
            .filter { sameWindowFrame($0.frame, frame) }
        if matches.count == 1,
           let first = tree.nodes.first,
           let x = first["x"] as? NSNumber, let y = first["y"] as? NSNumber,
           let width = first["width"] as? NSNumber, let height = first["height"] as? NSNumber,
           sameWindowFrame(CGRect(x: x.doubleValue, y: y.doubleValue,
                                  width: width.doubleValue, height: height.doubleValue), frame) {
            tree.nodes[0]["windowId"] = Int(matches[0].id)
            target = windowIdentity(application, matches[0])
        }
    }
    var result: [String: Any] = [
        "ok": true,
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? ""),
        "windows": tree.nodes,
        "nodeCount": tree.count,
        "truncated": tree.truncated
    ]
    if let target { result["target"] = target }
    return result
}

func mouseEvent(_ type: CGEventType, x: Double, y: Double, button: CGMouseButton) {
    let point = CGPoint(x: x, y: y)
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        Json.fail("cannot-create-mouse-event")
    }
    event.post(tap: .cghidEventTap)
}

func movePointer(x: Double, y: Double) {
    mouseEvent(.mouseMoved, x: x, y: y, button: .left)
}

func clickPointer(x: Double, y: Double, right: Bool,
                  expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    let button: CGMouseButton = right ? .right : .left
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: expectedTarget)
    movePointer(x: x, y: y)
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: expectedTarget)
    mouseEvent(down, x: x, y: y, button: button)
    mouseEvent(up, x: x, y: y, button: button)
    // CGEvent.post queues delivery. Immediate one-shot process exit can lose the
    // final events; keep the helper alive briefly (verified by the packaged smoke).
    // This is a delivery grace period, not confirmation of the target's effect.
    Thread.sleep(forTimeInterval: 0.1)
}

func typeText(_ text: String, expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        Json.fail("cannot-create-keyboard-event")
    }
    units.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
    }
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    // Same one-shot delivery grace period as clickPointer.
    Thread.sleep(forTimeInterval: 0.1)
}

func boolAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &raw) == .success else { return false }
    return (raw as? Bool) == true
}

func focusedWindowFrame(_ appElement: AXUIElement) -> CGRect? {
    var focusedRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedRaw) == .success,
          let focusedRaw, CFGetTypeID(focusedRaw) == AXUIElementGetTypeID() else { return nil }
    return axWindowFrame(unsafeBitCast(focusedRaw, to: AXUIElement.self))
}

/// Brings an application (and, when given, its window with this frame) to the front.
/// The AX frontmost attribute works from a background helper where plain activation
/// may be ignored; the wait reads AX state because this process has no event loop
/// to refresh NSWorkspace.frontmostApplication.
func activate(_ application: NSRunningApplication, window frame: CGRect?) -> Bool {
    if application.isHidden { _ = application.unhide() }
    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    AXUIElementSetMessagingTimeout(appElement, 0.3)
    if let frame {
        var windowsRaw: CFTypeRef?
        if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success {
            for window in windowsRaw as? [AXUIElement] ?? [] {
                guard let current = axWindowFrame(window), sameWindowFrame(current, frame) else { continue }
                _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
                _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
                break
            }
        }
    }
    _ = AXUIElementSetAttributeValue(appElement, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    _ = application.activate(options: [.activateIgnoringOtherApps])
    let deadline = Date().addingTimeInterval(1.5)
    repeat {
        if boolAttribute(appElement, kAXFrontmostAttribute as CFString) {
            guard let frame else { return true }
            if let current = focusedWindowFrame(appElement), sameWindowFrame(current, frame) { return true }
        }
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
    } while Date() < deadline
    return false
}

func findApplications(_ query: String) -> [NSRunningApplication] {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return [] }
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && !$0.isTerminated &&
            $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
    }
    let exact = apps.filter {
        $0.bundleIdentifier?.lowercased() == needle || $0.localizedName?.lowercased() == needle
    }
    if !exact.isEmpty { return exact }
    return apps.filter { $0.localizedName?.lowercased().contains(needle) == true }
}

let keyCodes: [String: CGKeyCode] = [
    "Enter": 36, "Escape": 53, "Tab": 48, "Backspace": 51, "Delete": 117, "Space": 49,
    "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    "PageUp": 116, "PageDown": 121, "Home": 115, "End": 119,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
    // ANSI positions; shortcuts name keys by these physical positions.
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "`": 50
]

func modifierFlags(_ names: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in names {
        switch name {
        case "cmd": flags.insert(.maskCommand)
        case "ctrl": flags.insert(.maskControl)
        case "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: Json.fail("invalid-modifier")
        }
    }
    return flags
}

func pressKey(_ code: CGKeyCode, flags: CGEventFlags = [], expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
        Json.fail("cannot-create-keyboard-event")
    }
    down.flags = flags
    up.flags = flags
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    // Same one-shot delivery grace period as clickPointer.
    Thread.sleep(forTimeInterval: 0.1)
}

func scrollAt(x: Double, y: Double, deltaX: Double, deltaY: Double,
              expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: expectedTarget)
    movePointer(x: x, y: y)
    // Line units; positive wheel1 scrolls up and positive wheel2 scrolls left.
    guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                              wheel1: Int32(deltaY), wheel2: Int32(deltaX), wheel3: 0) else {
        Json.fail("cannot-create-scroll-event")
    }
    event.location = CGPoint(x: x, y: y)
    verifyExpectedTarget(expectedTarget)
    event.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.15)
}

func dragPointer(fromX: Double, fromY: Double, toX: Double, toY: Double,
                 expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: fromX, y: fromY, expected: expectedTarget)
    verifyUncoveredPoint(x: toX, y: toY, expected: expectedTarget)
    movePointer(x: fromX, y: fromY)
    mouseEvent(.leftMouseDown, x: fromX, y: fromY, button: .left)
    // Intermediate positions let apps see a drag rather than a jump.
    let steps = 12
    for step in 1...steps {
        let progress = Double(step) / Double(steps)
        mouseEvent(.leftMouseDragged, x: fromX + (toX - fromX) * progress,
                   y: fromY + (toY - fromY) * progress, button: .left)
        Thread.sleep(forTimeInterval: 0.015)
    }
    mouseEvent(.leftMouseUp, x: toX, y: toY, button: .left)
    Thread.sleep(forTimeInterval: 0.1)
}

/// Puts the text on the clipboard, presses Command-V, then puts the user's clipboard back.
func pasteText(_ text: String, expectedTarget: ExpectedTarget?, expiresAt: Double?) {
    let board = NSPasteboard.general
    let saved: [[(NSPasteboard.PasteboardType, Data)]] = (board.pasteboardItems ?? []).map { item in
        item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
    }
    board.clearContents()
    guard board.setString(text, forType: .string) else { Json.fail("cannot-write-clipboard") }
    defer {
        board.clearContents()
        let items: [NSPasteboardItem] = saved.map { pairs in
            let item = NSPasteboardItem()
            for (type, data) in pairs { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { board.writeObjects(items) }
    }
    pressKey(9, flags: .maskCommand, expectedTarget: expectedTarget, expiresAt: expiresAt)
    // The target reads the clipboard while handling Command-V; wait before restoring it.
    Thread.sleep(forTimeInterval: 0.4)
}

/// The accessibility element under a point, which must belong to the target app.
func elementAt(x: Double, y: Double, expected: ExpectedTarget?) -> AXUIElement {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var found: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(x), Float(y), &found) == .success,
          let element = found else { Json.fail("element-missing") }
    if let expected {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid == expected.pid else {
            Json.fail("target-changed")
        }
    }
    return element
}

func setValue(x: Double, y: Double, value: String, expectedTarget: ExpectedTarget?) {
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: expectedTarget)
    let element = elementAt(x: x, y: y, expected: expectedTarget)
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
          settable.boolValue else {
        Json.write(["ok": false, "error": "not-settable"] as [String: Any])
    }
    guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString) == .success else {
        Json.write(["ok": false, "error": "set-value-failed"] as [String: Any])
    }
}

let secondaryActions: [String: String] = [
    "menu": kAXShowMenuAction as String, "increment": kAXIncrementAction as String,
    "decrement": kAXDecrementAction as String, "pick": kAXPickAction as String,
    "confirm": kAXConfirmAction as String, "cancel": kAXCancelAction as String
]

func performSecondary(x: Double, y: Double, name: String, expectedTarget: ExpectedTarget?,
                      expiresAt: Double?) {
    guard let action = secondaryActions[name] else { Json.fail("invalid-action") }
    verifyExpiry(expiresAt)
    verifyExpectedTarget(expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: expectedTarget)
    let element = elementAt(x: x, y: y, expected: expectedTarget)
    var namesRaw: CFArray?
    let names = AXUIElementCopyActionNames(element, &namesRaw) == .success
        ? (namesRaw as? [String] ?? []) : []
    if names.contains(action), AXUIElementPerformAction(element, action as CFString) == .success {
        Thread.sleep(forTimeInterval: 0.1)
        return
    }
    // Most controls without AXShowMenu still open their context menu on a secondary click.
    if name == "menu" {
        clickPointer(x: x, y: y, right: true, expectedTarget: expectedTarget, expiresAt: expiresAt)
        return
    }
    Json.write([
        "ok": false,
        "error": "action-unsupported",
        "available": names.prefix(12).map { String($0.prefix(40)) }
    ] as [String: Any])
}

func listApps() -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && !$0.isTerminated &&
            $0.processIdentifier != ProcessInfo.processInfo.processIdentifier
    }
    return [
        "ok": true,
        "apps": apps.prefix(60).map { app -> [String: Any] in
            [
                "pid": Int(app.processIdentifier),
                "name": String(app.localizedName?.prefix(80) ?? ""),
                "bundleId": String(app.bundleIdentifier?.prefix(80) ?? ""),
                "active": app.isActive,
                "hidden": app.isHidden,
                "windows": visibleWindows(pid: app.processIdentifier).count
            ]
        }
    ]
}

func axWindows(_ application: NSRunningApplication) -> [AXUIElement] {
    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    AXUIElementSetMessagingTimeout(appElement, 0.3)
    var windowsRaw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success else {
        return []
    }
    return windowsRaw as? [AXUIElement] ?? []
}

func singleApplication(_ query: String?) -> NSRunningApplication {
    guard let query else { Json.fail("invalid-app") }
    let matches = findApplications(query)
    guard !matches.isEmpty else { Json.write(["ok": false, "error": "app-not-running"] as [String: Any]) }
    guard matches.count == 1, let application = matches.first else {
        Json.write([
            "ok": false,
            "error": "app-ambiguous",
            "candidates": matches.prefix(8).map { String(($0.localizedName ?? $0.bundleIdentifier ?? "").prefix(80)) }
        ] as [String: Any])
    }
    return application
}

func listWindows(_ application: NSRunningApplication) -> [String: Any] {
    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    AXUIElementSetMessagingTimeout(appElement, 0.3)
    let focused = focusedWindowFrame(appElement)
    let windows = axWindows(application).prefix(20).map { window -> [String: Any] in
        let frame = axWindowFrame(window)
        var entry: [String: Any] = [
            "title": stringAttribute(window, kAXTitleAttribute as CFString, max: 200),
            "minimized": boolAttribute(window, kAXMinimizedAttribute as CFString),
            "focused": frame != nil && focused != nil && sameWindowFrame(frame!, focused!)
        ]
        if let frame {
            entry["frame"] = ["x": Double(frame.minX), "y": Double(frame.minY),
                              "width": Double(frame.width), "height": Double(frame.height)]
        }
        return entry
    }
    return [
        "ok": true,
        "pid": Int(application.processIdentifier),
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? ""),
        "windows": windows
    ]
}

/// Brings one window of the app to the front, chosen by part of its title.
func activateWindow(_ application: NSRunningApplication, title query: String) -> [String: Any] {
    let needle = query.lowercased()
    let matches = axWindows(application).filter {
        stringAttribute($0, kAXTitleAttribute as CFString, max: 200).lowercased().contains(needle)
    }
    guard !matches.isEmpty else { return ["ok": false, "error": "window-not-found"] }
    guard matches.count == 1, let window = matches.first else {
        return [
            "ok": false,
            "error": "window-ambiguous",
            "candidates": matches.prefix(8).map { stringAttribute($0, kAXTitleAttribute as CFString, max: 80) }
        ]
    }
    if boolAttribute(window, kAXMinimizedAttribute as CFString) {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        Thread.sleep(forTimeInterval: 0.3)
    }
    let front = activate(application, window: axWindowFrame(window))
    return [
        "ok": true,
        "front": front,
        "pid": Int(application.processIdentifier),
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? "")
    ]
}

let input: Data
if CommandLine.arguments.count > 1 {
    input = Data(CommandLine.arguments[1].utf8)
} else {
    input = FileHandle.standardInput.readDataToEndOfFile()
}
guard !input.isEmpty else { Json.fail("missing-command") }

let command: Command
do {
    command = try JSONDecoder().decode(Command.self, from: input)
} catch {
    Json.fail("invalid-command")
}

switch command.action {
case "accessibility-permission":
    Json.write([
        "ok": true,
        "trusted": accessibilityTrusted(prompt: command.prompt == true)
    ])
case "session-lock":
    Json.write(["ok": true, "locked": isSessionLocked()])
case "ax-dump":
    Json.write(dumpAccessibility())
case "foreground-window":
    Json.write(foregroundWindow())
case "validate-target":
    guard let expected = command.expectedTarget, let x = command.x, let y = command.y else {
        Json.fail("invalid-target")
    }
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(expected)
    verifyUncoveredPoint(x: x, y: y, expected: expected)
    Json.write(["ok": true])
case "move":
    guard AXIsProcessTrusted(), let x = command.x, let y = command.y else {
        Json.fail("accessibility-not-trusted")
    }
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(command.expectedTarget)
    verifyUncoveredPoint(x: x, y: y, expected: command.expectedTarget)
    movePointer(x: x, y: y)
    Json.write(["ok": true, "x": x, "y": y])
case "click":
    guard AXIsProcessTrusted(), let x = command.x, let y = command.y else {
        Json.fail("accessibility-not-trusted")
    }
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(command.expectedTarget)
    clickPointer(x: x, y: y, right: command.button == "right",
                 expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true, "x": x, "y": y])
case "type":
    guard AXIsProcessTrusted(), let text = command.text else {
        Json.fail("accessibility-not-trusted")
    }
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(command.expectedTarget)
    typeText(text, expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "activate-target":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let expected = command.expectedTarget,
          let application = NSRunningApplication(processIdentifier: expected.pid),
          !application.isTerminated,
          (application.bundleIdentifier ?? "") == expected.bundleId else {
        Json.write(["ok": false, "error": "target-missing"] as [String: Any])
    }
    let frame = CGRect(x: expected.frame.x, y: expected.frame.y,
                       width: expected.frame.width, height: expected.frame.height)
    Json.write(["ok": true, "front": activate(application, window: frame)] as [String: Any])
case "activate-app":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let query = command.app else { Json.fail("invalid-app") }
    let matches = findApplications(query)
    guard !matches.isEmpty else { Json.write(["ok": false, "error": "app-not-running"] as [String: Any]) }
    guard matches.count == 1, let application = matches.first else {
        Json.write([
            "ok": false,
            "error": "app-ambiguous",
            "candidates": matches.prefix(8).map { String(($0.localizedName ?? $0.bundleIdentifier ?? "").prefix(80)) }
        ] as [String: Any])
    }
    let front = activate(application, window: nil)
    Json.write([
        "ok": true,
        "front": front,
        "pid": Int(application.processIdentifier),
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? "")
    ] as [String: Any])
case "key":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let name = command.key, let code = keyCodes[name] else { Json.fail("invalid-key") }
    let flags = modifierFlags(command.modifiers ?? [])
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(command.expectedTarget)
    pressKey(code, flags: flags, expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "scroll":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let x = command.x, let y = command.y else { Json.fail("invalid-target") }
    scrollAt(x: x, y: y, deltaX: command.deltaX ?? 0, deltaY: command.deltaY ?? 0,
             expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "drag":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let x = command.x, let y = command.y, let toX = command.toX, let toY = command.toY else {
        Json.fail("invalid-target")
    }
    dragPointer(fromX: x, fromY: y, toX: toX, toY: toY,
                expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "paste":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let text = command.text else { Json.fail("invalid-text") }
    verifyExpiry(command.expiresAt)
    verifyExpectedTarget(command.expectedTarget)
    pasteText(text, expectedTarget: command.expectedTarget, expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "set-value":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let x = command.x, let y = command.y, let value = command.value else { Json.fail("invalid-target") }
    setValue(x: x, y: y, value: value, expectedTarget: command.expectedTarget)
    Json.write(["ok": true])
case "ax-action":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let x = command.x, let y = command.y, let name = command.name else { Json.fail("invalid-target") }
    performSecondary(x: x, y: y, name: name, expectedTarget: command.expectedTarget,
                     expiresAt: command.expiresAt)
    Json.write(["ok": true])
case "list-apps":
    Json.write(listApps())
case "list-windows":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    Json.write(listWindows(singleApplication(command.app)))
case "activate-window":
    guard AXIsProcessTrusted() else { Json.fail("accessibility-not-trusted") }
    guard let title = command.window else { Json.fail("invalid-window") }
    Json.write(activateWindow(singleApplication(command.app), title: title))
default:
    Json.fail("unsupported-action")
}
