// nowall notch: a small always-on-top status pill for macOS.
// It only reads nowall's JSON status files (~/.config/nowall); it never runs agents itself.
// The one thing it writes is `order` in config.json, from the Settings window.
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
    let label: String // "5h", "week"
    let usedPct: Double
    let resetsAt: String?
    var weekly: Bool { label == "week" }
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

/// One login of one agent ("claude", "claude:work", "cursor:b"), in takeover order.
struct AccountInfo: Decodable, Identifiable {
    let id: String
    let agent: String
    let name: String
    let label: String
    let signedIn: SignIn
    let active: Bool
    let cooldownUntil: String?
    let limitMessage: String?
    let usage: [UsageWindow]?
}

struct AgentsSnapshot: Decodable {
    let agents: [AgentInfo]
    let accounts: [AccountInfo]?
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
    let account: String?
    let detail: String?
    let tasks: TaskCount?
    let shares: [Share]?
    let startedAt: String
    let updatedAt: String
    var id: String { sid }
    /// The account this session runs as (defaults to the agent's own login).
    var who: String { account ?? agent }
}

/// What the notch draws one icon for: an account, with its agent's install/login facts folded in.
struct Slot: Identifiable {
    let id: String // account id
    let agent: String
    let name: String
    let label: String
    let signedIn: SignIn
    let desktopOnly: Bool
    let active: Bool
    let cooldownUntil: String?
    let limitMessage: String?
    let usage: [UsageWindow]?
    let loginHint: String

    init(account a: AccountInfo, agent g: AgentInfo) {
        id = a.id; agent = a.agent; name = a.name; label = a.label; signedIn = a.signedIn
        desktopOnly = g.desktopOnly ?? false; active = a.active
        cooldownUntil = a.cooldownUntil; limitMessage = a.limitMessage; usage = a.usage; loginHint = g.loginHint
    }

    /// Older agents.json without `accounts`: one slot per agent.
    init(agent g: AgentInfo) {
        id = g.id; agent = g.id; name = g.name; label = ""; signedIn = g.signedIn
        desktopOnly = g.desktopOnly ?? false; active = g.enabled
        cooldownUntil = g.cooldownUntil; limitMessage = g.limitMessage; usage = g.usage; loginHint = g.loginHint
    }
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

let activePhases: Set<String> = ["working", "needs-input", "handing-off"]
/// A session still marked "working" but silent this long is treated as idle (its hooks stopped firing).
let staleAfter: TimeInterval = 30 * 60

// MARK: - Store

final class Store: ObservableObject {
    @Published var agents: [AgentInfo] = []
    /// Every account nowall knows about, in priority order (inactive ones last).
    @Published var allSlots: [Slot] = []
    /// The icons shown: installed accounts that are in the takeover order.
    @Published var slots: [Slot] = []
    @Published var sessions: [SessionStatus] = []
    @Published var now = Date()
    @Published var expanded = false
    /// Where the visible shape is inside the window (SwiftUI coordinates), for hover tracking.
    var shapeRect: CGRect = .zero

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
            agents = snap.agents
            let byAgent = Dictionary(uniqueKeysWithValues: snap.agents.map { ($0.id, $0) })
            if let accounts = snap.accounts {
                allSlots = accounts.compactMap { a in byAgent[a.agent].map { Slot(account: a, agent: $0) } }
            } else {
                allSlots = snap.agents.map { Slot(agent: $0) }
            }
            slots = allSlots.filter { s in s.active && (byAgent[s.agent]?.installed ?? false) }
        }
        let dir = home.appendingPathComponent("status")
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        var list: [SessionStatus] = []
        for f in files where f.pathExtension == "json" {
            guard let d = try? Data(contentsOf: f), let s = try? dec.decode(SessionStatus.self, from: d) else { continue }
            let age = now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast)
            let active = activePhases.contains(s.phase)
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

