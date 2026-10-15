// nowall notch: a small always-on-top status pill for macOS.
// It only reads nowall's JSON status files (~/.config/nowall); it never runs agents itself.
// Build: scripts/build-notch.sh

import AppKit
import SwiftUI

// MARK: - Data (mirrors src/status.ts and src/agents.ts)

enum SignIn: Decodable {
    case yes, no, unknown
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let b = try? c.decode(Bool.self) { self = b ? .yes : .no } else { self = .unknown }
    }
}

struct UsageWindow: Decodable, Hashable {
    let label: String
    let usedPct: Double
    let resetsAt: String?
}

struct AgentInfo: Decodable, Identifiable {
    let id: String
    let name: String
    let installed: Bool
    let desktopOnly: Bool?
    let signedIn: SignIn
    let enabled: Bool
    let cooldownUntil: String?
    let limitMessage: String?
    let usage: [UsageWindow]?
    let loginHint: String
}

struct AgentsSnapshot: Decodable {
    let agents: [AgentInfo]
}

struct Share: Decodable, Hashable {
    let agent: String
    let lines: Int
}

struct TaskCount: Decodable, Hashable {
    let done: Int
    let total: Int
}

struct SessionStatus: Decodable, Identifiable {
    let sid: String
    let repoName: String
    let phase: String
    let agent: String
    let detail: String?
    let tasks: TaskCount?
    let shares: [Share]?
    let startedAt: String
    let updatedAt: String
    var id: String { sid }
}

private let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func parseDate(_ s: String?) -> Date? {
    guard let s else { return nil }
    return iso.date(from: s) ?? ISO8601DateFormatter().date(from: s)
}

// MARK: - Store

final class Store: ObservableObject {
    @Published var agents: [AgentInfo] = []
    @Published var sessions: [SessionStatus] = []
    @Published var now = Date()

    let home: URL
    let node: String?
    let cli: String?
    private var timer: Timer?
    private var lastRefresh = Date.distantPast

    init(home: URL, node: String?, cli: String?) {
        self.home = home
        self.node = node
        self.cli = cli
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func tick() {
        now = Date()
        let dec = JSONDecoder()
        if let data = try? Data(contentsOf: home.appendingPathComponent("agents.json")),
           let snap = try? dec.decode(AgentsSnapshot.self, from: data) {
            agents = snap.agents.filter { $0.installed && $0.enabled }
        }
        let dir = home.appendingPathComponent("status")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var list: [SessionStatus] = []
        for f in files where f.pathExtension == "json" {
            guard let d = try? Data(contentsOf: f), let s = try? dec.decode(SessionStatus.self, from: d) else { continue }
            let age = now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast)
            let active = ["working", "needs-input", "handing-off"].contains(s.phase)
            // Finished sessions linger briefly so you can see the result, then disappear.
            if active ? age < 6 * 3600 : age < (s.phase == "ended" ? 20 : 15 * 60) { list.append(s) }
        }
        sessions = list.sorted { ($0.updatedAt) > ($1.updatedAt) }
        if now.timeIntervalSince(lastRefresh) > 60 { refreshAgents() }
    }

    /// Asks nowall to re-detect agents and usage (sign-in, cooldowns, Codex/Claude usage windows).
    func refreshAgents() {
        lastRefresh = Date()
        guard let node, let cli else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "agents", "--write"]
        var env = ProcessInfo.processInfo.environment
        env["NOWALL_HOME"] = home.path
        p.environment = env
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    var primary: SessionStatus? { sessions.first }
}

// MARK: - Look

struct Brand {
    let symbol: String
    let color: Color
}

func brand(_ id: String) -> Brand {
    switch id {
    case "claude": return Brand(symbol: "sparkle", color: Color(red: 0.85, green: 0.47, blue: 0.34))
    case "cursor": return Brand(symbol: "cursorarrow.rays", color: Color(white: 0.92))
    case "codex": return Brand(symbol: "chevron.left.forwardslash.chevron.right", color: Color(red: 0.06, green: 0.64, blue: 0.5))
    case "antigravity": return Brand(symbol: "arrow.up.forward.circle", color: Color(red: 0.26, green: 0.52, blue: 0.96))
    default: return Brand(symbol: "q.circle", color: Color(red: 0.49, green: 0.3, blue: 1))
    }
}

func countdown(_ until: Date, now: Date) -> String {
    let s = max(0, Int(until.timeIntervalSince(now)))
    if s >= 3600 { return "\(s / 3600)h \(s % 3600 / 60)m" }
    if s >= 60 { return "\(s / 60)m" }
    return "\(s)s"
}

