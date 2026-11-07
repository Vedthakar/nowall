// nowall setup window: the first-run flow, opened by `nowall setup` (`NowallNotch --setup`).
// Nothing changes on the computer until "Turn on" runs `nowall setup --apply`.
// Exit codes: 0 finished, 3 closed before anything was turned on.

import AppKit
import SwiftUI

func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

/// The script behind every Terminal button. Terminal starts a clean, non-interactive shell, which
/// skips `.zshrc`, so anything nvm puts on PATH (nowall itself, usually) isn't there. So `nowall`
/// is the exact CLI this app was started with, and PATH gets node's folder, for what's installed
/// beside it, then `shellPath`, the PATH setup saved from the person's own shell. The window waits
/// for a key, or a failure scrolls past unread.
func terminalScript(_ command: String, node: String?, cli: String?, home: String, shellPath: String?) -> String {
    var lines = ["#!/bin/zsh -l", "rm -f \"$0\"", "export NOWALL_HOME=\(shellQuote(home))"]
    if let shellPath, !shellPath.isEmpty { lines.append("export PATH=\(shellQuote(shellPath)):\"$PATH\"") }
    if let node {
        lines.append("export PATH=\(shellQuote((node as NSString).deletingLastPathComponent)):\"$PATH\"")
        if let cli { lines.append("nowall() { \(shellQuote(node)) \(shellQuote(cli)) \"$@\"; }") }
    }
    lines += [
        command,
        "code=$?",
        "echo",
        "[ $code -eq 0 ] || echo \"That didn't finish (exit $code).\"",
        "read -k1 \"?Press any key to close this window.\"",
        "exit $code",
    ]
    return lines.joined(separator: "\n") + "\n"
}

/// Runs a command in a new Terminal window. A `.command` file needs no Automation permission.
func runInTerminal(_ command: String, store: Store) {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("nowall-\(UUID().uuidString).command")
    let script = terminalScript(command, node: store.node, cli: store.cli, home: store.home.path, shellPath: store.shellPath)
    do {
        try script.write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        NSWorkspace.shared.open(url)
    } catch {
        fputs("setup: could not open Terminal: \(error)\n", stderr)
    }
}

/// The command that signs an agent in, when it can be typed as is (`loginHint` is written for people).
func loginCommand(_ agent: String) -> String? {
    switch agent {
    case "claude": return "claude auth login"
    case "cursor": return "cursor-agent login"
    case "codex": return "codex login"
    case "antigravity": return "agy"
    default: return nil
    }
}

final class SetupModel: ObservableObject {
    enum Applying: Equatable { case idle, running, failed(String), done }
    @Published var step = 0
    @Published var applying: Applying = .idle
    @Published var checking = false
    @Published var yolo: Bool
    let store: Store

    init(store: Store, yolo: Bool) {
        self.store = store
        self.yolo = yolo
    }

    private func cli(_ args: [String], done: @escaping (Int32, String) -> Void) {
        guard let node = store.node, let path = store.cli else { done(1, ""); return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [path] + args
        var env = ProcessInfo.processInfo.environment
        env["NOWALL_HOME"] = store.home.path
        p.environment = env
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { proc in
            let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async { done(proc.terminationStatus, text) }
        }
        do { try p.run() } catch { done(1, "") }
    }

    /// "Turn on": hooks, config, first look at the agents, and the notch.
    func apply() {
        applying = .running
        cli(["setup", "--apply"] + (yolo ? ["--yolo"] : [])) { [weak self] code, text in
            guard let self else { return }
            let last = text.split(separator: "\n").last.map(String.init) ?? ""
            let j = (try? JSONSerialization.jsonObject(with: Data(last.utf8))) as? [String: Any]
            if code == 0, j?["ok"] as? Bool == true {
                self.applying = .done
                self.store.tick()
                self.step = 1
            } else {
                self.applying = .failed(j?["error"] as? String ?? "nowall couldn't finish setting up (exit \(code)).")
            }
        }
    }

    /// Asks every agent again, ignoring the cached answers: you may have just signed in.
    func recheck() {
        guard !checking else { return }
        checking = true
        cli(["agents", "--write", "--fresh"]) { [weak self] _, _ in
            self?.checking = false
            self?.store.tick()
        }
    }

    /// Claude Code in the terminal, once its CLI is here. The desktop app alone can't do these steps.
    var terminalClaude: AgentInfo? {
        store.agents.first { $0.id == "claude" && $0.installed && $0.desktopOnly != true }
    }

    var readyCount: Int {
        store.allSlots.filter { s in
            s.signedIn != .no && (store.agents.first { $0.id == s.agent }?.installed ?? false) && !s.desktopOnly
        }.count
    }
}

/// Dark, in the notch's own look, however the system is set.
struct SetupRoot: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var store: Store
    static let titles = ["Welcome", "Agents", "Priority", "Hotkey", "Ready"]