    /// Sessions that are really doing something right now: active phase and recently updated.
    var live: [SessionStatus] {
        sessions.filter { s in
            activePhases.contains(s.phase) && now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast) < staleAfter
        }
    }

    var primary: SessionStatus? { live.first ?? sessions.first }

    func isWorking(_ slot: Slot) -> Bool {
        live.contains { $0.phase == "working" && $0.who == slot.id }
    }

    /// Rewrites `order` in config.json (and turns the agent on), leaving every other key alone.
    /// Mirrors `nowall order`; nowall itself drops ids it doesn't know.
    func saveOrder(_ ids: [String]) {
        let path = home.appendingPathComponent("config.json")
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: path),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = j }
        cfg["v"] = cfg["v"] ?? 1
        cfg["order"] = ids
        var enabled = cfg["enabled"] as? [String: Any] ?? [:]
        for id in ids { enabled[String(id.split(separator: ":")[0])] = true }
        cfg["enabled"] = enabled
        guard let out = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try? out.write(to: path, options: .atomic)
        lastRefresh = .distantPast // pick the change up on the next tick
    }
}

// MARK: - Look

struct Brand {
    let symbol: String
    let color: Color
}

func brand(_ id: String) -> Brand {
    switch id.split(separator: ":").first.map(String.init) ?? id {
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

/// "Claude", "Claude (work)".
func shortName(_ who: String) -> String {
    let parts = who.split(separator: ":", maxSplits: 1).map(String.init)
    let base = ["claude": "Claude", "cursor": "Cursor", "codex": "Codex", "antigravity": "Antigravity", "qwen": "Qwen"][parts[0]] ?? parts[0]
    return parts.count > 1 ? "\(base) (\(parts[1]))" : base
}

func usageLine(_ usage: [UsageWindow]) -> String {
    usage.map { "\(Int($0.usedPct.rounded()))% of \($0.weekly ? "week" : $0.label)" }.joined(separator: " · ")
}

func slotLine(_ s: Slot, now: Date) -> String {
    if let until = parseDate(s.cooldownUntil), until > now { return "Limit reached · back in \(countdown(until, now: now))" }
    if s.signedIn == .no { return s.loginHint.isEmpty ? "Not signed in" : "Not signed in · \(s.loginHint)" }
    if let u = s.usage, !u.isEmpty { return usageLine(u) }
    if s.desktopOnly { return "Desktop app · ready" }
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

/// One ring per usage window: the short window (5h) inside, the week outside. Fills clockwise as
/// the limit is used up and turns orange past 85%.
struct UsageRings: View {
    let usage: [UsageWindow]
    let color: Color
    let size: CGFloat
    var body: some View {
        let short = usage.first { !$0.weekly }
        let week = usage.first { $0.weekly }
        let w: CGFloat = size >= 28 ? 2.4 : 1.8
        ZStack {
            ring(week, inset: 0, width: w)
            ring(short, inset: w + 1.6, width: w)
        }
    }

    @ViewBuilder
    func ring(_ u: UsageWindow?, inset: CGFloat, width: CGFloat) -> some View {
        if let u {
            let v = min(1, max(0, u.usedPct / 100))
            ZStack {
                Circle().stroke(Color.white.opacity(0.1), lineWidth: width)
                Circle().trim(from: 0, to: v)
                    .stroke(u.usedPct > 85 ? Color.orange : color, style: StrokeStyle(lineWidth: width, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.easeOut(duration: 0.8), value: v)
            }
            .padding(inset)
        }
    }
}

struct AgentIcon: View {
    let slot: Slot
    let active: Bool
    let now: Date
    let size: CGFloat
    @State private var hover = false
    var body: some View {
        let b = brand(slot.agent)
        let cooling = parseDate(slot.cooldownUntil).map { $0 > now } ?? false
        let rings = !cooling && !(slot.usage ?? []).isEmpty
        ZStack {
            Circle().fill(Color.white.opacity(hover ? 0.16 : 0.08))
            if cooling, let until = parseDate(slot.cooldownUntil) {
                RechargeRing(from: until.addingTimeInterval(-5 * 3600), until: until, now: now, color: b.color)
            } else if let u = slot.usage, !u.isEmpty {
                UsageRings(usage: u, color: b.color, size: size)
            }
            if active {
                Circle().stroke(b.color.opacity(0.9), lineWidth: 1.4).padding(rings ? 6.5 : 0)
            }
            Image(systemName: b.symbol)
                .font(.system(size: size * (rings ? 0.38 : 0.46), weight: .semibold))
                .foregroundColor(b.color.opacity(cooling || slot.signedIn == .no ? 0.45 : 1))
            if let first = slot.label.first {
                Text(String(first).uppercased())
                    .font(.system(size: max(6, size * 0.3), weight: .heavy, design: .rounded))
                    .foregroundColor(.black)
                    .frame(width: size * 0.42, height: size * 0.42)
                    .background(Circle().fill(b.color))
                    .offset(x: size * 0.34, y: size * 0.34)
            }
        }
        .frame(width: size, height: size)
        .scaleEffect(hover ? 1.32 : 1)
        .offset(y: hover ? 3 : 0)
        .shadow(color: b.color.opacity(hover ? 0.6 : 0), radius: 6)
        .animation(.spring(response: 0.28, dampingFraction: 0.55), value: hover)
        .onHover { hover = $0 }
        .help("\(slot.name): \(slotLine(slot, now: now))")
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

/// Collapsed: a slim vertical tab. One glyph per live session on top, then one icon per account.
struct TabContent: View {
    @ObservedObject var store: Store
    var body: some View {
        let live = store.live
        VStack(spacing: 9) {
            if live.isEmpty {
                let s = store.primary
                PhaseGlyph(phase: s?.phase ?? "idle", color: brand(s?.who ?? "claude").color)
            } else {
                ForEach(live.prefix(4)) { s in
                    PhaseGlyph(phase: s.phase, color: brand(s.who).color).help("\(s.repoName): \(shortName(s.who))")
                }
                if live.count > 4 {
                    Text("+\(live.count - 4)").font(.system(size: 9, weight: .bold, design: .rounded))
                        .foregroundColor(.white.opacity(0.6))
                }
            }
            ForEach(store.slots) { a in
                AgentIcon(slot: a, active: store.isWorking(a), now: store.now, size: 22)
            }
            if let t = store.primary?.tasks, t.total > 0 {
                Text("\(t.done)/\(t.total)").font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundColor(.white.opacity(0.7))
            }
        }
        .frame(width: 26)
    }
}

/// Expanded: the detail card.
struct CardContent: View {
    @ObservedObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                Text("nowall").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.45))
                Spacer()
                ForEach(store.slots) { a in
                    AgentIcon(slot: a, active: store.isWorking(a), now: store.now, size: 20)
                }
            }
            if store.sessions.isEmpty {
                Text("All quiet. nowall is watching your agents.")
                    .font(.system(size: 10.5)).foregroundColor(.white.opacity(0.55))
            }
            ForEach(store.sessions.prefix(5)) { s in SessionRow(s: s, now: store.now) }
            if store.sessions.count > 5 {
                Text("+\(store.sessions.count - 5) more").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.45))
            }
            if !store.slots.isEmpty {
                Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
                ForEach(store.slots) { a in AgentRow(a: a, working: store.isWorking(a), now: store.now) }
            }
        }
        .frame(width: 280, alignment: .leading)
    }
}