func clock(_ d: Date) -> String {
    let f = DateFormatter()
    f.timeStyle = .short
    f.dateStyle = Calendar.current.isDateInToday(d) ? .none : .short
    return f.string(from: d)
}

func agentLine(_ a: AgentInfo, now: Date) -> String {
    if let until = parseDate(a.cooldownUntil), until > now { return "Limit reached · back in \(countdown(until, now: now))" }
    if a.signedIn == .no { return "Not signed in · \(a.loginHint)" }
    if let u = a.usage?.first { return "\(Int(u.usedPct))% of \(u.label) used" }
    if a.desktopOnly == true { return "Desktop app · ready" }
    return "Ready"
}

// MARK: - Animated pieces

/// Three bouncing dots: an agent is working.
struct WorkingDots: View {
    let color: Color
    @State private var on = false
    var body: some View {
        HStack(spacing: 2.5) {
            ForEach(0..<3) { i in
                Circle().fill(color).frame(width: 4, height: 4)
                    .offset(y: on ? -2.5 : 2)
                    .animation(.easeInOut(duration: 0.45).repeatForever().delay(Double(i) * 0.15), value: on)
            }
        }
        .frame(width: 18, height: 14)
        .onAppear { on = true }
    }
}

/// Phase glyph with its own little animation.
struct PhaseGlyph: View {
    let phase: String
    let color: Color
    @State private var anim = false
    var body: some View {
        Group {
            switch phase {
            case "working":
                WorkingDots(color: color)
            case "needs-input":
                Image(systemName: "exclamationmark.bubble.fill").foregroundColor(.orange)
                    .rotationEffect(.degrees(anim ? 10 : -10))
                    .animation(.easeInOut(duration: 0.18).repeatCount(6, autoreverses: true).delay(0.2)
                        .repeatForever(autoreverses: false), value: anim)
            case "handing-off":
                Image(systemName: "arrow.triangle.swap").foregroundColor(.yellow)
                    .rotationEffect(.degrees(anim ? 360 : 0))
                    .animation(.linear(duration: 1.6).repeatForever(autoreverses: false), value: anim)
            case "done", "your-turn":
                Image(systemName: "checkmark.circle.fill").foregroundColor(.green)
                    .scaleEffect(anim ? 1 : 0.4)
                    .animation(.spring(response: 0.35, dampingFraction: 0.45), value: anim)
            case "paused":
                Image(systemName: "hourglass").foregroundColor(.orange)
                    .rotationEffect(.degrees(anim ? 180 : 0))
                    .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: false), value: anim)
            case "stopped":
                Image(systemName: "pause.circle.fill").foregroundColor(.gray)
            default:
                Circle().fill(Color.gray.opacity(0.7)).frame(width: 6, height: 6)
                    .scaleEffect(anim ? 1.3 : 0.8)
                    .animation(.easeInOut(duration: 1.6).repeatForever(), value: anim)
            }
        }
        .font(.system(size: 12, weight: .semibold))
        .frame(width: 18, height: 18)
        .onAppear { anim = true }
    }
}

/// Ring that refills as a cooldown runs out (the agent "recharging").
struct RechargeRing: View {
    let from: Date
    let until: Date
    let now: Date
    let color: Color
    var body: some View {
        let total = max(1, until.timeIntervalSince(from))
        let done = min(1, max(0, now.timeIntervalSince(from) / total))
        ZStack {
            Circle().stroke(Color.white.opacity(0.12), lineWidth: 2)
            Circle().trim(from: 0, to: done).stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.8), value: done)
        }
    }
}

struct AgentIcon: View {
    let agent: AgentInfo
    let active: Bool
    let now: Date
    let size: CGFloat
    @State private var hover = false
    var body: some View {
        let b = brand(agent.id)
        let cooling = parseDate(agent.cooldownUntil).map { $0 > now } ?? false
        ZStack {
            Circle().fill(Color.white.opacity(hover ? 0.16 : 0.08))
            if cooling, let until = parseDate(agent.cooldownUntil) {
                RechargeRing(from: until.addingTimeInterval(-5 * 3600), until: until, now: now, color: b.color)
            } else if active {
                Circle().stroke(b.color, lineWidth: 1.6)
            }
            Image(systemName: b.symbol)
                .font(.system(size: size * 0.46, weight: .semibold))
                .foregroundColor(b.color.opacity(cooling || agent.signedIn == .no ? 0.45 : 1))
        }
        .frame(width: size, height: size)
        .scaleEffect(hover ? 1.32 : 1)
        .offset(y: hover ? 3 : 0)
        .shadow(color: b.color.opacity(hover ? 0.6 : 0), radius: 6)
        .animation(.spring(response: 0.28, dampingFraction: 0.55), value: hover)
        .onHover { hover = $0 }
        .help("\(agent.name): \(agentLine(agent, now: now))")
        .zIndex(hover ? 1 : 0)
    }
}