    init(model: SetupModel) {
        self.model = model
        store = model.store
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(SetupRoot.titles.indices, id: \.self) { i in
                    HStack(spacing: 5) {
                        Circle().fill(i <= model.step ? brand("claude").color : Color.white.opacity(0.18)).frame(width: 7, height: 7)
                        Text(SetupRoot.titles[i]).font(.system(size: 11, weight: i == model.step ? .semibold : .regular))
                            .foregroundColor(.white.opacity(i == model.step ? 0.95 : 0.4)).fixedSize()
                    }
                    if i < SetupRoot.titles.count - 1 {
                        Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1).frame(maxWidth: .infinity)
                    }
                }
            }
            .padding(.horizontal, 26).padding(.top, 34).padding(.bottom, 18)

            Group {
                switch model.step {
                case 0: WelcomeStep(model: model)
                case 1: AgentsStep(model: model, store: store)
                case 2: PriorityStep(model: model, store: store)
                case 3: HotkeyStep(model: model, store: store)
                default: ReadyStep(model: model, store: store)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(.horizontal, 26)
            .id(model.step)
            .transition(.opacity)
        }
        .animation(.easeInOut(duration: 0.18), value: model.step)
        .frame(width: 620, height: 680)
        .background(Color(white: 0.07))
        .preferredColorScheme(.dark)
    }
}

struct StepFooter: View {
    var note: String? = nil
    var back: (() -> Void)? = nil
    let nextTitle: String
    var nextDisabled = false
    let next: () -> Void
    var body: some View {
        HStack(spacing: 10) {
            if let back { Button("Back", action: back).controlSize(.large) }
            if let note {
                Text(note).font(.system(size: 11)).foregroundColor(.white.opacity(0.55)).fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(nextTitle, action: next).controlSize(.large).keyboardShortcut(.defaultAction).disabled(nextDisabled)
        }
        .padding(.vertical, 20)
    }
}

struct StepTitle: View {
    let title: String
    let text: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 22, weight: .bold, design: .rounded)).foregroundColor(.white)
            Text(text).font(.system(size: 12.5)).foregroundColor(.white.opacity(0.62)).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 14)
    }
}

struct WelcomeStep: View {
    @ObservedObject var model: SetupModel

    func line(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 14, weight: .semibold)).foregroundColor(brand("claude").color).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundColor(.white)
                Text(text).font(.system(size: 11.5)).foregroundColor(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(title: "Your work keeps going.", text: "When a coding agent hits its usage limit, nowall saves your work and continues the task in the next agent you're signed in to.")
            VStack(alignment: .leading, spacing: 13) {
                line("link", "Adds small hooks to your agents", "In Claude Code, and in Cursor and Codex if you have them. They notice limits and keep a tiny journal of each task.")
                line("folder", "Covers every git repo you work in", "Each repo gets a git-ignored .handoff/ folder and hidden snapshots. Your branches, index and files aren't touched.")
                line("arrow.triangle.swap", "Takes over quietly", "No pop-ups. Progress shows in the notch, and nowall undo restores any step.")
                line("sidebar.right", "Puts a notch on the right edge of your screen", "One bubble per chat. Click a bubble to open that chat.")
                line("lock.shield", "Stays on this computer", "No account, server or telemetry. nowall never reads your agent logins.")
            }
            Spacer(minLength: 8)
            if case let .failed(message) = model.applying {
                Text(message).font(.system(size: 11.5)).foregroundColor(.orange).fixedSize(horizontal: false, vertical: true)
            }
            StepFooter(note: "Remove it all any time: nowall uninstall --global",
                       nextTitle: model.applying == .running ? "Turning on…" : "Turn on",
                       nextDisabled: model.applying == .running) { model.apply() }
        }
    }
}

