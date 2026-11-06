// nowall notch: a small always-on-top status pill for macOS.
// It only reads nowall's JSON status files (~/.config/nowall); it never runs agents itself.
// The only things it writes are `order` and `hotkey` in config.json, from the Settings window.
// The global hotkey runs `nowall switch` through the CLI it was started with.
// Build: scripts/build-notch.sh

import AppKit
import Carbon.HIToolbox
import SwiftUI
import UserNotifications

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

/// A running subagent of a session (Claude `agent_id` / Cursor `subagent_id`). Every field is
/// optional so a half-written or older entry never hides the parent.
struct Child: Decodable, Hashable {
    let id: String?
    let type: String?
    let startedAt: String?
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
    /// Set on a subagent's own session: the chat that spawned it. Such sessions are never drawn.
    let parentSid: String?
    /// Subagents still running under this session.
    let children: [Child]?
    /// The agent's own turn ended while children were still running.
    let turnEnded: Bool?
    var id: String { sid }
    /// The account this session runs as (defaults to the agent's own login).
    var who: String { account ?? agent }
    var isChild: Bool { parentSid != nil }
    var childCount: Int { children?.count ?? 0 }
    /// A chat with running subagents is working even if its own turn ended (belt and braces: nowall
    /// keeps `phase` at working too, but an older CLI may not).
    var effectivePhase: String { childCount > 0 && !activePhases.contains(phase) ? "working" : phase }
    /// "explore, generalPurpose"
    var childTypes: String {
        let types = (children ?? []).compactMap { $0.type }.filter { !$0.isEmpty }
        var seen: [String] = []
        for t in types where !seen.contains(t) { seen.append(t) }
        return seen.joined(separator: ", ")
    }

    enum Keys: String, CodingKey {
        case sid, repoName, phase, agent, account, detail, tasks, shares, startedAt, updatedAt
        case parentSid, children, turnEnded
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        sid = try c.decode(String.self, forKey: .sid)
        repoName = try c.decode(String.self, forKey: .repoName)
        phase = try c.decode(String.self, forKey: .phase)
        agent = try c.decode(String.self, forKey: .agent)
        startedAt = try c.decode(String.self, forKey: .startedAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        account = try? c.decode(String.self, forKey: .account)
        detail = try? c.decode(String.self, forKey: .detail)
        tasks = try? c.decode(TaskCount.self, forKey: .tasks)
        shares = try? c.decode([Share].self, forKey: .shares)
        // New in the subagent-aware status; tolerate their absence and any odd shape.
        parentSid = try? c.decode(String.self, forKey: .parentSid)
        children = try? c.decode([Child].self, forKey: .children)
        turnEnded = try? c.decode(Bool.self, forKey: .turnEnded)
    }
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

/// The global hotkey, as stored in config.json (`"hotkey": "ctrl+alt+cmd+n"`, `true` for the default, `false` for off).
struct HotKeyCombo: Equatable {
    var keyCode: UInt32
    var modifiers: UInt32 // Carbon flags
    var display: String

    static let `default` = HotKeyCombo(keyCode: UInt32(kVK_ANSI_N), modifiers: UInt32(controlKey | optionKey | cmdKey), display: "⌃⌥⌘N")