struct SessionRow: View {
    let s: SessionStatus
    let now: Date
    var body: some View {
        let b = brand(s.who)
        let stale = activePhases.contains(s.phase) && now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast) >= staleAfter
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                PhaseGlyph(phase: stale ? "idle" : s.phase, color: b.color)
                Text(s.repoName).font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                Spacer()
                Text(stale ? "\(shortName(s.who)) quiet" : phaseLabel(s)).font(.system(size: 10, weight: .medium))
                    .foregroundColor(stale ? .white.opacity(0.5) : b.color)
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
                            Text("\(shortName(sh.agent)) \(pct(sh, shares))%").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.55))
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

    func phaseLabel(_ s: SessionStatus) -> String {
        let n = shortName(s.who)
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
    let a: Slot
    let working: Bool
    let now: Date
    var body: some View {
        let b = brand(a.agent)
        HStack(spacing: 8) {
            AgentIcon(slot: a, active: working, now: now, size: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(a.name).font(.system(size: 11.5, weight: .semibold)).foregroundColor(.white)
                Text(slotLine(a, now: now)).font(.system(size: 10))
                    .foregroundColor(a.signedIn == .no ? .orange : .white.opacity(0.55)).lineLimit(1)
            }
            Spacer()
            if let u = a.usage, !u.isEmpty, !(parseDate(a.cooldownUntil).map { $0 > now } ?? false) {
                VStack(alignment: .trailing, spacing: 3) {
                    ForEach(u, id: \.self) { w in
                        HStack(spacing: 4) {
                            Text(w.weekly ? "wk" : w.label).font(.system(size: 8.5, design: .rounded)).foregroundColor(.white.opacity(0.45))
                            Bar(value: w.usedPct / 100, color: w.usedPct > 85 ? .orange : b.color).frame(width: 48)
                        }
                    }
                }
            } else if let until = parseDate(a.cooldownUntil), until > now {
                Text(clock(until)).font(.system(size: 9.5, design: .rounded)).foregroundColor(.white.opacity(0.5))
            }
        }
    }
}

