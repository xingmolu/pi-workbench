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

func children(_ element: AXUIElement) -> [AXUIElement] {
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &raw) == .success,
          let array = raw as? [AXUIElement] else { return [] }
    return array
}

func walk(_ element: AXUIElement, depth: Int, count: inout Int, truncated: inout Bool) -> [String: Any]? {
    if count >= 80 || depth > 6 {
        truncated = true
        return nil
    }
    count += 1

    let position = pointAttribute(element, kAXPositionAttribute as CFString)
    let size = sizeAttribute(element, kAXSizeAttribute as CFString)
    var childNodes: [[String: Any]] = []

    if depth < 6 && count < 80 {
        let items = children(element)
        for child in items.prefix(24) {
            if count >= 80 {
                truncated = true
                break
            }
            if let node = walk(child, depth: depth + 1, count: &count, truncated: &truncated) {
                childNodes.append(node)
            }
        }
        if items.count > 24 { truncated = true }
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

func dumpAccessibility() -> [String: Any] {
    guard AXIsProcessTrusted() else {
        return ["ok": false, "error": "accessibility-not-trusted"]
    }
    guard let application = NSWorkspace.shared.frontmostApplication else {
        return ["ok": false, "error": "no-frontmost"]
    }

    let appElement = AXUIElementCreateApplication(application.processIdentifier)
    var windowsRaw: CFTypeRef?
    var windows: [AXUIElement] = []
    if AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRaw) == .success {
        windows = windowsRaw as? [AXUIElement] ?? []
    }

    var count = 0
    var truncated = false
    var output: [[String: Any]] = []
    for window in windows.prefix(4) {
        if let node = walk(window, depth: 1, count: &count, truncated: &truncated) {
            output.append(node)
        }
    }
    if windows.count > 4 { truncated = true }

    return [
        "ok": true,
        "app": String(application.localizedName?.prefix(80) ?? ""),
        "bundleId": String(application.bundleIdentifier?.prefix(80) ?? ""),
        "windows": output,
        "nodeCount": count,
        "truncated": truncated
    ]
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

func clickPointer(x: Double, y: Double, right: Bool) {
    let button: CGMouseButton = right ? .right : .left
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    movePointer(x: x, y: y)
    mouseEvent(down, x: x, y: y, button: button)
    mouseEvent(up, x: x, y: y, button: button)
}

func typeText(_ text: String) {
    let units = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else {
        Json.fail("cannot-create-keyboard-event")
    }
    units.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
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
case "move":
    guard AXIsProcessTrusted(), let x = command.x, let y = command.y else {
        Json.fail("accessibility-not-trusted")
    }
    movePointer(x: x, y: y)
    Json.write(["ok": true, "x": x, "y": y])
case "click":
    guard AXIsProcessTrusted(), let x = command.x, let y = command.y else {
        Json.fail("accessibility-not-trusted")
    }
    clickPointer(x: x, y: y, right: command.button == "right")
    Json.write(["ok": true, "x": x, "y": y])
case "type":
    guard AXIsProcessTrusted(), let text = command.text else {
        Json.fail("accessibility-not-trusted")
    }
    typeText(text)
    Json.write(["ok": true])
default:
    Json.fail("unsupported-action")
}
