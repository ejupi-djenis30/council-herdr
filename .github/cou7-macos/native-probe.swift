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

let focusTarget: pid_t? = CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "focus" ? Int32(CommandLine.arguments[2]) : nil

func axValue(_ element: AXUIElement, _ name: String) -> (AXError, CFTypeRef?) {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return (result, value)
}

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
    let element = AXUIElementCreateApplication(pid_t(target))
    let (windowsError, raw) = axValue(element, kAXWindowsAttribute)
    let appWindows = (raw as? [AXUIElement]) ?? []
    let allowed: Set<String> = ["Workspace", "Work items", "New work item", "Title", "Acceptance criteria",
        "Acceptance criteria, one criterion per line", "Responsible role", "Save work item", "Delegate",
        "Confirm delegation", "Open delegation", "Read saved handoff", "Back to work item", "Copy session ID"]
    var queue = appWindows
    var labels: [[String: String]] = []
    var roles: [String: Int] = [:]
    var visited = 0
    while !queue.isEmpty && visited < 1200 {
        let current = queue.removeFirst(); visited += 1
        let role = (axValue(current, kAXRoleAttribute).1 as? String) ?? "unknown"
        roles[role, default: 0] += 1
        for name in [kAXTitleAttribute, kAXDescriptionAttribute] {
            if let text = axValue(current, name).1 as? String, allowed.contains(text) {
                labels.append(["attribute":name, "value":text, "role":role])
            }
        }
        if let children = axValue(current, kAXChildrenAttribute).1 as? [AXUIElement] { queue.append(contentsOf:children) }
    }
    emit(["stage":"owned_herdr_AX", "windowError":windowsError.rawValue, "windowCount":appWindows.count,
          "visited":visited, "truncated":!queue.isEmpty, "roles":roles, "allowlistedLabels":labels])
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
        guard observed, let target = focusTarget else { window.close(); exit(0) }
        guard let targetApp = NSRunningApplication(processIdentifier:target) else {
            emit(["stage":"herdr_native_focus", "pass":false, "firstFailure":"target_process_missing"])
            window.close(); exit(0)
        }
        let appElement = AXUIElementCreateApplication(target)
        var rawWindows: CFTypeRef?
        let windowsError = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &rawWindows)
        let targetWindows = (rawWindows as? [AXUIElement]) ?? []
        guard windowsError == .success, targetWindows.count == 1 else {
            emit(["stage":"herdr_native_focus", "pass":false, "firstFailure":"target_AX_window_unavailable_or_nonunique", "axError":windowsError.rawValue, "windowCount":targetWindows.count])
            window.close(); exit(0)
        }
        var owner: pid_t = 0
        let ownerError = AXUIElementGetPid(targetWindows[0], &owner)
        guard ownerError == .success, owner == target else {
            emit(["stage":"herdr_native_focus", "pass":false, "firstFailure":"target_AX_pid_mismatch", "axError":ownerError.rawValue])
            window.close(); exit(0)
        }
        let raise = AXUIElementPerformAction(targetWindows[0], kAXRaiseAction as CFString)
        let activated = targetApp.activate(options:[.activateIgnoringOtherApps])
        DispatchQueue.main.asyncAfter(deadline:.now() + 0.75) {
            let targetFront = NSWorkspace.shared.frontmostApplication?.processIdentifier == target
            let ok = front && targetFront && targetApp.isActive && activated
            emit(["stage":"herdr_native_focus", "pass":ok, "ownWindowWasFrontmost":front,
                  "targetWindowPidMatches":true, "targetFrontmost":targetFront,
                  "targetActive":targetApp.isActive, "activationAccepted":activated, "axRaiseError":raise.rawValue,
                  "actorPosixSession":getsid(0), "targetPosixSession":getsid(target),
                  "targetExecutingCpuType":targetApp.executableArchitecture,
                  "firstFailure":ok ? NSNull() : "target_native_focus_postcondition_absent"])
            window.close(); exit(0)
        }
    }
}
application.run()