/// Notch-style shape hanging off the right screen edge: rounded on the inside, with concave
/// fillets where it meets the edge (the MacBook notch, turned on its side).
struct EdgeNotch: Shape {
    var radius: CGFloat
    var fillet: CGFloat
    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(radius, fillet) }
        set { radius = newValue.first; fillet = newValue.second }
    }
    func path(in r: CGRect) -> Path {
        let f = min(fillet, r.height / 4)
        let c = min(radius, (r.height - 2 * f) / 2, r.width - f)
        var p = Path()
        p.move(to: CGPoint(x: r.maxX, y: r.minY))
        p.addQuadCurve(to: CGPoint(x: r.maxX - f, y: r.minY + f), control: CGPoint(x: r.maxX, y: r.minY + f))
        p.addLine(to: CGPoint(x: r.minX + c, y: r.minY + f))
        p.addQuadCurve(to: CGPoint(x: r.minX, y: r.minY + f + c), control: CGPoint(x: r.minX, y: r.minY + f))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - f - c))
        p.addQuadCurve(to: CGPoint(x: r.minX + c, y: r.maxY - f), control: CGPoint(x: r.minX, y: r.maxY - f))
        p.addLine(to: CGPoint(x: r.maxX - f, y: r.maxY - f))
        p.addQuadCurve(to: CGPoint(x: r.maxX, y: r.maxY), control: CGPoint(x: r.maxX, y: r.maxY - f))
        p.closeSubpath()
        return p
    }
}

let fillet: CGFloat = 10
let windowSize = CGSize(width: 340, height: 640)

struct RootView: View {
    @ObservedObject var store: Store
    var body: some View {
        let open = store.expanded
        ZStack(alignment: .leading) {
            if open {
                CardContent(store: store).transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .trailing)))
            } else {
                TabContent(store: store).transition(.opacity)
            }
        }
        .padding(.leading, open ? 16 : 7)
        .padding(.trailing, open ? 14 : 5)
        .padding(.vertical, fillet + (open ? 14 : 10))
        .background(
            EdgeNotch(radius: open ? 22 : 13, fillet: fillet)
                .fill(Color.black)
                .shadow(color: .black.opacity(0.3), radius: 8, x: -2)
        )
        .background(GeometryReader { g in
            Color.clear.preference(key: RectKey.self, value: g.frame(in: .named("window")))
        })
        .contextMenu {
            Button("Settings…") { AppDelegate.shared?.showSettings() }
            Button("Refresh agents") { store.refreshAgents() }
            Button("Hide for 1 hour") { AppDelegate.shared?.hide(for: 3600) }
            Divider()
            Button("Quit nowall notch") { NSApp.terminate(nil) }
        }
        .animation(.spring(response: 0.36, dampingFraction: 0.82), value: open)
        .frame(width: windowSize.width, height: windowSize.height, alignment: .trailing)
        .coordinateSpace(name: "window")
        .onPreferenceChange(RectKey.self) { store.shapeRect = $0 }
    }
}

