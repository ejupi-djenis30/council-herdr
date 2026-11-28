import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Darwin

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
       let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let ax = AXIsProcessTrusted()
let post = CGPreflightPostEventAccess()
let listen = CGPreflightListenEventAccess()
let screen = CGPreflightScreenCaptureAccess()
let session = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
let onConsole = session[kCGSessionOnConsoleKey] as? Bool
let loggedIn = session[kCGSessionLoginDoneKey] as? Bool
let locked = session["CGSSessionScreenIsLocked"] as? Bool
var displays: UInt32 = 0
let displayStatus = CGGetOnlineDisplayList(0, nil, &displays)
emit(["stage":"preflight", "axTrusted":ax, "postEvent":post,
      "listenEvent":listen, "screenRecording":screen,
      "posixSession":getsid(0),
      "sessionDictionaryPresent":!session.isEmpty,
      "onConsole":onConsole as Any? ?? NSNull(),
      "loginDone":loggedIn as Any? ?? NSNull(),
      "screenLocked":locked as Any? ?? NSNull(),
      "displayStatus":displayStatus.rawValue, "displayCount":displays])

if CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "inspect",
   let target = Int(CommandLine.arguments[2]) {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
    let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? Int) == target }
    let positive = owned.filter {
        guard let b = $0[kCGWindowBounds as String] as? [String: Any],
              let width = b["Width"] as? Double, let height = b["Height"] as? Double else { return false }
        return width > 100 && height > 100 && (($0[kCGWindowLayer as String] as? Int) == 0)
    }
    let app = NSRunningApplication(processIdentifier: pid_t(target))
    emit(["stage":"desktop_owned_window", "pidExists":app != nil,
          "ownedOnScreenWindows":positive.count, "active":app?.isActive ?? false,
          "executingCpuType":app?.executableArchitecture as Any? ?? NSNull(),
          "screenCaptureClaimed":false])
    exit(0)
}

guard !session.isEmpty, onConsole == true, locked != true, displays > 0 else {
    emit(["stage":"native_input", "pass":false, "firstFailure":"console_session_or_display_unavailable", "eventPosted":false])
    exit(0)
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let window = NSWindow(contentRect:NSRect(x:100, y:100, width:350, height:140),
                      styleMask:[.titled,.closable], backing:.buffered, defer:false)
window.title = "COU7 isolated input probe"
let field = NSTextField(frame:NSRect(x:30,y:55,width:280,height:28))
field.stringValue = ""
window.contentView?.addSubview(field)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(field)
application.activate(ignoringOtherApps:true)
DispatchQueue.main.asyncAfter(deadline:.now() + 0.75) {
    let pid = ProcessInfo.processInfo.processIdentifier
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
    let visible = window.isVisible
    let key = window.isKeyWindow
    guard ax && post && front && visible && key else {
        let reason = !ax ? "accessibility_not_trusted" : !post ? "event_post_not_authorized" : "owned_window_not_focused"
        emit(["stage":"native_input", "pass":false, "firstFailure":reason,
              "eventPosted":false, "ownedWindowVisible":visible, "ownedWindowKey":key,
              "ownProcessFrontmost":front])
        window.close(); exit(0)
    }
    guard let down = CGEvent(keyboardEventSource:nil, virtualKey:0, keyDown:true),
          let up = CGEvent(keyboardEventSource:nil, virtualKey:0, keyDown:false) else {
        emit(["stage":"native_input", "pass":false, "firstFailure":"event_creation_failed", "eventPosted":false])
        window.close(); exit(0)
    }
    down.post(tap:.cghidEventTap)
    up.post(tap:.cghidEventTap)
    DispatchQueue.main.asyncAfter(deadline:.now() + 0.75) {
        let observed = field.stringValue == "a"
        emit(["stage":"native_input", "pass":observed, "firstFailure":observed ? NSNull() : "key_postcondition_absent",
              "eventPosted":true, "ownedWindowVisible":visible, "ownedWindowKey":key, "ownProcessFrontmost":front])
        window.close(); exit(0)
    }
}
application.run()
