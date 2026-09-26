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
default:
    Json.fail("unsupported-action")
}