struct RectKey: PreferenceKey {
    static var defaultValue: CGRect = .zero
    static func reduce(value: inout CGRect, nextValue: () -> CGRect) { value = nextValue() }
}

// MARK: - Settings (takeover order)

/// The priority queue: every account, draggable, with a checkbox for "use this one".
/// Saving writes `order` in config.json; nowall and the notch pick it up within a minute.
struct SettingsView: View {
    @ObservedObject var store: Store
    /// Until the user edits, the list mirrors the store; after that, their edits (saved on every change).
    @State private var edited: [Slot]?
    @State private var editedIncluded: Set<String>?
    @State private var dragging: String?

    var rows: [Slot] { edited ?? store.allSlots }
    var included: Set<String> { editedIncluded ?? Set(store.allSlots.filter(\.active).map(\.id)) }
    var rowsBinding: Binding<[Slot]> { Binding(get: { rows }, set: { edited = $0 }) }

    /// Drag one row over another to swap places; the order is saved when the drop lands.
    struct Reorder: DropDelegate {
        let item: String
        @Binding var rows: [Slot]
        @Binding var dragging: String?
        let done: () -> Void
        func dropEntered(info: DropInfo) {
            guard let from = dragging, from != item,
                  let i = rows.firstIndex(where: { $0.id == from }),
                  let j = rows.firstIndex(where: { $0.id == item }) else { return }
            withAnimation(.easeInOut(duration: 0.15)) {
                rows.move(fromOffsets: IndexSet(integer: i), toOffset: j > i ? j + 1 : j)
            }
        }
        func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }
        func performDrop(info: DropInfo) -> Bool { dragging = nil; done(); return true }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Takeover order").font(.system(size: 13, weight: .semibold))
            Text("When an account hits its limit, nowall continues with the next checked one. Drag to reorder.")
                .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 2) {
                if rows.isEmpty {
                    Text("No agents detected yet. Run: nowall setup").font(.system(size: 11)).foregroundColor(.secondary).padding(12)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, s in
                    row(i, s)
                        .onDrag { dragging = s.id; return NSItemProvider(object: s.id as NSString) }
                        .onDrop(of: [.text], delegate: Reorder(item: s.id, rows: rowsBinding, dragging: $dragging, done: save))
                }
            }
            .padding(4)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))
            Text("Add another login with:  nowall account add claude work  ·  nowall account add cursor team --api-key")
                .font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(width: 440)
    }

    func row(_ i: Int, _ s: Slot) -> some View {
        HStack(spacing: 8) {
            Toggle("", isOn: Binding(
                get: { included.contains(s.id) },
                set: { on in
                    var inc = included
                    if on { inc.insert(s.id) } else { inc.remove(s.id) }
                    editedIncluded = inc
                    save()
                }
            )).labelsHidden().toggleStyle(.checkbox)
            Text("\(i + 1).").font(.system(size: 11, design: .rounded)).foregroundColor(.secondary).frame(width: 18, alignment: .trailing)
            Image(systemName: brand(s.agent).symbol).foregroundColor(brand(s.agent).color).frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(s.name).font(.system(size: 12, weight: .medium))
                Text(slotLine(s, now: store.now)).font(.system(size: 10)).foregroundColor(s.signedIn == .no ? .orange : .secondary)
            }
            Spacer()
            Button { move(i, by: -1) } label: { Image(systemName: "chevron.up") }
                .buttonStyle(.borderless).disabled(i == 0)
            Button { move(i, by: 1) } label: { Image(systemName: "chevron.down") }
                .buttonStyle(.borderless).disabled(i == rows.count - 1)
            Image(systemName: "line.3.horizontal").foregroundColor(.secondary).font(.system(size: 11))
        }
        .opacity(included.contains(s.id) ? 1 : 0.55)
        .padding(.vertical, 5).padding(.horizontal, 6)
        .background(RoundedRectangle(cornerRadius: 6).fill(dragging == s.id ? Color.accentColor.opacity(0.15) : Color.clear))
        .contentShape(Rectangle())
    }

    func move(_ i: Int, by d: Int) {
        let j = i + d
        var r = rows
        guard r.indices.contains(j) else { return }
        r.swapAt(i, j)
        edited = r
        save()
    }

    func save() {
        store.saveOrder(rows.map(\.id).filter { included.contains($0) })
    }
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
    var settings: NSWindow?
    private var mouseTimer: Timer?
    private var outsideSince: Date?

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

        // One fixed-size, transparent window. It never resizes (resizing under the mouse is what
        // made the old pill jump); the shape animates inside it, and clicks outside it pass through.
        panel = NotchPanel(contentRect: NSRect(origin: .zero, size: windowSize),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        panel.isMovable = false
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = true
        panel.contentView = NSHostingView(rootView: RootView(store: store))
        place()
        panel.orderFrontRegardless()
        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                               object: nil, queue: .main) { [weak self] _ in self?.place() }
        mouseTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.trackMouse() }
        if args.contains("--open-settings") { showSettings() }
    }

    /// Right edge of the main screen, vertically centered.
    func place() {
        guard let screen = NSScreen.screens.first else { return }
        let vf = screen.visibleFrame
        panel.setFrame(NSRect(x: vf.maxX - windowSize.width, y: vf.midY - windowSize.height / 2,
                              width: windowSize.width, height: windowSize.height), display: true)
    }

    /// Hover is computed from the mouse position, not SwiftUI hover, so it can't flicker.
    func trackMouse() {
        let m = NSEvent.mouseLocation
        let f = panel.frame
        let local = CGPoint(x: m.x - f.minX, y: f.height - (m.y - f.minY)) // SwiftUI top-left origin
        let slack: CGFloat = store.expanded ? 14 : 6
        let inside = store.shapeRect.insetBy(dx: -slack, dy: -slack).contains(local)
        panel.ignoresMouseEvents = !inside
        if inside {
            outsideSince = nil
            if !store.expanded { store.expanded = true }
        } else if store.expanded {
            if outsideSince == nil { outsideSince = Date() }
            if let t = outsideSince, Date().timeIntervalSince(t) > 0.25 { store.expanded = false; outsideSince = nil }
        }
    }

    func hide(for seconds: TimeInterval) {
        panel.orderOut(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.panel.orderFrontRegardless() }
    }

    func showSettings() {
        if settings == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 420),
                             styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            w.title = "nowall Settings"
            w.isReleasedWhenClosed = false
            let host = NSHostingView(rootView: SettingsView(store: store))
            host.sizingOptions = [.preferredContentSize] // window follows the list as accounts come and go
            w.contentView = host
            w.center()
            settings = w
        }
        store.refreshAgents()
        NSApp.activate(ignoringOtherApps: true)
        settings?.makeKeyAndOrderFront(nil)
    }
}