    /// "ctrl+alt+cmd+n" → combo; nil when the string makes no sense (then the default is used).
    static func parse(_ s: String) -> HotKeyCombo? {
        let keys: [String: Int] = [
            "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F,
            "g": kVK_ANSI_G, "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
            "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R,
            "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
            "y": kVK_ANSI_Y, "z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
            "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "space": kVK_Space, "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4, "f5": kVK_F5, "f6": kVK_F6,
            "f7": kVK_F7, "f8": kVK_F8, "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,
        ]
        var mods: UInt32 = 0
        var text = ""
        var key: Int?
        for raw in s.lowercased().split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " }) {
            let part = String(raw)
            switch part {
            case "ctrl", "control", "⌃": mods |= UInt32(controlKey); text += "⌃"
            case "alt", "opt", "option", "⌥": mods |= UInt32(optionKey); text += "⌥"
            case "shift", "⇧": mods |= UInt32(shiftKey); text += "⇧"
            case "cmd", "command", "meta", "⌘": mods |= UInt32(cmdKey); text += "⌘"
            default:
                guard key == nil, let k = keys[part] else { return nil }
                key = k
                text += part.count == 1 ? part.uppercased() : part.capitalized
            }
        }
        guard let key, mods != 0 else { return nil }
        return HotKeyCombo(keyCode: UInt32(key), modifiers: mods, display: text)
    }
}

/// A short message shown next to the tab (or at the top of the card) for a few seconds.
struct Toast: Equatable {
    let text: String
    let until: Date
    let tone: String // "info" | "ok" | "warn"
}

final class Store: ObservableObject {
    @Published var agents: [AgentInfo] = []
    /// Every account nowall knows about, in priority order (inactive ones last).
    @Published var allSlots: [Slot] = []
    /// The icons shown: installed accounts that are in the takeover order.
    @Published var slots: [Slot] = []
    /// Every status file that is still worth keeping, children included (see `visibleSessions`).
    @Published var sessions: [SessionStatus] = []
    @Published var now = Date()
    @Published var expanded = false
    @Published var toast: Toast?
    /// Briefly true after the hotkey fires, so the tab can flash.
    @Published var flash = false
    /// From config.json: `hotkey` (missing/true = default combo, false = off, string = custom).
    @Published var hotkeyEnabled = true
    @Published var hotkey: HotKeyCombo = .default
    /// From config.json `pausedUntil` (nowall pause): hooks are not taking over until then.
    @Published var pausedUntil: Date?
    /// Where the visible shape is inside the window (SwiftUI coordinates), for hover tracking.
    var shapeRect: CGRect = .zero
    /// Called when the hotkey setting changes (the app delegate re-registers it).
    var onHotkeyChange: (() -> Void)?

    let home: URL
    let node: String?
    let cli: String?
    /// Snapshot mode: a fixed clock so countdowns render the same every time.
    let fixedNow: Date?
    private var timer: Timer?
    private var lastRefresh = Date.distantPast
    private var lastConfigRead = Date.distantPast
    private var lastPhases: [String: String]?
    private var switching: Process?

    init(home: URL, node: String?, cli: String?, fixedNow: Date? = nil) {
        self.home = home
        self.node = node
        self.cli = cli
        self.fixedNow = fixedNow
        tick()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    }

    func tick() {
        now = fixedNow ?? Date()
        if let t = toast, t.until <= now { toast = nil }
        if now.timeIntervalSince(lastConfigRead) > 5 { readConfig() }
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
        noticeTransitions()
        if now.timeIntervalSince(lastRefresh) > 60 { refreshAgents() }
    }

