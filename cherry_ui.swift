#!/usr/bin/env swift

import Foundation
import AppKit
import ApplicationServices

struct RequestPayload: Decodable {
    let assistant: String
    let topic: String
    let topicButtonTitle: String?
    let content: String
    let dryRun: Bool?
}

enum CherryUIError: Error, CustomStringConvertible {
    case message(String)

    var description: String {
        switch self {
        case .message(let text):
            return text
        }
    }
}

func readPayload() throws -> RequestPayload {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty else {
        throw CherryUIError.message("没有收到输入参数。")
    }
    return try JSONDecoder().decode(RequestPayload.self, from: data)
}

func axAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return result == .success ? (value as AnyObject?) : nil
}

func axString(_ element: AXUIElement, _ name: String) -> String {
    (axAttribute(element, name) as? String) ?? ""
}

func axBool(_ element: AXUIElement, _ name: String) -> Bool? {
    if let number = axAttribute(element, name) as? NSNumber {
        return number.boolValue
    }
    return nil
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    (axAttribute(element, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func sleepSeconds(_ value: TimeInterval) {
    Thread.sleep(forTimeInterval: value)
}

func runOpenCherry() {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", "Cherry Studio"]
    try? process.run()
    process.waitUntilExit()
}

func runningCherryApp() -> NSRunningApplication? {
    NSRunningApplication.runningApplications(withBundleIdentifier: "com.kangfenmao.CherryStudio").first
}

func appElement(_ app: NSRunningApplication) -> AXUIElement {
    AXUIElementCreateApplication(app.processIdentifier)
}

func anyWindow(_ app: NSRunningApplication) -> AXUIElement? {
    let element = appElement(app)
    if let windows = axAttribute(element, kAXWindowsAttribute as String) as? [AXUIElement], let first = windows.first {
        return first
    }
    return nil
}

func waitForFocusedWindow(_ app: NSRunningApplication, timeout: TimeInterval = 8) -> AXUIElement? {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        let element = appElement(app)
        if let window = axAttribute(element, kAXFocusedWindowAttribute as String) {
            return (window as! AXUIElement)
        }
        if let window = anyWindow(app) {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
            sleepSeconds(0.3)
            if let focused = axAttribute(element, kAXFocusedWindowAttribute as String) {
                return (focused as! AXUIElement)
            }
            return window
        }
        sleepSeconds(0.15)
    }
    return nil
}

func ensureCherryFrontmost() throws -> (NSRunningApplication, AXUIElement, NSRunningApplication?) {
    guard AXIsProcessTrusted() else {
        throw CherryUIError.message("没有辅助功能权限，没法安全驱动 Cherry Studio。请先在系统设置里允许。")
    }
    let previousFrontmost = NSWorkspace.shared.frontmostApplication
    if runningCherryApp() == nil {
        runOpenCherry()
        sleepSeconds(1.5)
    } else {
        runOpenCherry()
    }
    guard let app = runningCherryApp() else {
        throw CherryUIError.message("没有找到正在运行的 Cherry Studio。")
    }
    _ = app.activate(options: [.activateAllWindows])
    sleepSeconds(0.3)
    guard let window = waitForFocusedWindow(app) else {
        throw CherryUIError.message("Cherry Studio 当前没有可用窗口。请先把主窗口打开。")
    }
    return (app, window, previousFrontmost)
}

func restoreFrontmostApp(_ app: NSRunningApplication?) {
    guard let app, app.bundleIdentifier != "com.kangfenmao.CherryStudio" else {
        return
    }
    _ = app.activate()
}

func findWebArea(_ root: AXUIElement) -> AXUIElement? {
    if axString(root, kAXRoleAttribute as String) == "AXWebArea" {
        return root
    }
    for child in axChildren(root) {
        if let found = findWebArea(child) {
            return found
        }
    }
    return nil
}

func collectElements(_ root: AXUIElement, into store: inout [AXUIElement]) {
    store.append(root)
    for child in axChildren(root) {
        collectElements(child, into: &store)
    }
}

func allElements(in root: AXUIElement) -> [AXUIElement] {
    var store: [AXUIElement] = []
    collectElements(root, into: &store)
    return store
}

func buttonTitle(_ element: AXUIElement) -> String {
    axString(element, kAXTitleAttribute as String).trimmingCharacters(in: .whitespacesAndNewlines)
}

func role(_ element: AXUIElement) -> String {
    axString(element, kAXRoleAttribute as String)
}

func buttonCandidates(in root: AXUIElement) -> [AXUIElement] {
    allElements(in: root).filter { role($0) == kAXButtonRole as String && !buttonTitle($0).isEmpty }
}

func matchingButtons(
    in root: AXUIElement,
    exactTitle: String? = nil,
    prefixTitle: String? = nil
) -> [AXUIElement] {
    var exactMatches: [AXUIElement] = []
    var prefixMatches: [AXUIElement] = []
    for button in buttonCandidates(in: root) {
        let title = buttonTitle(button)
        if let exactTitle, !exactTitle.isEmpty, title == exactTitle {
            exactMatches.append(button)
            continue
        }
        if let prefixTitle, !prefixTitle.isEmpty, title.hasPrefix(prefixTitle) {
            prefixMatches.append(button)
        }
    }
    return exactMatches.isEmpty ? prefixMatches : exactMatches
}

func visibleButtonTitles(in root: AXUIElement) -> [String] {
    buttonCandidates(in: root)
        .map(buttonTitle)
        .filter { !$0.isEmpty }
}

func frame(of element: AXUIElement) -> CGRect? {
    guard let raw = axAttribute(element, "AXFrame") else {
        return nil
    }
    let value = raw as! AXValue
    guard AXValueGetType(value) == .cgRect else {
        return nil
    }
    var rect = CGRect.zero
    return AXValueGetValue(value, .cgRect, &rect) ? rect : nil
}

func clickAtCenter(of element: AXUIElement) throws {
    guard let rect = frame(of: element), rect.width > 1, rect.height > 1 else {
        throw CherryUIError.message("控件没有可点击的可见区域。")
    }

    let point = CGPoint(x: rect.midX, y: rect.midY)
    let isOnScreen = NSScreen.screens.contains { $0.frame.insetBy(dx: -12, dy: -12).contains(point) }
    guard isOnScreen else {
        throw CherryUIError.message("目标控件不在可见屏幕区域内。")
    }
    guard let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left),
          let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
          let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else {
        throw CherryUIError.message("构造鼠标点击事件失败。")
    }

    move.post(tap: .cghidEventTap)
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func press(_ element: AXUIElement) throws {
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    if result == .success {
        return
    }
    try clickAtCenter(of: element)
}

func bestTextArea(in root: AXUIElement) -> AXUIElement? {
    let candidates = allElements(in: root).filter {
        role($0) == kAXTextAreaRole as String && (axBool($0, "AXEditable") ?? true)
    }
    return candidates.max {
        let left = frame(of: $0)?.size ?? .zero
        let right = frame(of: $1)?.size ?? .zero
        return left.width * left.height < right.width * right.height
    }
}

func setText(_ element: AXUIElement, value: String) throws {
    _ = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
    if result != .success {
        throw CherryUIError.message("写入输入框失败，错误码：\(result.rawValue)")
    }
    let currentValue = axString(element, kAXValueAttribute as String)
    if currentValue != value {
        throw CherryUIError.message("输入框内容校验失败，Cherry Studio 没有接收到完整文本。")
    }
}

func refreshedWebArea(_ app: NSRunningApplication) throws -> AXUIElement {
    let window: AXUIElement
    if let focused = waitForFocusedWindow(app) {
        window = focused
    } else if let fallback = axAttribute(appElement(app), kAXFocusedWindowAttribute as String) {
        window = fallback as! AXUIElement
    } else {
        throw CherryUIError.message("Cherry Studio 当前没有焦点窗口。")
    }
    guard let webArea = findWebArea(window) else {
        throw CherryUIError.message("没有找到 Cherry Studio 页面区域。")
    }
    return webArea
}

func clickButton(
    app: NSRunningApplication,
    exactTitle: String? = nil,
    prefixTitle: String? = nil,
    waitAfter: TimeInterval = 0.4
) throws {
    let webArea = try refreshedWebArea(app)
    let matches = matchingButtons(in: webArea, exactTitle: exactTitle, prefixTitle: prefixTitle)
    guard let button = matches.first else {
        let titles = visibleButtonTitles(in: webArea).prefix(40).joined(separator: " | ")
        throw CherryUIError.message(
            "没有找到按钮：\(exactTitle ?? prefixTitle ?? "unknown")。当前可见按钮：\(titles)"
        )
    }
    if matches.count > 1 {
        let titles = matches.map(buttonTitle).prefix(8).joined(separator: " | ")
        throw CherryUIError.message("按钮匹配不唯一：\(exactTitle ?? prefixTitle ?? "unknown")。候选：\(titles)")
    }
    try press(button)
    sleepSeconds(waitAfter)
}

func sendMessage(request: RequestPayload) throws {
    let (app, _, previousFrontmost) = try ensureCherryFrontmost()
    defer { restoreFrontmostApp(previousFrontmost) }

    let trimmedContent = request.content.trimmingCharacters(in: .whitespacesAndNewlines)
    if request.dryRun != true && trimmedContent.isEmpty {
        throw CherryUIError.message("发送内容不能为空。")
    }

    try clickButton(app: app, exactTitle: "助手", waitAfter: 0.35)
    try clickButton(app: app, exactTitle: request.assistant, waitAfter: 1.0)
    try clickButton(app: app, exactTitle: "话题", waitAfter: 0.5)

    if let fullTitle = request.topicButtonTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !fullTitle.isEmpty {
        if let webArea = try? refreshedWebArea(app) {
            let exactTopics = matchingButtons(in: webArea, exactTitle: fullTitle)
            if let exactTopic = exactTopics.first {
                if exactTopics.count > 1 {
                    let titles = exactTopics.map(buttonTitle).prefix(8).joined(separator: " | ")
                    throw CherryUIError.message("话题按钮匹配不唯一：\(titles)")
                }
                try press(exactTopic)
                sleepSeconds(0.45)
            } else {
                try clickButton(app: app, prefixTitle: request.topic, waitAfter: 0.45)
            }
        } else {
            try clickButton(app: app, prefixTitle: request.topic, waitAfter: 0.45)
        }
    } else {
        try clickButton(app: app, prefixTitle: request.topic, waitAfter: 0.45)
    }

    if request.dryRun == true {
        return
    }

    let webArea = try refreshedWebArea(app)
    guard let textArea = bestTextArea(in: webArea) else {
        throw CherryUIError.message("没有找到 Cherry Studio 的输入框。")
    }
    try setText(textArea, value: trimmedContent)
    sleepSeconds(0.25)

    let refreshedArea = try refreshedWebArea(app)
    let sendButtons = matchingButtons(in: refreshedArea, exactTitle: "发送", prefixTitle: "发送")
    if let sendButton = sendButtons.first {
        if sendButtons.count > 1 {
            let titles = sendButtons.map(buttonTitle).prefix(8).joined(separator: " | ")
            throw CherryUIError.message("发送按钮匹配不唯一：\(titles)")
        }
        try press(sendButton)
    } else {
        throw CherryUIError.message("没有找到标题为“发送”的按钮。")
    }
    sleepSeconds(0.2)
}

do {
    let request = try readPayload()
    try sendMessage(request: request)
    FileHandle.standardOutput.write(Data("{\"ok\":true}\n".utf8))
} catch let error as CherryUIError {
    FileHandle.standardError.write(Data((error.description + "\n").utf8))
    exit(1)
} catch {
    FileHandle.standardError.write(Data(("\(error)\n").utf8))
    exit(1)
}