/// `--snapshot out.png [--expanded|--settings]`: renders the view offscreen (for docs and visual checks).
@MainActor
func snapshot(to path: String, expanded: Bool, settings: Bool, home: String) {
    let store = Store(home: URL(fileURLWithPath: home), node: nil, cli: nil)
    store.expanded = expanded
    let png: Data?
    if settings {
        // Real AppKit controls (checkboxes, buttons) only draw through a hosting view, not ImageRenderer.
        let host = NSHostingView(rootView: SettingsView(store: store).background(Color(nsColor: .windowBackgroundColor)))
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { exit(1) }
        host.cacheDisplay(in: host.bounds, to: rep)
        png = rep.representation(using: .png, properties: [:])
    } else {
        let r = ImageRenderer(content: RootView(store: store).background(Color(white: 0.86)))
        r.scale = 2
        png = r.nsImage?.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }
    }
    guard let png else { exit(1) }
    try? png.write(to: URL(fileURLWithPath: path))
}

@main
struct NowallNotchMain {
    static func main() {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
            let home = args.firstIndex(of: "--home").map { args[$0 + 1] }
                ?? (NSHomeDirectory() as NSString).appendingPathComponent(".config/nowall")
            MainActor.assumeIsolated {
                snapshot(to: args[i + 1], expanded: args.contains("--expanded"), settings: args.contains("--settings"), home: home)
            }
            exit(0)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory) // no Dock icon, never steals focus
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