struct AgentsStep: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var store: Store

    func state(_ a: AgentInfo) -> (String, Color) {
        if !a.installed { return ("Not installed", .white.opacity(0.45)) }
        if a.desktopOnly == true { return ("Desktop app. Install the terminal version to take over tasks", .white.opacity(0.6)) }
        if a.signedIn == .no, a.desktopApp == true { return ("Desktop app ready. Sign in to the terminal version so it can take over tasks", .orange) }
        if a.signedIn == .no { return ("Not signed in", .orange) }
        return (a.signedIn == .yes ? "Ready" : "Found", .green)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(title: "Your agents", text: "A takeover needs a second agent that's installed and signed in. nowall never handles the login itself: these buttons open the agent's own sign-in.")
            VStack(spacing: 0) {
                let list = store.agents.filter { $0.id != "qwen" || $0.installed }
                ForEach(Array(list.enumerated()), id: \.element.id) { i, a in
                    let (text, color) = state(a)
                    HStack(spacing: 12) {
                        ZStack {
                            Circle().stroke(brand(a.id).color.opacity(a.installed ? 0.7 : 0.25), lineWidth: 1.8)
                            Image(systemName: brand(a.id).symbol).font(.system(size: 13, weight: .semibold))
                                .foregroundColor(brand(a.id).color.opacity(a.installed ? 1 : 0.4))
                        }
                        .frame(width: 32, height: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(a.name).font(.system(size: 13, weight: .semibold)).foregroundColor(.white)
                            Text(text).font(.system(size: 11)).foregroundColor(color).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        if a.desktopOnly == true, let hint = a.installHint, !hint.isEmpty {
                            Button("Install") { runInTerminal(hint, store: store) }
                        } else if a.installed, a.signedIn == .no, a.id != "claude", let cmd = loginCommand(a.id) {
                            Button("Sign in") { runInTerminal(cmd, store: store) }
                        } else if !a.installed, let hint = a.installHint, !hint.isEmpty {
                            Button("Install") { runInTerminal(hint, store: store) }
                        }
                    }
                    .padding(.vertical, 10).padding(.horizontal, 14)
                    if i < list.count - 1 { Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1).padding(.leading, 58) }
                }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
            HStack {
                Button(model.checking ? "Checking…" : "Check again") { model.recheck() }.disabled(model.checking)
                Spacer()
            }
            .padding(.top, 10)
            if let claude = model.terminalClaude {
                ClaudeTerminalSteps(claude: claude, store: store).padding(.top, 12)
            }
            Spacer(minLength: 8)
            StepFooter(note: model.readyCount < 2 ? "With fewer than two agents ready, nowall watches but has nobody to hand off to. You can sign in later." : nil,
                       nextTitle: "Continue") { model.step = 2 }
        }
        // Back from a login in Terminal: look again.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.recheck() }
    }
}

/// The two things only the person can do in a terminal: sign in, then run one Claude turn.
/// Claude reports usage nowhere else, so its circle stays plain until that turn.
struct ClaudeTerminalSteps: View {
    let claude: AgentInfo
    let store: Store

    var signedIn: Bool { claude.signedIn != .no }
    var reporting: Bool { !(claude.usage ?? []).isEmpty }