    /// Reads the few config keys the notch cares about. Cheap; config.json is tiny.
    func readConfig() {
        lastConfigRead = now
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: home.appendingPathComponent("config.json")),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = j }
        var enabled = true
        var combo = HotKeyCombo.default
        if let b = cfg["hotkey"] as? Bool { enabled = b }
        else if let s = cfg["hotkey"] as? String { combo = HotKeyCombo.parse(s) ?? .default }
        if enabled != hotkeyEnabled || combo != hotkey {
            hotkeyEnabled = enabled
            hotkey = combo
            onHotkeyChange?()
        }
        let paused = parseDate(cfg["pausedUntil"] as? String).flatMap { $0 > now ? $0 : nil }
        if paused != pausedUntil { pausedUntil = paused }
    }

    /// Toast (and, best effort, a notification) when a session starts switching agents or finishes
    /// a task that more than one agent built. The first tick only records what is there.
    private func noticeTransitions() {
        var phases: [String: String] = [:]
        for s in sessions { phases[s.sid] = s.phase }
        defer { lastPhases = phases }
        guard let prev = lastPhases, fixedNow == nil else { return }
        for s in visibleSessions where prev[s.sid] != s.phase {
            if s.phase == "handing-off" {
                let who = shortName(s.who)
                let detail = (s.detail?.isEmpty ?? true) ? "handing the task to the next account" : s.detail!
                show("\(s.repoName): \(who) stopped · \(detail)", tone: "warn", seconds: 5)
                notify(title: "nowall is switching agents", body: "\(s.repoName): \(who) · \(detail)")
            } else if s.phase == "done", let shares = s.shares, shares.count > 1 {
                let total = max(1, shares.reduce(0) { $0 + $1.lines })
                let parts = shares.map { "\(shortName($0.agent)) \(Int((Double($0.lines) / Double(total) * 100).rounded()))%" }
                show("\(s.repoName) done · \(parts.joined(separator: " · "))", tone: "ok", seconds: 5)
                notify(title: "\(s.repoName): done", body: "Built by \(parts.joined(separator: ", "))")
            }
        }
    }

    func show(_ text: String, tone: String = "info", seconds: TimeInterval = 3) {
        toast = Toast(text: text, until: (fixedNow ?? Date()).addingTimeInterval(seconds), tone: tone)
    }

    /// System notification, only when the bundle can post one (ad hoc signed builds usually can;
    /// a denied or failed request just stays silent — the toast already said it).
    private var notifyState = 0 // 0 untried, 1 allowed, -1 unavailable
    func notify(title: String, body: String) {
        guard Bundle.main.bundleIdentifier != nil, Bundle.main.bundleURL.pathExtension == "app", notifyState >= 0 else { return }
        let center = UNUserNotificationCenter.current()
        let post = {
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil)) { err in
                if let err { fputs("notch: notification failed: \(err.localizedDescription)\n", stderr) }
            }
        }
        if notifyState == 1 { post(); return }
        center.requestAuthorization(options: [.alert, .sound]) { [weak self] ok, err in
            DispatchQueue.main.async {
                self?.notifyState = ok ? 1 : -1
                if let err { fputs("notch: notifications unavailable: \(err.localizedDescription)\n", stderr) }
                if ok { post() }
            }
        }
    }

    /// The hotkey / "Switch now": hands the most recent live session to the next account via
    /// `nowall switch --sid <sid>`. Runs the CLI the notch was started with.
    func switchLatest() {
        flash = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.flash = false }
        guard let s = live.first else { show("Nothing is running right now", tone: "warn"); return }
        guard let node, let cli else { show("Can't switch: the notch was started without the nowall CLI", tone: "warn", seconds: 5); return }
        guard switching == nil else { show("Already switching…", tone: "warn"); return }
        show("Switching \(s.repoName) away from \(shortName(s.who))…", tone: "info", seconds: 20)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [cli, "switch", "--sid", s.sid]
        var env = ProcessInfo.processInfo.environment
        env["NOWALL_HOME"] = home.path
        p.environment = env
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.terminationHandler = { [weak self] proc in
            let o = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let e = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            let first = { (t: String) in t.split(separator: "\n").map(String.init).first { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }
            DispatchQueue.main.async {
                self?.switching = nil
                if proc.terminationStatus == 0 {
                    self?.show(first(o) ?? "Handing off \(s.repoName)", tone: "ok", seconds: 5)
                } else {
                    fputs("notch: nowall switch failed (\(proc.terminationStatus)): \(e.isEmpty ? o : e)", stderr)
                    self?.show("Switch failed: \(first(e) ?? first(o) ?? "exit \(proc.terminationStatus)")", tone: "warn", seconds: 6)
                }
                self?.lastRefresh = .distantPast
            }
        }
        do { try p.run(); switching = p } catch {
            fputs("notch: could not run nowall switch: \(error)\n", stderr)
            show("Switch failed: \(error.localizedDescription)", tone: "warn", seconds: 6)
        }
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

    /// What the card lists: subagents' own sessions are folded into their parent.
    var visibleSessions: [SessionStatus] { sessions.filter { !$0.isChild } }

    /// Sessions that are really doing something right now: active (or still running subagents),
    /// recently updated, and not a subagent's own session. Each one gets a glyph.
    var live: [SessionStatus] {
        visibleSessions.filter { s in
            activePhases.contains(s.effectivePhase) && now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast) < staleAfter
        }
    }

    var primary: SessionStatus? { live.first ?? visibleSessions.first }

    func isWorking(_ slot: Slot) -> Bool {
        live.contains { $0.effectivePhase == "working" && $0.who == slot.id }
    }

    /// Rewrites one key in config.json, leaving every other key alone (`nowall` preserves unknown keys too).
    private func patchConfig(_ key: String, _ value: Any?) {
        let path = home.appendingPathComponent("config.json")
        var cfg: [String: Any] = [:]
        if let d = try? Data(contentsOf: path),
           let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { cfg = j }
        cfg["v"] = cfg["v"] ?? 1
        if let value { cfg[key] = value } else { cfg.removeValue(forKey: key) }
        guard let out = try? JSONSerialization.data(withJSONObject: cfg, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        try? out.write(to: path, options: .atomic)
    }

    /// `hotkey: false` turns it off; turning it back on removes the key (default combo) unless a
    /// custom combo string was set, which is kept as is.
    func saveHotkey(enabled: Bool) {
        if enabled {
            patchConfig("hotkey", hotkey == .default ? nil : configString(hotkey))
        } else {
            patchConfig("hotkey", false)
        }
        lastConfigRead = .distantPast
        readConfig()
    }

    /// Back from a combo to the config spelling ("ctrl+alt+cmd+n").
    private func configString(_ c: HotKeyCombo) -> String {
        var parts: [String] = []
        if c.modifiers & UInt32(controlKey) != 0 { parts.append("ctrl") }
        if c.modifiers & UInt32(optionKey) != 0 { parts.append("alt") }
        if c.modifiers & UInt32(shiftKey) != 0 { parts.append("shift") }
        if c.modifiers & UInt32(cmdKey) != 0 { parts.append("cmd") }
        let key = c.display.unicodeScalars.filter { !"⌃⌥⇧⌘".unicodeScalars.contains($0) }
        parts.append(String(String.UnicodeScalarView(key)).lowercased())
        return parts.joined(separator: "+")
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

/// A session's glyph with a tiny `×N` when it has subagents running: one chat, one glyph.
struct SessionGlyph: View {
    let s: SessionStatus
    var body: some View {
        PhaseGlyph(phase: s.effectivePhase, color: brand(s.who).color)
            .overlay(alignment: .bottomTrailing) {
                if s.childCount > 0 {
                    Text("×\(s.childCount)")
                        .font(.system(size: 7.5, weight: .heavy, design: .rounded))
                        .foregroundColor(.black)
                        .padding(.horizontal, 2.5).padding(.vertical, 0.5)
                        .background(Capsule().fill(brand(s.who).color))
                        .offset(x: 7, y: 5)
                }
            }
            .help(s.childCount > 0
                  ? "\(s.repoName): \(shortName(s.who)) · \(s.childCount) subagent\(s.childCount == 1 ? "" : "s")"
                  : "\(s.repoName): \(shortName(s.who))")
    }
}

/// Collapsed: a slim vertical tab. One glyph per live session on top, then one icon per account.
struct TabContent: View {
    @ObservedObject var store: Store
    var body: some View {
        let live = store.live
        VStack(spacing: 9) {
            if live.isEmpty {
                let s = store.primary
                PhaseGlyph(phase: s?.effectivePhase ?? "idle", color: brand(s?.who ?? "claude").color)
            } else {
                ForEach(live.prefix(4)) { s in SessionGlyph(s: s) }
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
        let sessions = store.visibleSessions
        VStack(alignment: .leading, spacing: 11) {
            HStack(spacing: 6) {
                Text("nowall").font(.system(size: 11, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.45))
                if let p = store.pausedUntil {
                    Image(systemName: "pause.circle").font(.system(size: 10, weight: .semibold)).foregroundColor(.orange.opacity(0.9))
                        .help("nowall is paused until \(clock(p)) (nowall resume)")
                    Text("paused · \(countdown(p, now: store.now))").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.5))
                }
                Spacer()
                ForEach(store.slots) { a in
                    AgentIcon(slot: a, active: store.isWorking(a), now: store.now, size: 20)
                }
            }
            if let t = store.toast {
                ToastLine(toast: t)
            }
            if sessions.isEmpty {
                Text("All quiet. nowall is watching your agents.")
                    .font(.system(size: 10.5)).foregroundColor(.white.opacity(0.55))
            }
            ForEach(sessions.prefix(5)) { s in SessionRow(s: s, now: store.now) }
            if sessions.count > 5 {
                Text("+\(sessions.count - 5) more").font(.system(size: 9.5)).foregroundColor(.white.opacity(0.45))
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
        let phase = s.effectivePhase
        let stale = activePhases.contains(phase) && now.timeIntervalSince(parseDate(s.updatedAt) ?? .distantPast) >= staleAfter
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                PhaseGlyph(phase: stale ? "idle" : phase, color: b.color)
                Text(s.repoName).font(.system(size: 12, weight: .semibold)).foregroundColor(.white)
                Spacer()
                Text(stale ? "\(shortName(s.who)) quiet" : phaseLabel(s)).font(.system(size: 10, weight: .medium))
                    .foregroundColor(stale ? .white.opacity(0.5) : b.color)
            }
            if let d = s.detail, !d.isEmpty {
                Text(d).font(.system(size: 10.5)).foregroundColor(.white.opacity(0.6)).lineLimit(1)
            }
            if s.childCount > 0, !stale {
                HStack(spacing: 4) {
                    Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 9, weight: .semibold))
                    Text(subagentLine(s)).lineLimit(1)
                }
                .font(.system(size: 10)).foregroundColor(b.color.opacity(0.85))
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

    /// "Running 2 subagents · explore, generalPurpose" / "Waiting on 1 subagent · explore"
    func subagentLine(_ s: SessionStatus) -> String {
        let n = s.childCount
        let head = "\(s.turnEnded == true ? "Waiting on" : "Running") \(n) subagent\(n == 1 ? "" : "s")"
        return s.childTypes.isEmpty ? head : "\(head) · \(s.childTypes)"
    }

    func phaseLabel(_ s: SessionStatus) -> String {
        let n = shortName(s.who)
        switch s.effectivePhase {
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

func toastColor(_ tone: String) -> Color {
    switch tone {
    case "ok": return .green
    case "warn": return .orange
    default: return Color(white: 0.85)
    }
}

/// The toast inside the card: one line under the header.
struct ToastLine: View {
    let toast: Toast
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(toastColor(toast.tone)).frame(width: 5, height: 5)
            Text(toast.text).font(.system(size: 10.5, weight: .medium)).foregroundColor(.white.opacity(0.85)).lineLimit(2)
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 7).fill(toastColor(toast.tone).opacity(0.14)))
        .transition(.opacity.combined(with: .move(edge: .top)))
    }
}

/// The toast next to the collapsed tab: a small black bubble pointing at the tab.
struct ToastBubble: View {
    let toast: Toast
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(toastColor(toast.tone)).frame(width: 6, height: 6)
            Text(toast.text).font(.system(size: 11, weight: .medium)).foregroundColor(.white).lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .frame(maxWidth: 250)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.black).shadow(color: .black.opacity(0.3), radius: 6))
        .transition(.opacity.combined(with: .move(edge: .trailing)))
    }
}

