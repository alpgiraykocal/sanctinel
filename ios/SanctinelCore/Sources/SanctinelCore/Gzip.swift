import Foundation
import Compression

/*
 * gzip decoding for the downloaded snapshot.
 *
 * The system Compression framework speaks raw DEFLATE (COMPRESSION_ZLIB is
 * RFC 1951, despite the name), so the gzip container's header and trailer are
 * peeled off here and the payload is streamed through it. Streaming rather than
 * one-shot because the snapshot inflates from 5 MB to about 52 MB and a phone
 * should not hold a second copy while guessing at a buffer size.
 */
public enum Gzip {

    public enum Failure: LocalizedError {
        case notGzip
        case unsupported(String)
        case corrupt

        public var errorDescription: String? {
            switch self {
            case .notGzip: return "The downloaded file is not gzip data."
            case .unsupported(let what): return "Unsupported gzip feature: \(what)."
            case .corrupt: return "The downloaded snapshot is corrupt."
            }
        }
    }

    public static func inflate(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count > 18, bytes[0] == 0x1F, bytes[1] == 0x8B else { throw Failure.notGzip }
        guard bytes[2] == 8 else { throw Failure.unsupported("compression method \(bytes[2])") }

        let flags = bytes[3]
        var offset = 10
        if flags & 0x04 != 0 {                       // FEXTRA
            guard offset + 1 < bytes.count else { throw Failure.corrupt }
            let extraLength = Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
            offset += 2 + extraLength
        }
        if flags & 0x08 != 0 { offset = try skipCString(bytes, from: offset) }   // FNAME
        if flags & 0x10 != 0 { offset = try skipCString(bytes, from: offset) }   // FCOMMENT
        if flags & 0x02 != 0 { offset += 2 }                                     // FHCRC
        guard offset < bytes.count - 8 else { throw Failure.corrupt }

        // ISIZE, the trailing uncompressed length mod 2^32 — good enough to size
        // the output buffer for anything under 4 GB.
        let n = bytes.count
        let isize = Int(bytes[n - 4]) | Int(bytes[n - 3]) << 8 | Int(bytes[n - 2]) << 16 | Int(bytes[n - 1]) << 24

        let payload = data.subdata(in: offset..<(n - 8))
        return try rawInflate(payload, expected: isize)
    }

    private static func skipCString(_ bytes: [UInt8], from start: Int) throws -> Int {
        var i = start
        while i < bytes.count, bytes[i] != 0 { i += 1 }
        guard i < bytes.count else { throw Failure.corrupt }
        return i + 1
    }

    private static func rawInflate(_ payload: Data, expected: Int) throws -> Data {
        let bufferSize = 512 * 1024
        var out = Data()
        out.reserveCapacity(max(expected, bufferSize))

        var stream = compression_stream(
            dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!, dst_size: 0,
            src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!, src_size: 0,
            state: nil
        )
        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
                == COMPRESSION_STATUS_OK else { throw Failure.corrupt }
        defer { compression_stream_destroy(&stream) }

        let destination = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { destination.deallocate() }

        var thrown: Error?
        payload.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
                thrown = Failure.corrupt
                return
            }
            stream.src_ptr = base
            stream.src_size = payload.count

            while true {
                stream.dst_ptr = destination
                stream.dst_size = bufferSize
                let status = compression_stream_process(&stream, Int32(COMPRESSION_STREAM_FINALIZE.rawValue))
                let produced = bufferSize - stream.dst_size
                if produced > 0 { out.append(destination, count: produced) }
                if status == COMPRESSION_STATUS_END { return }
                if status == COMPRESSION_STATUS_ERROR { thrown = Failure.corrupt; return }
                if produced == 0 && stream.src_size == 0 { thrown = Failure.corrupt; return }
            }
        }
        if let thrown { throw thrown }
        return out
    }
}
