import Foundation
import AppKit
import CoreGraphics
import Darwin

// Self-test never accesses NSWorkspace, CGEventSource, or notification state.
let selfTest = CommandLine.arguments.dropFirst().elementsEqual(["--self-test"])
if CommandLine.arguments.count > 1 && !selfTest {
    fputs("Unsupported collector arguments\n", stderr)
    exit(64)
}
// Construct the documented any-input sentinel in BOTH modes; this reads no activity.
// A self-test failure here prevents shipping a binary with a latent forced-unwrap crash.
guard let anyInputEventType = CGEventType(rawValue: UInt32.max) else {
    fputs("Collector any-input event constant unavailable\n", stderr)
    exit(70)
}
signal(SIGPIPE, SIG_DFL)
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { exit(0) }
termSource.resume()

// The parent keeps stdin open; EOF closes this process even if no sample is due.
DispatchQueue.global(qos: .utility).async {
    var bytes = [UInt8](repeating: 0, count: 256)
    while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count == 0 { exit(0) }
        if count < 0 && errno != EINTR { exit(0) }
    }
}
var timebase = mach_timebase_info_data_t()
mach_timebase_info(&timebase)
func monotonicMs() -> Double {
    Double(mach_continuous_time()) * Double(timebase.numer) / Double(timebase.denom) / 1_000_000
}
func clean(_ text: String?, limit: Int) -> String? {
    guard let text = text, !text.isEmpty, text.utf16.count <= limit,
          !text.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
    return text
}
var sequence = 0
var previousMonotonic: Double? = nil
var previousWall: Double? = nil
func sample() {
    // AppKit state must be queried on the actual OS main thread, not merely
    // DispatchQueue.main (dispatchMain may park that thread in a CLI process).
    precondition(Thread.isMainThread, "Collector requires the AppKit main run loop")
    let mono = monotonicMs()
    let wall = Date().timeIntervalSince1970 * 1000
    var app: Any = NSNull()
    var idle: Any = NSNull()
    var missing = ["lockState"]
    if selfTest {
        app = ["platform": "macos", "id": "test.synthetic.collector", "name": "Synthetic Collector"]
        idle = 0
    } else {
        if let foreground = NSWorkspace.shared.frontmostApplication,
           let id = clean(foreground.bundleIdentifier, limit: 512),
           let name = clean(foreground.localizedName, limit: 256) {
            app = ["platform": "macos", "id": id, "name": name]
        } else { missing.append("foregroundApp") }
        let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInputEventType)
        if seconds.isFinite && seconds >= 0 { idle = seconds }
        else { missing.append("idleSeconds") }
    }
    var continuityBreak = false
    if let lastMono = previousMonotonic, let lastWall = previousWall {
        let gap = mono - lastMono
        continuityBreak = gap <= 0 || gap > 10_000 || abs((wall - lastWall) - gap) > 2_000
    }
    let payload: [String: Any] = [
        "schemaVersion": 1, "seq": sequence, "observedAtMs": Int64(wall),
        "monotonicMs": mono, "foregroundApp": app, "idleSeconds": idle,
        "sessionState": "unknown", "continuityBreak": continuityBreak, "missing": missing
    ]
    guard var data = try? JSONSerialization.data(withJSONObject: payload), data.count <= 16 * 1024 else {
        fputs("Collector serialization failed\n", stderr); exit(1)
    }
    data.append(10)
    let succeeded = data.withUnsafeBytes { raw -> Bool in
        guard let address = raw.baseAddress else { return false }
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(STDOUT_FILENO, address.advanced(by: offset), raw.count - offset)
            if count < 0 && errno == EINTR { continue }
            if count <= 0 { return false }
            offset += count
        }
        return true
    }
    if !succeeded { exit(0) }
    sequence += 1
    previousMonotonic = mono; previousWall = wall
}
// NSWorkspace updates its cached application state via the main run loop.
// dispatchMain alone services GCD work but not that AppKit lifecycle; in a
// long-running CLI it can leave frontmostApplication frozen at launch.
// Use a nonrepeating run-loop timer so slow samples never cause overlap/catch-up.
func tick() {
    autoreleasepool { sample() }
    let timer = Timer(timeInterval: 5, repeats: false) { _ in tick() }
    RunLoop.main.add(timer, forMode: .common)
}
tick()
RunLoop.main.run()