let fillet: CGFloat = 10
let windowSize = CGSize(width: 340, height: 640)

struct RootView: View {
    @ObservedObject var store: Store
    var body: some View {
        let open = store.expanded
        HStack(alignment: .center, spacing: 6) {
            if !open, let t = store.toast { ToastBubble(toast: t) }
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
            .overlay(
                EdgeNotch(radius: open ? 22 : 13, fillet: fillet)
                    .fill(Color.white.opacity(store.flash ? 0.35 : 0))
                    .animation(.easeOut(duration: 0.5), value: store.flash)
                    .allowsHitTesting(false)
            )
            .background(GeometryReader { g in
                Color.clear.preference(key: RectKey.self, value: g.frame(in: .named("window")))
            })
            .contextMenu {
                Button("Switch agent now\(store.hotkeyEnabled ? "  \(store.hotkey.display)" : "")") { store.switchLatest() }
                    .disabled(store.live.isEmpty)
                Button("Settings…") { AppDelegate.shared?.showSettings() }
                Button("Refresh agents") { store.refreshAgents() }
                Button("Hide for 1 hour") { AppDelegate.shared?.hide(for: 3600) }
                Divider()
                Button("Quit nowall notch") { NSApp.terminate(nil) }
            }
        }
        .animation(.spring(response: 0.36, dampingFraction: 0.82), value: open)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: store.toast)
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

