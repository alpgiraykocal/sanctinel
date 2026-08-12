import Foundation

/*
 * Fetches the daily-rebuilt snapshot the GitHub Action publishes.
 *
 * The workflow in .github/workflows/refresh-data.yml rebuilds
 * cache/snapshot.json.gz every night and commits it, so the raw file is the
 * app's data source and no server of ours has to be running for the app to stay
 * current. Requests are conditional on the stored ETag: an unchanged list costs
 * a 304 and no body, which is what makes a daily background check cheap.
 */
public enum SnapshotSource {
    public static let defaultURL = URL(string:
        "https://raw.githubusercontent.com/alpgiraykocal/sanctinel/main/cache/snapshot.json.gz")!
}

public struct SnapshotFetcher: Sendable {
    public enum Outcome: Sendable {
        case notModified
        case updated(data: Data, etag: String)
    }

    public enum Failure: LocalizedError {
        case status(Int)
        case empty
        case offline
        case timedOut
        case transport(String)

        public var errorDescription: String? {
            switch self {
            case .status(let code): return "The list server returned HTTP \(code)."
            case .empty: return "The download was empty."
            case .offline: return "No network connection."
            case .timedOut: return "The download timed out."
            case .transport(let message): return message
            }
        }
    }

    public let url: URL
    private let session: URLSession

    public init(url: URL = SnapshotSource.defaultURL, session: URLSession? = nil) {
        self.url = url
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 60
            config.timeoutIntervalForResource = 600
            config.waitsForConnectivity = true
            // The conditional GET is the cache; a second layer would only serve
            // a stale list back to us.
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    public func fetch(currentETag: String) async throws -> Outcome {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if !currentETag.isEmpty { request.setValue(currentETag, forHTTPHeaderField: "If-None-Match") }

        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost: throw Failure.offline
            case .timedOut: throw Failure.timedOut
            case .cancelled: throw CancellationError()
            default: throw Failure.transport(error.localizedDescription)
            }
        }

        guard let http = response as? HTTPURLResponse else { throw Failure.empty }
        if http.statusCode == 304 { return .notModified }
        guard (200..<300).contains(http.statusCode) else { throw Failure.status(http.statusCode) }
        guard !data.isEmpty else { throw Failure.empty }

        let etag = http.value(forHTTPHeaderField: "ETag") ?? ""
        return .updated(data: data, etag: etag)
    }
}
