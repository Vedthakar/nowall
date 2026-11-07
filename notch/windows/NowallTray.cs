// The nowall tray app for Windows: the counterpart of the macOS notch.
//
// It only reads the files nowall already writes (status\*.json, agents.json, config.json) and only
// acts by running the nowall CLI, as a plain process and never through a shell. No daemon, no server.
//
// `nowall setup` compiles this file on the user's machine with the C# compiler that ships in every
// Windows 10 and 11 (.NET Framework's csc.exe), which only understands C# 5: no `?.`, `$""`, `nameof`
// or `out var` here. Keep the source ASCII so the compiler can't misread it under any code page.
//
// The exe lives in <nowall home>\notch\, so that folder's parent is the home it reads, and each
// nowall home gets its own instance. launch.txt beside it holds the node and cli paths (two lines).
//
// Flags, for `nowall` itself and for the Windows smoke test:
//   --running            exit 0 if the tray for this home is running, else 1
//   --quit               ask it to quit and wait until it has
//   --dump               print what the panel would show, as JSON, and exit
//   --screenshot <png>   draw the panel to a PNG and exit
//   --desktop-shot <png> show the panel in its real place and capture the whole screen
//   --click <key>        press a panel button by key, print the result as JSON, and exit
//   --icon-shot <png>    draw the tray icon as it is now, four times its size, and exit
//   --now <iso date>     pin the clock for the three modes above

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("nowall")]
[assembly: AssemblyProduct("nowall")]

namespace Nowall
{
    internal static class Json
    {
        public static string Str(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as string : null;
        }