            Divider().padding(.vertical, 4)
            HotkeySection(store: store)

            Divider().padding(.vertical, 4)
            AccountsSection(store: store)
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

/// The handoff hotkey: on/off (written as `hotkey` in config.json) and the current combo.
struct HotkeySection: View {
    @ObservedObject var store: Store
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Switch by hotkey").font(.system(size: 13, weight: .semibold))
                Spacer()
                Toggle("", isOn: Binding(get: { store.hotkeyEnabled }, set: { store.saveHotkey(enabled: $0) }))
                    .labelsHidden().toggleStyle(.switch).controlSize(.small)
            }
            HStack(alignment: .top, spacing: 8) {
                Text(store.hotkey.display)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.35)))
                    .opacity(store.hotkeyEnabled ? 1 : 0.5)
                Text("Hands the session running right now to the next account (same as nowall switch). Works from any app; no Accessibility permission needed. Another key: set \"hotkey\": \"ctrl+alt+cmd+n\" in config.json.")
                    .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Every account with its sign-in state, plus the commands to add or remove one (copyable). Adding an
/// account needs an interactive login, so that stays in the terminal.
struct AccountsSection: View {
    @ObservedObject var store: Store
    @State private var copied: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Accounts").font(.system(size: 13, weight: .semibold))
            Text("One row per login. Extra accounts are separate profiles; nowall never reads their credentials.")
                .font(.system(size: 11)).foregroundColor(.secondary).fixedSize(horizontal: false, vertical: true)
            VStack(spacing: 0) {
                if store.allSlots.isEmpty {
                    Text("No accounts yet. Run: nowall setup").font(.system(size: 11)).foregroundColor(.secondary).padding(10)
                }
                ForEach(Array(store.allSlots.enumerated()), id: \.element.id) { i, s in
                    accountRow(s)
                    if i < store.allSlots.count - 1 { Divider().padding(.leading, 34) }
                }
            }
            .padding(.vertical, 2)
            .frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .controlBackgroundColor)))

            Text("Add or remove one from a terminal:").font(.system(size: 11)).foregroundColor(.secondary).padding(.top, 2)
            VStack(spacing: 4) {
                command("nowall account add claude work", "a second Claude Code login (opens its sign-in)")
                command("nowall account add codex work", "a second Codex login")
                command("nowall account add cursor team --api-key", "a second Cursor account, by API key")
                command("nowall account remove <id>", "forget an account, e.g. claude:work")
            }
        }
    }

    func signInText(_ s: Slot, now: Date) -> (String, Color) {
        if let until = parseDate(s.cooldownUntil), until > now { return ("Limit · back in \(countdown(until, now: now))", .orange) }
        switch s.signedIn {
        case .yes: return ("Signed in", .green)
        case .no: return ("Not signed in", .orange)
        case .unknown: return (s.desktopOnly ? "Desktop app" : "Sign-in unknown", .secondary)
        }
    }

    func accountRow(_ s: Slot) -> some View {
        let b = brand(s.agent)
        let (state, color) = signInText(s, now: store.now)
        return HStack(spacing: 8) {
            Image(systemName: b.symbol).foregroundColor(b.color).frame(width: 16)
            Text(s.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
            Text(s.id).font(.system(size: 10, design: .monospaced)).foregroundColor(.secondary).lineLimit(1)
            if !s.active { Text("off").font(.system(size: 9.5)).foregroundColor(.secondary) }
            Spacer()
            Circle().fill(color).frame(width: 6, height: 6)
            Text(state).font(.system(size: 10)).foregroundColor(color == .secondary ? .secondary : color).lineLimit(1)
            if s.id != s.agent {
                copyButton("nowall account remove \(s.id)", label: "Copy remove").help("Copy the command that forgets this account")
            } else if s.signedIn == .no, !s.loginHint.isEmpty {
                copyButton(s.loginHint, label: "Copy login").help("Copy the command that signs this agent in")
            } else {
                Color.clear.frame(width: 72, height: 1)
            }
        }
        .padding(.vertical, 4).padding(.horizontal, 8)
    }

    func command(_ cmd: String, _ what: String) -> some View {
        HStack(spacing: 8) {
            Text(cmd).font(.system(size: 10.5, design: .monospaced)).lineLimit(1).textSelection(.enabled)
            Spacer()
            copyButton(cmd, label: "Copy")
        }
        .help(what)
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .controlBackgroundColor)))
    }

    func copyButton(_ text: String, label: String) -> some View {
        Button(copied == text ? "Copied" : label) {
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(text, forType: .string)
            copied = text
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { if copied == text { copied = nil } }
        }
        .buttonStyle(.bordered).controlSize(.small)
        .frame(minWidth: 72)
    }
}