/// Thin rounded progress bar (custom so it matches the black pill everywhere it renders).
struct Bar: View {
    let value: Double // 0...1
    let color: Color
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                Capsule().fill(color).frame(width: max(4, g.size.width * CGFloat(min(1, max(0, value)))))
                    .animation(.spring(response: 0.5, dampingFraction: 0.8), value: value)
            }
        }
        .frame(height: 4)
    }
}

/// "Who built what": one bar, a colored slice per agent.
struct SharesBar: View {
    let shares: [Share]
    var body: some View {
        let total = max(1, shares.reduce(0) { $0 + $1.lines })
        GeometryReader { g in
            HStack(spacing: 1.5) {
                ForEach(shares, id: \.self) { s in
                    RoundedRectangle(cornerRadius: 2).fill(brand(s.agent).color)
                        .frame(width: max(3, g.size.width * CGFloat(s.lines) / CGFloat(total)))
                }
            }
        }
        .frame(height: 5)
    }
}

// MARK: - Views

struct PillView: View {
    @ObservedObject var store: Store
    var body: some View {
        let s = store.primary
        let current = s?.agent
        HStack(spacing: 8) {
            PhaseGlyph(phase: s?.phase ?? "idle", color: brand(current ?? "claude").color)
            HStack(spacing: 5) {
                ForEach(store.agents) { a in
                    AgentIcon(agent: a, active: a.id == current && s?.phase == "working", now: store.now, size: 20)
                }
            }
            if let t = s?.tasks, t.total > 0 {
                Text("\(t.done)/\(t.total)").font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundColor(.white.opacity(0.75))
            }
        }
        .padding(.horizontal, 11)
        .frame(height: 30)
    }
}

struct SessionRow: View {
    let s: SessionStatus
    let now: Date
    var body: some View {
        let b = brand(s.agent)
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                PhaseGlyph(phase: s.phase, color: b.color)
                Text(s.repoName).font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                Spacer()
                Text(phaseLabel(s)).font(.system(size: 10, weight: .medium)).foregroundColor(b.color)
            }
            if let d = s.detail, !d.isEmpty {
                Text(d).font(.system(size: 10.5)).foregroundColor(.white.opacity(0.6)).lineLimit(1)
            }
            if let shares = s.shares, shares.count > 1 || (shares.first?.lines ?? 0) > 0 {
                SharesBar(shares: shares)
                HStack(spacing: 8) {
                    ForEach(shares, id: \.self) { sh in
                        HStack(spacing: 3) {
                            Circle().fill(brand(sh.agent).color).frame(width: 5, height: 5)
                            Text("\(name(sh.agent)) \(pct(sh, shares))%").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.55))
                        }
                    }
                }
            }
            if let t = s.tasks, t.total > 0 {
                Bar(value: Double(t.done) / Double(t.total), color: b.color)
                Text("\(t.done) of \(t.total) tasks done").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.5))
            }
        }
    }

    func pct(_ s: Share, _ all: [Share]) -> Int {
        let t = all.reduce(0) { $0 + $1.lines }
        return t == 0 ? 0 : Int((Double(s.lines) / Double(t) * 100).rounded())
    }

    func name(_ id: String) -> String {
        ["claude": "Claude", "cursor": "Cursor", "codex": "Codex", "antigravity": "Antigravity", "qwen": "Qwen"][id] ?? id
    }

    func phaseLabel(_ s: SessionStatus) -> String {
        let n = name(s.agent)
        switch s.phase {
        case "working": return "\(n) working"
        case "needs-input": return "Needs your input"
        case "your-turn": return "Your turn"
        case "handing-off": return "Switching agents"
        case "done": return "Done"
        case "paused": return "All agents resting"
        case "stopped": return "Stopped"
        case "ended": return "Closed"
        default: return "Idle"
        }
    }
}