    func row(_ number: Int, done: Bool, title: String, text: String, button: String, enabled: Bool, command: String) -> some View {
        HStack(spacing: 10) {
            ZStack {
                Circle().fill(done ? Color.green.opacity(0.85) : Color.white.opacity(0.12))
                if done {
                    Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundColor(.black)
                } else {
                    Text("\(number)").font(.system(size: 10, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.8))
                }
            }
            .frame(width: 18, height: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                Text(text).font(.system(size: 10.5)).foregroundColor(.white.opacity(0.58)).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if !done {
                Button(button) { runInTerminal(command, store: store) }.disabled(!enabled)
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Finish Claude Code").font(.system(size: 12, weight: .semibold)).foregroundColor(.white.opacity(0.75))
            row(1, done: signedIn, title: "Sign in to terminal Claude",
                text: "The app has its own login. Claude can't take over a task without this one.",
                button: "Sign in", enabled: true, command: "claude auth login")
            row(2, done: reporting, title: "Send one message in terminal Claude",
                text: "Claude only reports usage there, so its circle stays plain until you do. Then quit with /exit.",
                button: "Open Claude", enabled: signedIn, command: "claude")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
    }
}

/// Adds another login of an agent. The sign-in itself happens on the agent's own website or in
/// Terminal, where nowall never sees it.
struct AddAccountForm: View {
    @ObservedObject var store: Store
    @State private var agent = "cursor"
    @State private var label = ""

    var labelOK: Bool { label.isEmpty || label.range(of: "^[A-Za-z0-9_-]{1,24}$", options: .regularExpression) != nil }

    func add() {
        if agent == "cursor" {
            store.addAccountInBackground(agent: agent, label: label)
        } else {
            runInTerminal("nowall account add \(agent)\(label.isEmpty ? "" : " \(label)")", store: store)
        }
        label = ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Have another subscription?").font(.system(size: 12, weight: .semibold))
            if store.addingAccount {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Waiting for you to sign in on the Cursor website…").font(.system(size: 11.5))
                    Spacer()
                    Button("Cancel") { store.cancelAddAccount() }
                }
                Text("Use the other account. If it signs you straight in to your usual one, log out there first.")
                    .font(.system(size: 10.5)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                HStack(spacing: 8) {
                    Picker("", selection: $agent) {
                        Text("Cursor").tag("cursor")
                        Text("Claude Code").tag("claude")
                        Text("Codex").tag("codex")
                    }
                    .labelsHidden().frame(width: 130)
                    TextField("Label (optional)", text: $label).textFieldStyle(.roundedBorder).frame(width: 130)
                    Button("Add account", action: add).disabled(!labelOK)
                    Spacer()
                }
                if let result = store.addResult {
                    Text(result.text).font(.system(size: 11)).foregroundColor(result.ok ? .green : .orange)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(agent == "cursor" ? "Opens the Cursor website. Sign in with the other account and you're done." : "Opens Terminal to sign in.")
                        .font(.system(size: 10.5)).foregroundColor(.secondary)
                }
            }
        }
    }
}

struct PriorityStep: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var store: Store

    var flow: String { store.allSlots.filter(\.active).map { shortName($0.id) }.joined(separator: " → ") }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(title: "Who takes over first?", text: "When an account hits its limit, the next checked one continues the task. Drag to reorder.")
            ScrollView {
                OrderList(store: store).colorScheme(.dark)
            }
            .frame(height: min(216, CGFloat(max(store.allSlots.count, 1)) * 41 + 8))
            if !flow.isEmpty {
                Text(flow).font(.system(size: 11.5, weight: .medium, design: .rounded)).foregroundColor(.white.opacity(0.7)).padding(.top, 8).lineLimit(1)
            }
            AddAccountForm(store: store).padding(.top, 14)
            Toggle(isOn: Binding(get: { model.yolo }, set: { model.yolo = $0; store.saveYolo($0) })) {
                Text("Give agents that take over full access. They can then run any command on this computer while you're away, so use it only with repos you trust. Off, they can only edit files.")
                    .font(.system(size: 11)).foregroundColor(.white.opacity(0.62)).fixedSize(horizontal: false, vertical: true)
            }
            .toggleStyle(.checkbox).padding(.top, 14)
            Spacer(minLength: 4)
            StepFooter(back: { model.step = 1 }, nextTitle: "Continue") { model.step = 3 }
        }
    }
}

struct HotkeyStep: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(title: "Switch whenever you like", text: "This shortcut hands the session running right now to the next account, without waiting for a limit. It works from any app.")
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 14) {
                    switchRecorder(store: store).opacity(store.hotkeyEnabled ? 1 : 0.5).disabled(!store.hotkeyEnabled)
                    Text("Click the shortcut, then press the keys you want. Esc cancels.")
                        .font(.system(size: 11.5)).foregroundColor(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
                Toggle("Turn the switch hotkey on", isOn: Binding(get: { store.hotkeyEnabled }, set: { store.saveHotkey(enabled: $0) }))
                    .font(.system(size: 12))
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 1)
                HStack(spacing: 14) {
                    cancelRecorder(store: store).opacity(store.cancelHotkeyEnabled ? 1 : 0.5).disabled(!store.cancelHotkeyEnabled)
                    Text("This one cancels a switch that's running. Its edits stay in your files.")
                        .font(.system(size: 11.5)).foregroundColor(.white.opacity(0.6)).fixedSize(horizontal: false, vertical: true)
                }
                Toggle("Turn the cancel hotkey on", isOn: Binding(get: { store.cancelHotkeyEnabled }, set: { store.saveCancelHotkey(enabled: $0) }))
                    .font(.system(size: 12))
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
            Spacer()
            StepFooter(back: { model.step = 2 }, nextTitle: "Continue") { model.step = 4 }
        }
    }
}

struct ReadyStep: View {
    @ObservedObject var model: SetupModel
    @ObservedObject var store: Store