// MARK: - Window

final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// System-wide hotkey through Carbon. Unlike NSEvent global monitors this needs no Accessibility or
/// Input Monitoring permission, and it works from an LSUIElement app that never becomes active.
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    var action: (() -> Void)?

    init() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let me = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, _, userData in
            guard let userData else { return noErr }
            Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue().action?()
            return noErr
        }, 1, &spec, me, &handler)
    }

    /// Registers `combo` (replacing the previous one); nil unregisters. Returns an OSStatus (noErr on success).
    @discardableResult
    func register(_ combo: HotKeyCombo?) -> OSStatus {
        if let ref { UnregisterEventHotKey(ref); self.ref = nil }
        guard let combo else { return noErr }
        let id = EventHotKeyID(signature: 0x4E57_414C /* 'NWAL' */, id: 1)
        return RegisterEventHotKey(combo.keyCode, combo.modifiers, id, GetApplicationEventTarget(), 0, &ref)
    }

    deinit { register(nil); if let handler { RemoveEventHandler(handler) } }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var shared: AppDelegate?
    var panel: NotchPanel!
    var store: Store!
    var settings: NSWindow?
    private var hotkey: HotKey?
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
        store.onHotkeyChange = { [weak self] in self?.registerHotkey() }
        registerHotkey()

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

    /// (Re)registers the global hotkey from the store's current setting. Logged to stderr so
    /// `nowall notch status` / the launchd log can show whether it took.
    func registerHotkey() {
        if hotkey == nil { hotkey = HotKey() }
        hotkey?.action = { [weak self] in
            fputs("notch: hotkey pressed → nowall switch\n", stderr)
            self?.store.switchLatest()
        }
        let combo: HotKeyCombo? = store.hotkeyEnabled ? store.hotkey : nil
        let status = hotkey?.register(combo) ?? noErr
        if let combo {
            if status == noErr { fputs("notch: hotkey \(combo.display) registered\n", stderr) }
            else {
                fputs("notch: hotkey \(combo.display) not registered (OSStatus \(status))\(status == eventHotKeyExistsErr ? ": another app uses it" : "")\n", stderr)
                store.show("Hotkey \(combo.display) is taken by another app", tone: "warn", seconds: 6)
            }
        } else {
            fputs("notch: hotkey off\n", stderr)
        }
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

/// `--snapshot out.png [--expanded|--settings] [--home DIR] [--now ISO] [--toast TEXT]`: renders the
/// view offscreen at 2x (for docs and visual checks). `--now` pins the clock so countdowns are stable.
@MainActor
func snapshot(to path: String, expanded: Bool, settings: Bool, home: String, now: Date?, toast: String?) {
    let store = Store(home: URL(fileURLWithPath: home), node: nil, cli: nil, fixedNow: now)
    store.expanded = expanded
    if let toast { store.show(toast, tone: "ok", seconds: 60) }
    let png: Data?
    if settings {
        // Real AppKit controls (checkboxes, buttons) only draw through a hosting view, not ImageRenderer.
        let host = NSHostingView(rootView: SettingsView(store: store).background(Color(nsColor: .windowBackgroundColor)))
        host.appearance = NSAppearance(named: .darkAqua)
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        host.layoutSubtreeIfNeeded()
        let b = host.bounds
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(b.width) * 2, pixelsHigh: Int(b.height) * 2,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
        rep.size = b.size
        host.cacheDisplay(in: b, to: rep)
        png = rep.representation(using: .png, properties: [:])
    } else {
        let r = ImageRenderer(content: RootView(store: store).background(Color(white: 0.86)))
        r.scale = 2
        png = r.nsImage?.tiffRepresentation.flatMap { NSBitmapImageRep(data: $0)?.representation(using: .png, properties: [:]) }
    }
    guard let png else { exit(1) }
    do { try png.write(to: URL(fileURLWithPath: path)) } catch { fputs("snapshot: \(error)\n", stderr); exit(1) }
}

@main
struct NowallNotchMain {
    static func main() {
        let args = CommandLine.arguments
        func arg(_ name: String) -> String? {
            guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let out = arg("--snapshot") {
            let home = arg("--home") ?? (NSHomeDirectory() as NSString).appendingPathComponent(".config/nowall")
            let now = arg("--now").flatMap { parseDate($0) }
            if arg("--now") != nil, now == nil { fputs("snapshot: --now wants an ISO 8601 date\n", stderr); exit(2) }
            MainActor.assumeIsolated {
                snapshot(to: out, expanded: args.contains("--expanded"), settings: args.contains("--settings"),
                         home: home, now: now, toast: arg("--toast"))
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
