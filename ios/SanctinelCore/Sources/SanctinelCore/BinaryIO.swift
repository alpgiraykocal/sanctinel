import Foundation

/*
 * Minimal little-endian binary reader/writer for the on-device snapshot
 * archives.
 *
 * Why a bespoke format rather than JSON: the search corpus is 38k records and
 * 104k names, and re-parsing that from JSON on every cold launch costs seconds
 * before the first query can run. Integers and a shared string table decode
 * roughly an order of magnitude faster, and the CSR posting lists are already
 * flat arrays — they go to disk as-is.
 */

struct BinaryWriter {
    var data = Data()

    mutating func write(_ value: UInt8) { data.append(value) }

    mutating func write(_ value: UInt16) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }

    mutating func write(_ value: UInt32) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }

    mutating func write(_ value: Int32) { write(UInt32(bitPattern: value)) }

    mutating func write(_ value: UInt64) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }

    mutating func write(_ value: Int) { write(UInt64(bitPattern: Int64(value))) }

    mutating func write(bytes: [UInt8]) {
        write(UInt32(bytes.count))
        data.append(contentsOf: bytes)
    }

    mutating func write(magic: String) {
        data.append(contentsOf: Array(magic.utf8))
    }

    mutating func write(int32Array: [Int32]) {
        write(UInt32(int32Array.count))
        int32Array.withUnsafeBufferPointer { buffer in
            buffer.baseAddress.map { data.append(UnsafeRawPointer($0).assumingMemoryBound(to: UInt8.self),
                                                 count: buffer.count * MemoryLayout<Int32>.size) }
        }
    }

    mutating func write(uint8Array: [UInt8]) {
        write(UInt32(uint8Array.count))
        data.append(contentsOf: uint8Array)
    }
}

struct BinaryReader {
    enum Failure: LocalizedError {
        case truncated
        case badMagic
        case badVersion(UInt32)

        var errorDescription: String? {
            switch self {
            case .truncated: return "The stored snapshot is truncated."
            case .badMagic: return "The stored snapshot is not in the expected format."
            case .badVersion(let v): return "The stored snapshot uses format version \(v)."
            }
        }
    }

    private let bytes: [UInt8]
    private var offset = 0

    init(_ data: Data) { bytes = [UInt8](data) }

    mutating func readUInt8() throws -> UInt8 {
        guard offset < bytes.count else { throw Failure.truncated }
        defer { offset += 1 }
        return bytes[offset]
    }

    mutating func readUInt16() throws -> UInt16 {
        guard offset + 2 <= bytes.count else { throw Failure.truncated }
        defer { offset += 2 }
        return UInt16(bytes[offset]) | UInt16(bytes[offset + 1]) << 8
    }

    mutating func readUInt32() throws -> UInt32 {
        guard offset + 4 <= bytes.count else { throw Failure.truncated }
        defer { offset += 4 }
        return UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8
            | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
    }

    mutating func readInt32() throws -> Int32 { Int32(bitPattern: try readUInt32()) }

    mutating func readUInt64() throws -> UInt64 {
        let low = try readUInt32(), high = try readUInt32()
        return UInt64(low) | UInt64(high) << 32
    }

    mutating func readInt() throws -> Int { Int(Int64(bitPattern: try readUInt64())) }

    mutating func readBytes() throws -> [UInt8] {
        let count = Int(try readUInt32())
        guard offset + count <= bytes.count else { throw Failure.truncated }
        defer { offset += count }
        return Array(bytes[offset..<(offset + count)])
    }

    mutating func readString() throws -> String {
        String(decoding: try readBytes(), as: UTF8.self)
    }

    mutating func expect(magic: String) throws {
        let expected = Array(magic.utf8)
        guard offset + expected.count <= bytes.count,
              Array(bytes[offset..<(offset + expected.count)]) == expected else {
            throw Failure.badMagic
        }
        offset += expected.count
    }

    mutating func readInt32Array() throws -> [Int32] {
        let count = Int(try readUInt32())
        let byteCount = count * MemoryLayout<Int32>.size
        guard offset + byteCount <= bytes.count else { throw Failure.truncated }
        var out = [Int32](repeating: 0, count: count)
        out.withUnsafeMutableBytes { destination in
            bytes.withUnsafeBytes { source in
                destination.copyMemory(from: UnsafeRawBufferPointer(rebasing: source[offset..<(offset + byteCount)]))
            }
        }
        offset += byteCount
        return out
    }

    mutating func readUInt8Array() throws -> [UInt8] {
        let count = Int(try readUInt32())
        guard offset + count <= bytes.count else { throw Failure.truncated }
        defer { offset += count }
        return Array(bytes[offset..<(offset + count)])
    }
}

/// Collects distinct strings during encoding so each is written once and
/// referenced by index. Names, alias types, programs and token texts repeat
/// heavily across 38k records — the table is a large part of why the archive is
/// both smaller and faster to load than the JSON it came from.
struct StringTable {
    private(set) var strings: [String] = []
    private var index: [String: UInt32] = [:]

    mutating func id(_ value: String) -> UInt32 {
        if let existing = index[value] { return existing }
        let next = UInt32(strings.count)
        strings.append(value)
        index[value] = next
        return next
    }

    func write(into writer: inout BinaryWriter) {
        writer.write(UInt32(strings.count))
        for s in strings { writer.write(bytes: Array(s.utf8)) }
    }

    static func read(from reader: inout BinaryReader) throws -> [String] {
        let count = Int(try reader.readUInt32())
        var out = [String]()
        out.reserveCapacity(count)
        for _ in 0..<count { out.append(try reader.readString()) }
        return out
    }
}