    func legend(_ phase: String, _ text: String) -> some View {
        HStack(spacing: 10) {
            PhaseGlyph(phase: phase, color: brand("claude").color).frame(width: 24, height: 24)
            Text(text).font(.system(size: 12)).foregroundColor(.white.opacity(0.8))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            StepTitle(title: "nowall is on.", text: "Look for the black tab on the right edge of your screen.")
            VStack(alignment: .leading, spacing: 9) {
                legend("working", "An agent is working")
                legend("needs-input", "An agent needs your input")
                legend("your-turn", "Finished. Stays until you've looked")
                legend("handing-off", "Switching to the next account")
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.05)))
            VStack(alignment: .leading, spacing: 7) {
                Label("Click a bubble to open that chat", systemImage: "cursorarrow.click")
                Label("Double-click the notch to open it", systemImage: "cursorarrow.click.2")
                Label("Right-click for Settings", systemImage: "contextualmenu.and.cursorarrow")
            }
            .font(.system(size: 12)).foregroundColor(.white.opacity(0.8)).padding(.top, 14)
            HStack(spacing: 4) {
                Text("nowall is new, and you're welcome to bring up anything you find:")
                    .foregroundColor(.white.opacity(0.6))
                Link("open an issue", destination: URL(string: "https://github.com/Vedthakar/nowall/issues/new")!)
            }
            .font(.system(size: 11.5)).padding(.top, 12)
            Spacer()
            HStack(spacing: 10) {
                Button("Watch a demo") { runInTerminal("nowall demo", store: store) }.controlSize(.large)
                Text("A simulated failover. It uses no real agents.").font(.system(size: 11)).foregroundColor(.white.opacity(0.5))
                Spacer()
                Button("Finish") { SetupDelegate.finish(0) }.controlSize(.large).keyboardShortcut(.defaultAction)
            }
            .padding(.vertical, 20)
        }
    }
}

final class SetupDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var model: SetupModel?
    private static var turnedOn = false

    static func finish(_ code: Int32) { exit(code) }

    func applicationDidFinishLaunching(_ note: Notification) {
        let args = CommandLine.arguments
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        let home = arg("--home") ?? (NSHomeDirectory() as NSString).appendingPathComponent(".config/nowall")
        let store = Store(home: URL(fileURLWithPath: home), node: arg("--node"), cli: arg("--cli"))
        let model = SetupModel(store: store, yolo: args.contains("--yolo"))
        self.model = model

        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 620, height: 680),
                         styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        w.title = "nowall setup"
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = true
        w.appearance = NSAppearance(named: .darkAqua)
        w.backgroundColor = NSColor(white: 0.07, alpha: 1)
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = NSHostingView(rootView: SetupRoot(model: model))
        w.center()
        window = w
        NSApp.applicationIconImage = setupIcon()
        NSApp.mainMenu = setupMenu()
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    /// Closing the window: "nothing changed" until Turn on has run, "you're set" after it.
    func windowWillClose(_ notification: Notification) {
        SetupDelegate.finish(model?.applying == .done ? 0 : 3)
    }

    /// Without an Edit menu, typing and paste don't reach the label field.
    private func setupMenu() -> NSMenu {
        let bar = NSMenu()
        let app = NSMenuItem()
        app.submenu = NSMenu()
        app.submenu?.addItem(withTitle: "Quit nowall setup", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "q")
        bar.addItem(app)
        let edit = NSMenuItem()
        edit.submenu = NSMenu(title: "Edit")
        edit.submenu?.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.submenu?.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.submenu?.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.submenu?.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        bar.addItem(edit)
        return bar
    }

    /// The Dock icon while setup is open: the notch and its three dots.
    private func setupIcon() -> NSImage {
        NSImage(size: NSSize(width: 512, height: 512), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect.insetBy(dx: 40, dy: 40), xRadius: 96, yRadius: 96).fill()
            NSColor(red: 0.85, green: 0.47, blue: 0.34, alpha: 1).setFill()
            for (i, x) in [156.0, 256.0, 356.0].enumerated() {
                let y = 256.0 + (i == 1 ? 26.0 : -8.0)
                NSBezierPath(ovalIn: NSRect(x: x - 36, y: y - 36, width: 72, height: 72)).fill()
            }
            return true
        }
    }
}

/// `--snapshot out.png --setup-step N`: renders one step offscreen, for docs and visual checks.
@MainActor
func snapshotSetup(to path: String, step: Int, home: String) {
    let store = Store(home: URL(fileURLWithPath: home), node: nil, cli: nil, fixedNow: Date())
    let model = SetupModel(store: store, yolo: false)
    model.step = step
    let host = NSHostingView(rootView: SetupRoot(model: model))
    host.appearance = NSAppearance(named: .darkAqua)
    host.frame = NSRect(x: 0, y: 0, width: 620, height: 680)
    host.layoutSubtreeIfNeeded()
    let b = host.bounds
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(b.width) * 2, pixelsHigh: Int(b.height) * 2,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
    rep.size = b.size
    host.cacheDisplay(in: b, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
    do { try png.write(to: URL(fileURLWithPath: path)) } catch { fputs("snapshot: \(error)\n", stderr); exit(1) }
}
