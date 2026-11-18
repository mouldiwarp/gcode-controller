// FSEvents on the library folder: each batch of changes is a nudge to rescan. The scan itself
// works out what changed (and ignores the library's own writes), so events carry no detail.

import CoreServices
import Foundation

final class FolderWatcher: @unchecked Sendable {
    let nudges: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let queue = DispatchQueue(label: "gcc.library.fsevents")
    private var ref: FSEventStreamRef?

    init(path: String) {
        (nudges, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        var ctx = FSEventStreamContext(
            version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
        let callback: FSEventStreamCallback = { _, info, count, paths, _, _ in
            guard let info else { return }
            let me = Unmanaged<FolderWatcher>.fromOpaque(info).takeUnretainedValue()
            let list = (unsafeBitCast(paths, to: NSArray.self) as? [String]) ?? []
            // Hidden paths are the library's temporary files and Finder's .DS_Store: not changes.
            let real = list.prefix(count).contains { p in !p.split(separator: "/").contains { $0.hasPrefix(".") } }
            if real || list.isEmpty { me.continuation.yield() }
        }
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagUseCFTypes | kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer)
        ref = FSEventStreamCreate(
            nil, callback, &ctx, [path] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.2, flags)
    }

    func start() {
        guard let ref else { return }
        FSEventStreamSetDispatchQueue(ref, queue)
        FSEventStreamStart(ref)
    }

    func stop() {
        if let ref {
            FSEventStreamStop(ref)
            FSEventStreamInvalidate(ref)
            FSEventStreamRelease(ref)
        }
        ref = nil
        continuation.finish()
    }

    deinit { if ref != nil { stop() } }
}