struct AgentRow: View {
    let a: AgentInfo
    let now: Date
    var body: some View {
        let b = brand(a.id)
        HStack(spacing: 8) {
            AgentIcon(agent: a, active: false, now: now, size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.system(size: 11.5, weight: .semibold)).foregroundColor(.white)
                Text(agentLine(a, now: now)).font(.system(size: 10))
                    .foregroundColor(a.signedIn == .no ? .orange : .white.opacity(0.55)).lineLimit(1)
            }
            Spacer()
            if let u = a.usage?.first {
                Bar(value: u.usedPct / 100, color: u.usedPct > 85 ? .orange : b.color).frame(width: 54)
            } else if let until = parseDate(a.cooldownUntil), until > now {
                Text(clock(until)).font(.system(size: 9.5, design: .rounded)).foregroundColor(.white.opacity(0.5))
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var store: Store
    @State private var expanded: Bool
    var onSize: (CGSize) -> Void

    init(store: Store, expanded: Bool = false, onSize: @escaping (CGSize) -> Void) {
        self.store = store
        _expanded = State(initialValue: expanded)
        self.onSize = onSize
    }
    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Spacer(minLength: 0); PillView(store: store) }
                if expanded {
                    if store.sessions.isEmpty {
                        Text("All quiet. nowall is watching your agents.")
                            .font(.system(size: 10.5)).foregroundColor(.white.opacity(0.55))
                    }
                    ForEach(store.sessions.prefix(3)) { s in SessionRow(s: s, now: store.now) }
                    if !store.agents.isEmpty {
                        Divider().background(Color.white.opacity(0.15))
                        ForEach(store.agents) { a in AgentRow(a: a, now: store.now) }
                    }
                }
            }
            .padding(.bottom, expanded ? 12 : 0)
            .padding(.horizontal, expanded ? 12 : 0)
            .frame(width: expanded ? 320 : nil)
            .background(
                RoundedRectangle(cornerRadius: expanded ? 18 : 15, style: .continuous).fill(Color.black)
                    .overlay(RoundedRectangle(cornerRadius: expanded ? 18 : 15, style: .continuous)
                        .stroke(Color.white.opacity(0.09), lineWidth: 1))
                    .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
            )
            .onHover { h in withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) { expanded = h } }
            .contextMenu {
                Button("Refresh agents") { store.refreshAgents() }
                Button("Hide for 1 hour") { AppDelegate.shared?.hide(for: 3600) }
                Divider()
                Button("Quit nowall notch") { NSApp.terminate(nil) }
            }
            .background(GeometryReader { g in Color.clear.preference(key: SizeKey.self, value: g.size) })
        }
        .padding(8)
        .fixedSize()
        .onPreferenceChange(SizeKey.self) { onSize(CGSize(width: $0.width + 16, height: $0.height + 16)) }
    }
}

struct SizeKey: PreferenceKey {
    static var defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

// MARK: - Window

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?
    var panel: NotchPanel!
    var store: Store!

    func applicationDidFinishLaunching(_ note: Notification) {
        AppDelegate.shared = self
        let args = CommandLine.arguments
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        let homePath = arg("--home") ?? ProcessInfo.processInfo.environment["NOWALL_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".config/nowall")
        store = Store(home: URL(fileURLWithPath: homePath), node: arg("--node"), cli: arg("--cli"))

        panel = NotchPanel(contentRect: NSRect(x: 0, y: 0, width: 200, height: 46),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        let root = RootView(store: store) { [weak self] size in self?.resize(to: size) }
        panel.contentView = NSHostingView(rootView: root)
        resize(to: CGSize(width: 200, height: 46))
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.resize(to: self.panel.frame.size)
        }
    }

    /// Keeps the panel pinned to the top-right corner, just under the menu bar.
    func resize(to size: CGSize) {
        guard let screen = NSScreen.screens.first else { return }
        let vf = screen.visibleFrame
        let frame = NSRect(x: vf.maxX - size.width - 4, y: vf.maxY - size.height, width: size.width, height: size.height)
        panel.setFrame(frame, display: true)
    }

    func hide(for seconds: TimeInterval) {
        panel.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.panel.orderFrontRegardless() }
    }
}

/// `--snapshot out.png [--expanded]`: renders the view offscreen (for docs and visual checks).
@MainActor
func snapshot(to path: String, expanded: Bool, home: String) {
    let store = Store(home: URL(fileURLWithPath: home), node: nil, cli: nil)
    let view = RootView(store: store, expanded: expanded) { _ in }
        .background(Color(white: 0.93))
    let r = ImageRenderer(content: view)
    r.scale = 2
    guard let img = r.nsImage, let tiff = img.tiffRepresentation,
          let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) else { exit(1) }
    try? png.write(to: URL(fileURLWithPath: path))
}

@main
struct NowallNotchMain {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            let home = args.firstIndex(of: "--home").map { args[$0 + 1] }
                ?? (NSHomeDirectory() as NSString).appendingPathComponent(".config/nowall")
            MainActor.assumeIsolated { snapshot(to: args[i + 1], expanded: args.contains("--expanded"), home: home) }
            exit(0)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // no Dock icon, never steals focus
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
