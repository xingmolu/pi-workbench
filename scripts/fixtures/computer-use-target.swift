import AppKit

final class SmokeDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let status = NSTextField(labelWithString: "ready")
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 180, y: 180, width: 500, height: 240),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "PI_CU_SMOKE_TARGET"
        // Keep unrelated titlebar controls out of this input fixture's AX tree.
        for kind: NSWindow.ButtonType in [.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(kind)?.isHidden = true
        }
        let button = NSButton(title: "CU_TEST_BUTTON", target: self, action: #selector(clicked))
        button.frame = NSRect(x: 30, y: 155, width: 210, height: 40)
        let field = NSTextField(frame: NSRect(x: 30, y: 90, width: 400, height: 30))
        field.placeholderString = "CU_TEST_INPUT"
        field.setAccessibilityLabel("CU_TEST_INPUT")
        status.frame = NSRect(x: 30, y: 35, width: 400, height: 25)
        window.contentView?.addSubview(button)
        window.contentView?.addSubview(field)
        window.contentView?.addSubview(status)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func clicked() { status.stringValue = "CU_BUTTON_CLICKED" }
}
let app = NSApplication.shared
let delegate = SmokeDelegate()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