        public static bool Bool(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        public static double Num(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return 0;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch (Exception) { return 0; }
        }

        public static IDictionary<string, object> Dict(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as IDictionary<string, object> : null;
        }

        /// Only the objects in a JSON array, so one odd entry never hides the rest.
        public static List<IDictionary<string, object>> Objects(IDictionary<string, object> d, string key)
        {
            var list = new List<IDictionary<string, object>>();
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return list;
            var items = v as object[];
            if (items == null) return list;
            foreach (var item in items)
            {
                var o = item as IDictionary<string, object>;
                if (o != null) list.Add(o);
            }
            return list;
        }

        /// A file a hook may be replacing right now, or null. Status files are small; the cap is a guard.
        public static IDictionary<string, object> ReadFile(string path, int maxBytes)
        {
            try
            {
                using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (f.Length > maxBytes) return null;
                    using (var r = new StreamReader(f, Encoding.UTF8))
                    {
                        var s = new JavaScriptSerializer { MaxJsonLength = maxBytes };
                        return s.DeserializeObject(r.ReadToEnd()) as IDictionary<string, object>;
                    }
                }
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    internal sealed class UsageWindow
    {
        public string Label;
        public double UsedPct;
        public bool Weekly { get { return Label == "week"; } }
    }

    internal sealed class Share
    {
        public string Agent;
        public int Lines;
    }

    internal sealed class Slot
    {
        public string Id, Agent, Name, SignedIn, LoginHint;
        public bool Active, Installed, DesktopOnly, DesktopApp;
        public DateTime? CooldownUntil;
        public List<UsageWindow> Usage = new List<UsageWindow>();

        public bool Warns { get { return SignedIn == "no" && !DesktopApp; } }
    }

    internal sealed class Session
    {
        public string Sid, RepoName, Phase, Agent, Account, Detail, ChildTypes, OriginKind, UpdatedAtRaw;
        public DateTime? UpdatedAt;
        public int TasksDone, TasksTotal, ChildCount;
        public bool NoRepo, TurnEnded;
        public List<Share> Shares = new List<Share>();

        public string Who { get { return string.IsNullOrEmpty(Account) ? Agent : Account; } }

        public string EffectivePhase
        {
            get { return ChildCount > 0 && !Model.ActivePhases.Contains(Phase) ? "working" : Phase; }
        }
    }

    /// One read of nowall's files. Everything the panel and the tray icon show comes from here, and
    /// --dump prints it, so the smoke test checks what a person would see.
    internal sealed class Model
    {
        public static readonly HashSet<string> ActivePhases = new HashSet<string> { "working", "needs-input", "handing-off" };
        public static readonly HashSet<string> FinishedPhases = new HashSet<string> { "your-turn", "done", "stopped", "paused" };
        private static readonly TimeSpan StaleAfter = TimeSpan.FromMinutes(30);

        public DateTime Now;
        public List<Session> Sessions = new List<Session>(); // newest first, subagents' own sessions left out
        public List<Slot> AllSlots = new List<Slot>();
        public List<Slot> Slots = new List<Slot>();
        public DateTime? PausedUntil;

        public static DateTime? ParseDate(string s)
        {
            DateTimeOffset d;
            if (string.IsNullOrEmpty(s)) return null;
            if (!DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out d)) return null;
            return d.UtcDateTime;
        }

        public static Model Read(string home, DateTime now)
        {
            var m = new Model { Now = now };
            m.ReadAgents(Path.Combine(home, "agents.json"));
            var config = Json.ReadFile(Path.Combine(home, "config.json"), 1024 * 1024);
            var paused = ParseDate(Json.Str(config, "pausedUntil"));
            if (paused.HasValue && paused.Value > now) m.PausedUntil = paused;
            m.ReadSessions(Path.Combine(home, "status"));
            return m;
        }

        private void ReadAgents(string path)
        {
            var snap = Json.ReadFile(path, 1024 * 1024);
            if (snap == null) return;
            var agents = new Dictionary<string, IDictionary<string, object>>();
            foreach (var a in Json.Objects(snap, "agents"))
            {
                var id = Json.Str(a, "id");
                if (id != null) agents[id] = a;
            }
            var accounts = Json.Objects(snap, "accounts");
            if (accounts.Count > 0)
            {
                foreach (var a in accounts)
                {
                    var agentId = Json.Str(a, "agent");
                    IDictionary<string, object> g;
                    if (agentId == null || !agents.TryGetValue(agentId, out g)) continue;
                    AllSlots.Add(MakeSlot(a, g));
                }
            }
            else
            {
                foreach (var g in agents.Values) AllSlots.Add(MakeSlot(null, g));
            }
            Slots = AllSlots.Where(s => s.Active && s.Installed).ToList();
        }

        private static Slot MakeSlot(IDictionary<string, object> account, IDictionary<string, object> agent)
        {
            var from = account ?? agent;
            var id = Json.Str(from, "id") ?? "";
            var agentId = account != null ? (Json.Str(account, "agent") ?? id) : id;
            var isDefault = id == agentId;
            var slot = new Slot
            {
                Id = id,
                Agent = agentId,
                Name = Json.Str(from, "name") ?? id,
                SignedIn = ParseSignIn(from),
                Active = Json.Bool(from, account != null ? "active" : "enabled"),
                Installed = Json.Bool(agent, "installed"),
                DesktopOnly = Json.Bool(agent, "desktopOnly"),
                // The desktop app has its own login, so it only speaks for the agent's main account.
                DesktopApp = Json.Bool(agent, "desktopApp") && isDefault,
                CooldownUntil = ParseDate(Json.Str(from, "cooldownUntil")),
                // The agent's own login command would sign in the main account, not this one.
                LoginHint = isDefault ? (Json.Str(agent, "loginHint") ?? "") : "nowall account login " + id,
            };
            foreach (var u in Json.Objects(from, "usage"))
            {
                var label = Json.Str(u, "label");
                if (label != null) slot.Usage.Add(new UsageWindow { Label = label, UsedPct = Json.Num(u, "usedPct") });
            }
            return slot;
        }

        private static string ParseSignIn(IDictionary<string, object> d)
        {
            object v;
            if (d != null && d.TryGetValue("signedIn", out v) && v is bool) return (bool)v ? "yes" : "no";
            return "unknown";
        }

        private void ReadSessions(string dir)
        {
            string[] files;
            try { files = Directory.GetFiles(dir, "*.json"); }
            catch (Exception) { return; }
            var list = new List<Session>();
            foreach (var file in files)
            {
                var d = Json.ReadFile(file, 64 * 1024);
                var s = d == null ? null : MakeSession(d);
                if (s == null) continue;
                var age = s.UpdatedAt.HasValue ? Now - s.UpdatedAt.Value : TimeSpan.MaxValue;
                // A finished chat waits (hours, if need be) until you've looked at it. A closed one
                // lingers just long enough to notice, an idle one a little longer.
                var keep = ActivePhases.Contains(s.Phase) || FinishedPhases.Contains(s.Phase)
                    ? TimeSpan.FromHours(6)
                    : s.Phase == "ended" ? TimeSpan.FromSeconds(20) : TimeSpan.FromMinutes(15);
                if (age < keep) list.Add(s);
            }
            Sessions = list.OrderByDescending(s => s.UpdatedAtRaw, StringComparer.Ordinal).ToList();
        }

        /// Null for anything that isn't a whole session (children.json lives in the same folder), and
        /// for a subagent's own session, which is folded into its parent.
        private static Session MakeSession(IDictionary<string, object> d)
        {
            var sid = Json.Str(d, "sid");
            var phase = Json.Str(d, "phase");
            var agent = Json.Str(d, "agent");
            var updated = Json.Str(d, "updatedAt");
            if (sid == null || phase == null || agent == null || updated == null) return null;
            if (Json.Str(d, "parentSid") != null) return null;
            var tasks = Json.Dict(d, "tasks");
            var children = Json.Objects(d, "children");
            var types = new List<string>();
            foreach (var c in children)
            {
                var t = Json.Str(c, "type");
                if (!string.IsNullOrEmpty(t) && !types.Contains(t)) types.Add(t);
            }
            var s = new Session
            {
                Sid = sid,
                RepoName = Json.Str(d, "repoName") ?? "",
                Phase = phase,
                Agent = agent,
                Account = Json.Str(d, "account"),
                Detail = Json.Str(d, "detail"),
                UpdatedAtRaw = updated,
                UpdatedAt = ParseDate(updated),
                TasksDone = (int)Json.Num(tasks, "done"),
                TasksTotal = (int)Json.Num(tasks, "total"),
                ChildCount = children.Count,
                ChildTypes = string.Join(", ", types),
                TurnEnded = Json.Bool(d, "turnEnded"),
                NoRepo = Json.Bool(d, "noRepo"),
                OriginKind = Json.Str(Json.Dict(d, "origin"), "kind"),
            };
            foreach (var sh in Json.Objects(d, "shares"))
            {
                var a = Json.Str(sh, "agent");
                if (a != null) s.Shares.Add(new Share { Agent = a, Lines = (int)Json.Num(sh, "lines") });
            }
            return s;
        }

        public bool IsStale(Session s)
        {
            return ActivePhases.Contains(s.EffectivePhase) && !(s.UpdatedAt.HasValue && Now - s.UpdatedAt.Value < StaleAfter);
        }

        /// Really doing something right now.
        public List<Session> Live
        {
            get { return Sessions.Where(s => ActivePhases.Contains(s.EffectivePhase) && !IsStale(s)).ToList(); }
        }

        public bool IsTakeover(Session s)
        {
            return ActivePhases.Contains(s.EffectivePhase) && !IsStale(s)
                && (s.OriginKind == "takeover" || s.EffectivePhase == "handing-off");
        }

        public List<Session> Takeovers { get { return Sessions.Where(IsTakeover).ToList(); } }

        public bool CanSwitch(Session s)
        {
            return ActivePhases.Contains(s.EffectivePhase) && !IsStale(s) && !s.NoRepo && !IsTakeover(s) && SwitchTargets(s).Count > 0;
        }

        /// Accounts this session could be handed to.
        public List<Slot> SwitchTargets(Session s)
        {
            return AllSlots.Where(a => a.Active && a.Installed && !a.DesktopOnly && a.SignedIn != "no" && a.Id != s.Who).ToList();
        }

        public bool IsWorking(Slot slot)
        {
            return Live.Any(s => s.EffectivePhase == "working" && s.Who == slot.Id);
        }

        /// What needs you first; among equals, the most recent.
        public List<Session> Ordered(IDictionary<string, string> seen)
        {
            return Sessions.OrderBy(s =>
            {
                var phase = s.EffectivePhase;
                if (!IsUnseen(s, seen) && !ActivePhases.Contains(phase)) return 4;
                return phase == "needs-input" ? 0 : phase == "handing-off" ? 1 : phase == "working" ? 3 : 2;
            }).ToList();
        }

        public static bool IsUnseen(Session s, IDictionary<string, string> seen)
        {
            string at;
            if (!FinishedPhases.Contains(s.EffectivePhase)) return false;
            return !seen.TryGetValue(s.Sid, out at) || at != s.UpdatedAtRaw;
        }

        // --- words --------------------------------------------------------------------------------

        public static string ShortName(string who)
        {
            var parts = (who ?? "").Split(new[] { ':' }, 2);
            string baseName;
            switch (parts[0])
            {
                case "claude": baseName = "Claude"; break;
                case "cursor": baseName = "Cursor"; break;
                case "codex": baseName = "Codex"; break;
                case "antigravity": baseName = "Antigravity"; break;
                case "qwen": baseName = "Qwen"; break;
                default: baseName = parts[0]; break;
            }
            return parts.Length > 1 ? baseName + " (" + parts[1] + ")" : baseName;
        }

        public string PhaseLabel(Session s)
        {
            if (IsStale(s)) return ShortName(s.Who) + " quiet";
            switch (s.EffectivePhase)
            {
                case "working": return ShortName(s.Who) + " working";
                case "needs-input": return "Needs your input";
                case "your-turn": return "Your turn";
                case "handing-off": return "Switching agents";
                case "done": return "Done";
                case "paused": return "All agents resting";
                case "stopped": return "Stopped";
                case "ended": return "Closed";
                default: return "Idle";
            }
        }

        public static string SubagentLine(Session s)
        {
            var head = (s.TurnEnded ? "Waiting on " : "Running ") + s.ChildCount + (s.ChildCount == 1 ? " subagent" : " subagents");
            return s.ChildTypes.Length == 0 ? head : head + " - " + s.ChildTypes;
        }

        public static string Countdown(DateTime until, DateTime now)
        {
            var s = Math.Max(0, (int)(until - now).TotalSeconds);
            if (s >= 3600) return (s / 3600) + "h " + (s % 3600 / 60) + "m";
            if (s >= 60) return (s / 60) + "m";
            return s + "s";
        }

        public bool InCooldown(Slot a)
        {
            return a.CooldownUntil.HasValue && a.CooldownUntil.Value > Now;
        }

        public string SlotLine(Slot a)
        {
            if (InCooldown(a)) return "Limit reached - back in " + Countdown(a.CooldownUntil.Value, Now);
            if (a.Usage.Count > 0)
            {
                return string.Join(" - ", a.Usage.Select(u =>
                    ((int)Math.Round(u.UsedPct)).ToString(CultureInfo.InvariantCulture) + "% of " + (u.Weekly ? "week" : u.Label)));
            }
            if (a.SignedIn == "no" && a.DesktopApp) return "Desktop app - terminal signed out";
            if (a.SignedIn == "no") return a.LoginHint.Length == 0 ? "Not signed in" : "Not signed in - " + a.LoginHint;
            if (a.DesktopOnly) return "Desktop app - ready";
            return "Ready";
        }

        // --- the tray icon ------------------------------------------------------------------------

        /// needs-input, handing-off, finished, working or idle: the most urgent thing going on.
        public string TrayState(IDictionary<string, string> seen)
        {
            var live = Live;
            if (live.Any(s => s.EffectivePhase == "needs-input")) return "needs-input";
            if (live.Any(s => s.EffectivePhase == "handing-off")) return "handing-off";
            if (Sessions.Any(s => IsUnseen(s, seen))) return "finished";
            if (live.Count > 0) return "working";
            return "idle";
        }

        public string TrayTooltip(IDictionary<string, string> seen)
        {
            var live = Live;
            var parts = new List<string>();
            var needs = live.Count(s => s.EffectivePhase == "needs-input");
            var moving = live.Count(s => s.EffectivePhase == "handing-off");
            var working = live.Count(s => s.EffectivePhase == "working");
            var finished = Sessions.Count(s => IsUnseen(s, seen));
            if (needs > 0) parts.Add(needs + " need" + (needs == 1 ? "s" : "") + " you");
            if (moving > 0) parts.Add(moving + " switching");
            if (working > 0) parts.Add(working + " working");
            if (finished > 0) parts.Add(finished + " finished");
            if (PausedUntil.HasValue) parts.Add("paused");
            var text = "nowall: " + (parts.Count == 0 ? "all quiet" : string.Join(", ", parts));
            return text.Length > 63 ? text.Substring(0, 63) : text; // the tray's limit
        }

        /// What --dump prints.
        public object ToDump(IDictionary<string, string> seen)
        {
            return new Dictionary<string, object>
            {
                { "tray", new Dictionary<string, object> { { "state", TrayState(seen) }, { "tooltip", TrayTooltip(seen) } } },
                { "paused", PausedUntil.HasValue },
                { "sessions", Ordered(seen).Select(s => new Dictionary<string, object>
                    {
                        { "sid", s.Sid },
                        { "name", s.RepoName },
                        { "phase", s.EffectivePhase },
                        { "label", PhaseLabel(s) },
                        { "who", s.Who },
                        { "detail", s.Detail },
                        { "subagents", s.ChildCount > 0 ? SubagentLine(s) : null },
                        { "tasks", s.TasksTotal > 0 ? s.TasksDone + "/" + s.TasksTotal : null },
                        { "canSwitch", CanSwitch(s) },
                        { "canCancel", IsTakeover(s) },
                    }).ToArray() },
                { "accounts", Slots.Select(a => new Dictionary<string, object>
                    {
                        { "id", a.Id },
                        { "name", a.Name },
                        { "line", SlotLine(a) },
                        { "warns", a.Warns },
                        { "usage", a.Usage.Select(u => new Dictionary<string, object> { { "label", u.Label }, { "pct", u.UsedPct } }).ToArray() },
                    }).ToArray() },
            };
        }
    }

    internal static class Theme
    {
        public static readonly Color Back = Color.FromArgb(20, 20, 20);
        public static readonly Color Edge = Color.FromArgb(58, 58, 58);
        public static readonly Color Text = Color.White;
        public static readonly Color Soft = Color.FromArgb(165, 165, 165);
        public static readonly Color Faint = Color.FromArgb(120, 120, 120);
        public static readonly Color Track = Color.FromArgb(50, 50, 50);
        public static readonly Color ButtonBack = Color.FromArgb(44, 44, 44);
        public static readonly Color Warn = Color.FromArgb(245, 158, 66);
        public static readonly Color Ok = Color.FromArgb(52, 199, 119);
        public static readonly Color Finished = Color.FromArgb(90, 160, 255);

        public static Color Brand(string id)
        {
            switch ((id ?? "").Split(':')[0])
            {
                case "claude": return Color.FromArgb(217, 120, 87);
                case "cursor": return Color.FromArgb(235, 235, 235);
                case "codex": return Color.FromArgb(15, 163, 128);
                case "antigravity": return Color.FromArgb(66, 133, 245);
                default: return Color.FromArgb(125, 77, 255);
            }
        }
    }

    /// A thin bar: one segment for progress and usage, several for "who built what".
    internal sealed class BarControl : Control
    {
        private readonly List<KeyValuePair<double, Color>> segments;

        public BarControl(List<KeyValuePair<double, Color>> segments)
        {
            this.segments = segments;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = Theme.Track;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            double x = 0;
            foreach (var seg in segments)
            {
                var w = Math.Max(0, Math.Min(1, seg.Key)) * Width;
                using (var b = new SolidBrush(seg.Value))
                    e.Graphics.FillRectangle(b, (float)x, 0, (float)w, Height);
                x += w;
            }
        }
    }

    /// The state mark on a session row, or an account's colored circle with its initial.
    internal sealed class GlyphControl : Control
    {
        private readonly string kind;
        private readonly Color color;

        public GlyphControl(string kind, Color color)
        {
            this.kind = kind;
            this.color = color;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = Theme.Back;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var side = Math.Min(Width, Height) - 1f;
            using (var pen = new Pen(color, Math.Max(1.5f, side / 8f)))
            using (var brush = new SolidBrush(color))
            {
                switch (kind)
                {
                    case "working":
                        g.FillEllipse(brush, 0, 0, side, side);
                        break;
                    case "done":
                        pen.StartCap = pen.EndCap = LineCap.Round;
                        g.DrawLines(pen, new[] { new PointF(side * .12f, side * .55f), new PointF(side * .4f, side * .82f), new PointF(side * .9f, side * .2f) });
                        break;
                    case "attention":
                        g.DrawEllipse(pen, 1, 1, side - 2, side - 2);
                        g.FillEllipse(brush, side * .3f, side * .3f, side * .4f, side * .4f);
                        break;
                    default:
                        g.DrawEllipse(pen, 1, 1, side - 2, side - 2);
                        break;
                }
            }
        }
    }

    /// The panel that opens from the tray.
    internal sealed class PanelForm : Form
    {
        private readonly Controller controller;
        private readonly Panel content;
        private readonly float scale;
        private readonly Font bold, normal, small;
        private string shown;

        public PanelForm(Controller controller)
        {
            this.controller = controller;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Theme.Edge;
            Text = "nowall";
            Padding = new Padding(1);
            using (var g = CreateGraphics()) scale = g.DpiX / 96f;
            bold = new Font("Segoe UI Semibold", 9.5f);
            normal = new Font("Segoe UI", 9f);
            small = new Font("Segoe UI", 8f);
            content = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Back, AutoScroll = true };
            Controls.Add(content);
            Deactivate += delegate
            {
                if (!controller.Pinned) Hide();
            };
        }

        protected override bool ShowWithoutActivation { get { return false; } }

        private int S(float v) { return (int)Math.Round(v * scale); }

        private Label AddLabel(string text, Font font, Color color, int x, int y, int w, ContentAlignment align)
        {
            var l = new Label
            {
                Text = text,
                Font = font,
                ForeColor = color,
                BackColor = Theme.Back,
                AutoSize = false,
                AutoEllipsis = true,
                UseMnemonic = false, // a repo called "R&D" keeps its ampersand
                TextAlign = align,
                Location = new Point(x, y),
                Size = new Size(w, font.Height + S(2)),
            };
            content.Controls.Add(l);
            return l;
        }

        private Button AddButton(string text, object tag, int x, int y, bool enabled)
        {
            var size = TextRenderer.MeasureText(text, small);
            var b = new Button
            {
                Text = text,
                Tag = tag,
                Font = small,
                FlatStyle = FlatStyle.Flat,
                ForeColor = enabled ? Theme.Text : Theme.Faint,
                BackColor = Theme.ButtonBack,
                UseMnemonic = false,
                UseCompatibleTextRendering = false,
                Enabled = enabled,
                Cursor = enabled ? Cursors.Hand : Cursors.Default,
                Location = new Point(x, y),
                Size = new Size(size.Width + S(18), S(24)),
                TabStop = false,
            };
            b.FlatAppearance.BorderColor = Theme.Edge;
            b.FlatAppearance.BorderSize = 1;
            content.Controls.Add(b);
            return b;
        }

        private void AddBar(List<KeyValuePair<double, Color>> segments, int x, int y, int w, int h)
        {
            content.Controls.Add(new BarControl(segments) { Location = new Point(x, y), Size = new Size(w, h) });
        }

        private static List<KeyValuePair<double, Color>> OneBar(double value, Color color)
        {
            return new List<KeyValuePair<double, Color>> { new KeyValuePair<double, Color>(value, color) };
        }

        /// A signature of what's on screen, so a one-second tick with nothing new costs no redraw.
        private string Signature(Model m)
        {
            var seen = controller.Seen;
            var sb = new StringBuilder();
            sb.Append(new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(m.ToDump(seen)));
            sb.Append(controller.ToastText).Append(controller.ToastColor.ToArgb());
            sb.Append(controller.Busy);
            foreach (var s in controller.Cancelling) sb.Append(s);
            foreach (var s in m.Sessions)
            {
                foreach (var sh in s.Shares) sb.Append(sh.Agent).Append(sh.Lines);
            }
            if (m.PausedUntil.HasValue) sb.Append(Model.Countdown(m.PausedUntil.Value, m.Now));
            return sb.ToString();
        }

        public void Render(Model m)
        {
            var sig = Signature(m);
            if (sig == shown) return;
            shown = sig;

            var width = S(350);
            var pad = S(14);
            var inner = width - pad * 2;
            var y = S(12);

            content.SuspendLayout();
            var old = content.Controls.Cast<Control>().ToList();
            content.Controls.Clear();
            foreach (var c in old) c.Dispose();

            AddLabel("nowall", bold, Theme.Soft, pad, y, S(70), ContentAlignment.MiddleLeft);
            if (m.PausedUntil.HasValue)
            {
                AddLabel("paused - " + Model.Countdown(m.PausedUntil.Value, m.Now) + " left (nowall resume)", small, Theme.Warn,
                    pad + S(70), y, inner - S(70), ContentAlignment.MiddleRight);
            }
            y += bold.Height + S(8);

            if (!string.IsNullOrEmpty(controller.ToastText))
            {
                AddLabel(controller.ToastText, small, controller.ToastColor, pad, y, inner, ContentAlignment.MiddleLeft);
                y += small.Height + S(8);
            }

            var sessions = m.Ordered(controller.Seen);
            if (sessions.Count == 0)
            {
                AddLabel("All quiet. nowall is watching your agents.", normal, Theme.Soft, pad, y, inner, ContentAlignment.MiddleLeft);
                y += normal.Height + S(8);
            }
            foreach (var s in sessions.Take(6)) y = AddSession(m, s, pad, y, inner);
            if (sessions.Count > 6)
            {
                AddLabel("+" + (sessions.Count - 6) + " more", small, Theme.Faint, pad, y, inner, ContentAlignment.MiddleLeft);
                y += small.Height + S(6);
            }

            content.Controls.Add(new Panel { BackColor = Theme.Edge, Location = new Point(pad, y), Size = new Size(inner, 1) });
            y += S(10);
            if (m.Slots.Count == 0)
            {
                AddLabel("No agents found yet. Run: nowall setup", normal, Theme.Soft, pad, y, inner, ContentAlignment.MiddleLeft);
                y += normal.Height + S(8);
            }
            foreach (var a in m.Slots) y = AddSlot(m, a, pad, y, inner);
            y += S(6);
            content.ResumeLayout();

            Place(width, y);
        }

        private int AddSession(Model m, Session s, int x, int y, int w)
        {
            var color = Theme.Brand(s.Who);
            var phase = s.EffectivePhase;
            var stale = m.IsStale(s);
            var unseen = Model.IsUnseen(s, controller.Seen);
            string kind;
            Color markColor = color;
            if (stale) { kind = "idle"; markColor = Theme.Faint; }
            else if (phase == "needs-input" || phase == "handing-off") { kind = "attention"; markColor = Theme.Warn; }
            else if (phase == "working") kind = "working";
            else if (phase == "done" || phase == "your-turn") { kind = "done"; if (!unseen) markColor = Theme.Faint; }
            else { kind = "idle"; markColor = Theme.Faint; }

            var mark = S(11);
            content.Controls.Add(new GlyphControl(kind, markColor)
            {
                Location = new Point(x, y + (bold.Height - mark) / 2 + S(1)),
                Size = new Size(mark, mark),
            });
            var label = m.PhaseLabel(s);
            var labelWidth = Math.Min(w / 2, TextRenderer.MeasureText(label, small).Width + S(4));
            var nameX = x + mark + S(7);
            AddLabel(s.RepoName, bold, Theme.Text, nameX, y, w - labelWidth - mark - S(9), ContentAlignment.MiddleLeft);
            AddLabel(label, small, stale ? Theme.Faint : (phase == "needs-input" || phase == "handing-off" ? Theme.Warn : color),
                x + w - labelWidth, y, labelWidth, ContentAlignment.MiddleRight);
            y += bold.Height + S(3);

            if (!string.IsNullOrEmpty(s.Detail))
            {
                AddLabel(s.Detail, small, Theme.Soft, nameX, y, w - mark - S(7), ContentAlignment.MiddleLeft);
                y += small.Height + S(3);
            }
            // The hooks often put the same words in the detail: don't say it twice.
            if (s.ChildCount > 0 && !stale && (s.Detail ?? "").IndexOf("subagent", StringComparison.OrdinalIgnoreCase) < 0)
            {
                AddLabel(Model.SubagentLine(s), small, color, nameX, y, w - mark - S(7), ContentAlignment.MiddleLeft);
                y += small.Height + S(3);
            }

            var barWidth = w - mark - S(7);
            var totalLines = s.Shares.Sum(sh => sh.Lines);
            if (totalLines > 0)
            {
                AddBar(s.Shares.Select(sh => new KeyValuePair<double, Color>(sh.Lines / (double)totalLines, Theme.Brand(sh.Agent))).ToList(),
                    nameX, y + S(2), barWidth, S(4));
                y += S(9);
                var legend = string.Join("  ", s.Shares.Select(sh =>
                    Model.ShortName(sh.Agent) + " " + (int)Math.Round(sh.Lines * 100.0 / totalLines) + "%"));
                AddLabel(legend, small, Theme.Soft, nameX, y, barWidth, ContentAlignment.MiddleLeft);
                y += small.Height + S(3);
            }
            if (s.TasksTotal > 0)
            {
                AddBar(OneBar(s.TasksDone / (double)s.TasksTotal, color), nameX, y + S(2), barWidth, S(4));
                y += S(9);
                AddLabel(s.TasksDone + " of " + s.TasksTotal + " tasks done", small, Theme.Soft, nameX, y, barWidth, ContentAlignment.MiddleLeft);
                y += small.Height + S(3);
            }

            var buttonX = nameX;
            if (m.IsTakeover(s))
            {
                var stopping = controller.Cancelling.Contains(s.Sid);
                var sid = s.Sid;
                var b = AddButton(stopping ? "Stopping..." : "Cancel switch", "cancel:" + sid, buttonX, y + S(3), !stopping);
                b.Click += delegate { controller.Cancel(sid); };
                y += b.Height + S(6);
            }
            else if (m.CanSwitch(s))
            {
                var b = AddButton(controller.Busy ? "Switching..." : "Switch...", "switchmenu:" + s.Sid, buttonX, y + S(3), !controller.Busy);
                var menu = controller.SwitchMenu(m, s);
                b.ContextMenuStrip = menu;
                b.Click += delegate { menu.Show(b, new Point(0, b.Height)); };
                y += b.Height + S(6);
            }
            return y + S(8);
        }

        private int AddSlot(Model m, Slot a, int x, int y, int w)
        {
            var color = Theme.Brand(a.Agent);
            var mark = S(11);
            var kind = m.IsWorking(a) ? "working" : "idle";
            content.Controls.Add(new GlyphControl(kind, m.InCooldown(a) || a.Warns ? Theme.Warn : color)
            {
                Location = new Point(x, y + (bold.Height - mark) / 2 + S(1)),
                Size = new Size(mark, mark),
            });
            var textX = x + mark + S(7);
            var showBars = a.Usage.Count > 0 && !m.InCooldown(a);
            var barsWidth = showBars ? S(82) : 0;
            var textWidth = w - mark - S(7) - barsWidth;
            AddLabel(a.Name, bold, Theme.Text, textX, y, textWidth, ContentAlignment.MiddleLeft);
            AddLabel(m.SlotLine(a), small, a.Warns ? Theme.Warn : Theme.Soft, textX, y + bold.Height + S(1), textWidth, ContentAlignment.MiddleLeft);
            if (showBars)
            {
                var rowY = y + S(3);
                foreach (var u in a.Usage)
                {
                    var name = u.Weekly ? "wk" : u.Label;
                    AddLabel(name, small, Theme.Faint, x + w - S(82), rowY - S(4), S(26), ContentAlignment.MiddleRight);
                    AddBar(OneBar(u.UsedPct / 100, u.UsedPct > 85 ? Theme.Warn : color), x + w - S(52), rowY + S(2), S(52), S(4));
                    rowY += S(15);
                }
            }
            var rows = Math.Max(bold.Height + small.Height + S(3), a.Usage.Count * S(15) + S(3));
            return y + rows + S(8);
        }

        /// The corner of the work area where the taskbar's tray is, next to the taskbar.
        private void Place(int width, int contentHeight)
        {
            var screen = Screen.FromPoint(Cursor.Position);
            var area = screen.WorkingArea;
            var gap = S(8);
            var height = Math.Min(contentHeight + 2, area.Height - gap * 2);
            var x = area.Left > screen.Bounds.Left ? area.Left + gap : area.Right - width - gap;
            var y = area.Top > screen.Bounds.Top ? area.Top + gap : area.Bottom - height - gap;
            Bounds = new Rectangle(x, y, width, height);
        }

        public Button FindButton(string tag)
        {
            return content.Controls.OfType<Button>().FirstOrDefault(b => (b.Tag as string) == tag);
        }

        /// A "switch:<sid>:<to>" item from the menu on that session's Switch button.
        public ToolStripItem FindMenuItem(string tag)
        {
            foreach (var b in content.Controls.OfType<Button>())
            {
                if (b.ContextMenuStrip == null) continue;
                foreach (ToolStripItem item in b.ContextMenuStrip.Items)
                {
                    if ((item.Tag as string) == tag) return item;
                }
            }
            return null;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                bold.Dispose();
                normal.Dispose();
                small.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    /// What the panel and the tray menu do. Every action is one run of the nowall CLI.
    internal sealed class Controller
    {
        public readonly string Home;
        public readonly string Node;
        public readonly string Cli;
        public readonly bool Pinned; // test modes: the panel stays up, and the clock can be fixed
        public readonly DateTime? FixedNow;
        public readonly Dictionary<string, string> Seen = new Dictionary<string, string>();
        public readonly HashSet<string> Cancelling = new HashSet<string>();
        public bool Busy;
        public string ToastText;
        public Color ToastColor = Theme.Soft;
        public PanelForm Panel;
        public Model Current;
        public Action<bool, string> ActionFinished;
        private DateTime toastUntil;

        public Controller(string home, string node, string cli, bool pinned, DateTime? fixedNow)
        {
            Home = home;
            Node = node;
            Cli = cli;
            Pinned = pinned;
            FixedNow = fixedNow;
            Panel = new PanelForm(this);
            var forceHandle = Panel.Handle; // BeginInvoke from worker threads needs it
            GC.KeepAlive(forceHandle);
            Reload();
        }

        public void Reload()
        {
            var now = FixedNow ?? DateTime.UtcNow;
            if (ToastText != null && now > toastUntil && FixedNow == null) ToastText = null;
            Current = Model.Read(Home, now);
            if (Panel.Visible) Panel.Render(Current);
        }

        public void Toast(string text, Color color, int seconds)
        {
            ToastText = text;
            ToastColor = color;
            toastUntil = (FixedNow ?? DateTime.UtcNow).AddSeconds(seconds);
            Reload();
        }

        /// Finished chats stop calling for attention once the panel has been opened.
        public void MarkSeen()
        {
            foreach (var s in Current.Sessions)
            {
                if (Model.FinishedPhases.Contains(s.EffectivePhase)) Seen[s.Sid] = s.UpdatedAtRaw;
            }
        }

        public ContextMenuStrip SwitchMenu(Model m, Session s)
        {
            var menu = new ContextMenuStrip();
            var sid = s.Sid;
            var repo = s.RepoName;
            var next = menu.Items.Add("Next account");
            next.Tag = "switch:" + sid + ":next";
            next.Click += delegate { Switch(sid, repo, null); };
            foreach (var t in m.SwitchTargets(s))
            {
                var to = t.Id;
                var item = menu.Items.Add(t.Name);
                item.Tag = "switch:" + sid + ":" + to;
                item.Click += delegate { Switch(sid, repo, to); };
            }
            return menu;
        }

        public void Switch(string sid, string repo, string to)
        {
            if (Busy) { Toast("Already switching...", Theme.Warn, 3); return; }
            Busy = true;
            Toast("Switching " + repo + "...", Theme.Soft, 20);
            var args = new List<string> { "switch", "--sid", sid };
            if (to != null) { args.Add("--to"); args.Add(to); }
            Run(args, (code, stdout, stderr) =>
            {
                Busy = false;
                if (code == 0)
                {
                    var message = FirstLine(stdout) ?? ("Handing off " + repo);
                    Toast(message, Theme.Ok, 5);
                    Finished(true, message);
                }
                else
                {
                    var message = "Switch failed: " + (FirstLine(stderr) ?? FirstLine(stdout) ?? ("exit " + code));
                    Toast(message, Theme.Warn, 6);
                    Finished(false, message);
                }
            });
        }

        public void Cancel(string sid)
        {
            if (Cancelling.Contains(sid)) return;
            Cancelling.Add(sid);
            Toast("Stopping the takeover...", Theme.Soft, 15);
            Run(new List<string> { "cancel", "--sid", sid }, (code, stdout, stderr) =>
            {
                Cancelling.Remove(sid);
                if (code == 0)
                {
                    Toast("Takeover stopped. Its edits are kept", Theme.Ok, 5);
                    Finished(true, FirstLine(stdout) ?? "stopped");
                }
                else
                {
                    var message = (FirstLine(stderr) ?? "Couldn't stop the takeover").Replace("nowall cancel: ", "");
                    Toast(message, Theme.Warn, 6);
                    Finished(false, message);
                }
            });
        }

        public void RefreshAgents()
        {
            if (Node == null || Cli == null) return;
            Run(new List<string> { "agents", "--write" }, (code, stdout, stderr) => Reload());
        }

        private void Finished(bool ok, string message)
        {
            if (ActionFinished != null) ActionFinished(ok, message);
        }

        private static string FirstLine(string text)
        {
            return (text ?? "").Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
        }

        /// Quotes one argument the way Windows programs parse it back. No shell ever sees these.
        public static string Quote(string arg)
        {
            var sb = new StringBuilder("\"");
            var slashes = 0;
            foreach (var c in arg)
            {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') sb.Append('\\', slashes * 2 + 1);
                else sb.Append('\\', slashes);
                slashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', slashes * 2);
            return sb.Append('"').ToString();
        }

        private void Run(List<string> args, Action<int, string, string> done)
        {
            if (Node == null || Cli == null)
            {
                done(127, "", "the tray was started without the nowall CLI. Run: nowall notch");
                return;
            }
            var info = new ProcessStartInfo(Node)
            {
                Arguments = string.Join(" ", new[] { Cli }.Concat(args).Select(Quote)),
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };
            info.EnvironmentVariables["NOWALL_HOME"] = Home;
            var thread = new Thread(() =>
            {
                var code = 1;
                var stdout = "";
                var stderr = "";
                try
                {
                    using (var p = Process.Start(info))
                    {
                        p.StandardInput.Close();
                        var output = new StringBuilder();
                        var err = new StringBuilder();
                        p.OutputDataReceived += (o, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
                        p.ErrorDataReceived += (o, e) => { if (e.Data != null) lock (err) err.AppendLine(e.Data); };
                        p.BeginOutputReadLine();
                        p.BeginErrorReadLine();
                        // `nowall switch` leaves a takeover running that inherits these pipes, so they
                        // stay open long after it exits. Only WaitForExit with a timeout ignores them:
                        // waiting for the end of output would hold the button until the takeover ends.
                        while (!p.WaitForExit(100)) { }
                        Thread.Sleep(150); // what it wrote just before exiting
                        code = p.ExitCode;
                        lock (output) stdout = output.ToString();
                        lock (err) stderr = err.ToString();
                    }
                }
                catch (Exception e)
                {
                    stderr = e.Message;
                }
                try { Panel.BeginInvoke((Action)(() => done(code, stdout, stderr))); }
                catch (InvalidOperationException) { } // quitting
            });
            thread.IsBackground = true;
            thread.Start();
        }
    }

    /// The tray icon and its menu, for as long as the app runs.
    internal sealed class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr handle);

        private readonly Controller controller;
        private readonly NotifyIcon icon;
        private readonly System.Windows.Forms.Timer timer;
        private readonly ToolStripMenuItem switchNow, switchTo, cancelSwitch;
        private string iconState;
        private IntPtr iconHandle = IntPtr.Zero;
        private Dictionary<string, string> lastPhases;
        private DateTime lastAgentRefresh = DateTime.MinValue;
        private DateTime lastClosed = DateTime.MinValue;

        public TrayContext(Controller controller)
        {
            this.controller = controller;
            var menu = new ContextMenuStrip();
            menu.Items.Add("Open", null, delegate { ShowPanel(); });
            switchNow = new ToolStripMenuItem("Switch agent now", null, delegate { SwitchLatest(null); });
            switchTo = new ToolStripMenuItem("Switch to");
            cancelSwitch = new ToolStripMenuItem("Cancel switch", null, delegate { CancelLatest(); });
            menu.Items.Add(switchNow);
            menu.Items.Add(switchTo);
            menu.Items.Add(cancelSwitch);
            menu.Items.Add("Refresh agents", null, delegate { controller.RefreshAgents(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit nowall tray", null, delegate { Application.Exit(); });
            menu.Opening += delegate { UpdateMenu(); };

            icon = new NotifyIcon { ContextMenuStrip = menu, Text = "nowall" };
            icon.MouseClick += (o, e) =>
            {
                if (e.Button == MouseButtons.Left) TogglePanel();
            };
            controller.Panel.Deactivate += delegate { lastClosed = DateTime.UtcNow; };
            Tick();
            icon.Visible = true;

            timer = new System.Windows.Forms.Timer { Interval = 1000 };
            timer.Tick += delegate { Tick(); };
            timer.Start();
            Application.ApplicationExit += delegate
            {
                icon.Visible = false;
                icon.Dispose();
            };
        }

        private void Tick()
        {
            controller.Reload();
            var m = controller.Current;
            UpdateIcon(m);
            icon.Text = m.TrayTooltip(controller.Seen);
            NoticeTransitions(m);
            if (m.Now - lastAgentRefresh > TimeSpan.FromSeconds(60))
            {
                lastAgentRefresh = m.Now;
                controller.RefreshAgents();
            }
        }

        private void UpdateIcon(Model m)
        {
            var state = m.TrayState(controller.Seen);
            if (state == iconState) return;
            iconState = state;
            using (var bmp = DrawIcon(state))
            {
                var handle = bmp.GetHicon();
                icon.Icon = Icon.FromHandle(handle);
                if (iconHandle != IntPtr.Zero) DestroyIcon(iconHandle);
                iconHandle = handle;
            }
        }

        public static Bitmap DrawIcon(string state)
        {
            Color dot;
            switch (state)
            {
                case "needs-input":
                case "handing-off": dot = Theme.Warn; break;
                case "finished": dot = Theme.Finished; break;
                case "working": dot = Theme.Ok; break;
                default: dot = Theme.Faint; break;
            }
            var bmp = new Bitmap(32, 32);
            using (var g = Graphics.FromImage(bmp))
            using (var back = new SolidBrush(Color.FromArgb(24, 24, 24)))
            using (var dotBrush = new SolidBrush(dot))
            using (var white = new SolidBrush(Color.White))
            using (var font = new Font("Segoe UI", 20f, FontStyle.Bold, GraphicsUnit.Pixel))
            using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                // ClearType paints colored fringes, which only make sense on an opaque background.
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                g.Clear(Color.Transparent);
                g.FillEllipse(back, 0, 0, 31, 31);
                g.DrawString("n", font, white, new RectangleF(-3, -3, 32, 32), format);
                g.FillEllipse(dotBrush, 18, 18, 13, 13);
            }
            return bmp;
        }

        /// A balloon when a session starts switching, or finishes a task more than one agent built.
        /// The first look only records what's there.
        private void NoticeTransitions(Model m)
        {
            var phases = new Dictionary<string, string>();
            foreach (var s in m.Sessions) phases[s.Sid] = s.Phase;
            var prev = lastPhases;
            lastPhases = phases;
            if (prev == null) return;
            foreach (var s in m.Sessions)
            {
                string before;
                prev.TryGetValue(s.Sid, out before);
                if (before == s.Phase) continue;
                if (s.Phase == "handing-off")
                {
                    var detail = string.IsNullOrEmpty(s.Detail) ? "handing the task to the next account" : s.Detail;
                    icon.ShowBalloonTip(5000, "nowall is switching agents", s.RepoName + ": " + Model.ShortName(s.Who) + " - " + detail, ToolTipIcon.Warning);
                }
                else if (s.Phase == "done" && s.Shares.Count > 1)
                {
                    var total = Math.Max(1, s.Shares.Sum(x => x.Lines));
                    var parts = s.Shares.Select(x => Model.ShortName(x.Agent) + " " + (int)Math.Round(x.Lines * 100.0 / total) + "%");
                    icon.ShowBalloonTip(5000, s.RepoName + ": done", "Built by " + string.Join(", ", parts), ToolTipIcon.Info);
                }
            }
        }

        private void TogglePanel()
        {
            // A click on the icon first closes an open panel by taking focus: don't reopen it.
            if (DateTime.UtcNow - lastClosed < TimeSpan.FromMilliseconds(250)) return;
            if (controller.Panel.Visible) controller.Panel.Hide();
            else ShowPanel();
        }

        private void ShowPanel()
        {
            controller.Reload();
            controller.Panel.Render(controller.Current);
            controller.Panel.Show();
            controller.Panel.Activate();
            // Looked at: the icon calms down now, and finished rows lose their color on the next open.
            controller.MarkSeen();
            UpdateIcon(controller.Current);
        }

        private void UpdateMenu()
        {
            var m = controller.Current;
            var switchable = m.Live.FirstOrDefault(m.CanSwitch);
            switchNow.Enabled = switchable != null;
            switchTo.Enabled = switchable != null;
            cancelSwitch.Enabled = m.Takeovers.Count > 0;
            switchTo.DropDownItems.Clear();
            if (switchable == null) return;
            foreach (var t in m.SwitchTargets(switchable))
            {
                var to = t.Id;
                switchTo.DropDownItems.Add(t.Name, null, delegate { SwitchLatest(to); });
            }
        }

        private void SwitchLatest(string to)
        {
            var s = controller.Current.Live.FirstOrDefault(controller.Current.CanSwitch);
            if (s == null) { icon.ShowBalloonTip(3000, "nowall", "Nothing is running right now", ToolTipIcon.None); return; }
            controller.Switch(s.Sid, s.RepoName, to);
        }

        private void CancelLatest()
        {
            var s = controller.Current.Takeovers.FirstOrDefault();
            if (s != null) controller.Cancel(s.Sid);
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static string Flag(string[] args, string name)
        {
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        /// Named per home, like the macOS notch's launchd label, so a sandboxed nowall home can never
        /// reach the user's real tray.
        private static string InstanceId(string home)
        {
            using (var sha = SHA1.Create())
            {
                var full = Path.GetFullPath(home).TrimEnd('\\').ToLowerInvariant();
                var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(full));
                return BitConverter.ToString(hash, 0, 4).Replace("-", "").ToLowerInvariant();
            }
        }

        private static bool Running(string mutexName)
        {
            Mutex m;
            try
            {
                if (!Mutex.TryOpenExisting(mutexName, out m)) return false;
                m.Dispose();
                return true;
            }
            catch (UnauthorizedAccessException)
            {
                return true;
            }
        }

        private static int Quit(string mutexName, string quitName)
        {
            EventWaitHandle quit;
            if (EventWaitHandle.TryOpenExisting(quitName, out quit))
            {
                quit.Set();
                quit.Dispose();
            }
            var deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline)
            {
                if (!Running(mutexName)) return 0;
                Thread.Sleep(100);
            }
            // Stuck: end this exact program, and nothing else.
            var me = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(me.ProcessName))
            {
                try
                {
                    if (p.Id != me.Id && p.MainModule.FileName == me.MainModule.FileName) p.Kill();
                }
                catch (Exception)
                {
                    // gone already, or not ours to touch
                }
            }
            Thread.Sleep(300);
            return Running(mutexName) ? 1 : 0;
        }

        private static void ShowForTest(Controller c)
        {
            c.Panel.Render(c.Current);
            c.Panel.Show();
            c.Panel.Render(c.Current);
            c.Panel.Refresh();
            Application.DoEvents();
        }

        private static void SavePanel(Controller c, string path)
        {
            ShowForTest(c);
            using (var bmp = new Bitmap(c.Panel.Width, c.Panel.Height))
            {
                c.Panel.DrawToBitmap(bmp, new Rectangle(0, 0, bmp.Width, bmp.Height));
                bmp.Save(path, ImageFormat.Png);
            }
        }

        private static void SaveDesktop(Controller c, string path)
        {
            ShowForTest(c);
            Thread.Sleep(500);
            Application.DoEvents();
            var bounds = Screen.PrimaryScreen.Bounds;
            using (var bmp = new Bitmap(bounds.Width, bounds.Height))
            using (var g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
                bmp.Save(path, ImageFormat.Png);
            }
        }

        private static string JsonLine(object value)
        {
            return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(value);
        }

        private static int Click(Controller c, string key)
        {
            ShowForTest(c);
            var exit = 1;
            c.ActionFinished = (ok, message) =>
            {
                exit = ok ? 0 : 1;
                Console.Out.WriteLine(JsonLine(new Dictionary<string, object> { { "ok", ok }, { "message", message } }));
                Console.Out.Flush();
                Application.Exit();
            };
            var button = c.Panel.FindButton(key);
            if (button != null && button.Enabled)
            {
                button.PerformClick();
            }
            else
            {
                var item = c.Panel.FindMenuItem(key);
                if (item == null)
                {
                    Console.Out.WriteLine(JsonLine(new Dictionary<string, object> { { "ok", false }, { "message", "no such button: " + key } }));
                    return 2;
                }
                item.PerformClick();
            }
            Application.Run(c.Panel);
            return exit;
        }

        [STAThread]
        private static int Main(string[] args)
        {
            var exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            var home = Path.GetDirectoryName(exeDir);
            var id = InstanceId(home);
            var mutexName = "Local\\nowall-tray-" + id;
            var quitName = "Local\\nowall-tray-quit-" + id;

            if (args.Contains("--running")) return Running(mutexName) ? 0 : 1;
            if (args.Contains("--quit")) return Quit(mutexName, quitName);

            string node = null, cli = null;
            try
            {
                var lines = File.ReadAllLines(Path.Combine(exeDir, "launch.txt"), Encoding.UTF8);
                if (lines.Length >= 2) { node = lines[0].Trim(); cli = lines[1].Trim(); }
            }
            catch (Exception)
            {
                // Without it the panel still reads; actions say what to run.
            }

            DateTime? fixedNow = Model.ParseDate(Flag(args, "--now"));

            if (args.Contains("--dump"))
            {
                var model = Model.Read(home, fixedNow ?? DateTime.UtcNow);
                Console.Out.WriteLine(JsonLine(model.ToDump(new Dictionary<string, string>())));
                Console.Out.Flush();
                return 0;
            }

            var iconShot = Flag(args, "--icon-shot");
            if (iconShot != null)
            {
                var state = Model.Read(home, fixedNow ?? DateTime.UtcNow).TrayState(new Dictionary<string, string>());
                using (var small = TrayContext.DrawIcon(state))
                using (var big = new Bitmap(128, 128))
                using (var g = Graphics.FromImage(big))
                {
                    g.Clear(Color.FromArgb(200, 215, 235));
                    g.InterpolationMode = InterpolationMode.NearestNeighbor;
                    g.DrawImage(small, 0, 0, 128, 128);
                    big.Save(iconShot, ImageFormat.Png);
                }
                return 0;
            }

            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var shot = Flag(args, "--screenshot");
            var desktop = Flag(args, "--desktop-shot");
            var click = Flag(args, "--click");
            if (shot != null || desktop != null || click != null)
            {
                var c = new Controller(home, node, cli, true, fixedNow);
                if (shot != null) SavePanel(c, shot);
                if (desktop != null) SaveDesktop(c, desktop);
                return click != null ? Click(c, click) : 0;
            }

            bool first;
            using (var mutex = new Mutex(true, mutexName, out first))
            {
                if (!first) return 0; // already running for this home
                using (var quit = new EventWaitHandle(false, EventResetMode.ManualReset, quitName))
                {
                    var controller = new Controller(home, node, cli, false, null);
                    var waiter = new Thread(() =>
                    {
                        quit.WaitOne();
                        try { controller.Panel.BeginInvoke((Action)Application.Exit); }
                        catch (InvalidOperationException) { }
                    });
                    waiter.IsBackground = true;
                    waiter.Start();
                    Application.Run(new TrayContext(controller));
                }
                GC.KeepAlive(mutex);
            }
            return 0;
        }
    }
}
